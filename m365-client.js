/**
 * Long-lived ms-365-mcp-server subprocess client.
 * Communicates via JSON-RPC over stdio.
 */
const { spawn } = require('child_process');

let proc = null;
let buffer = '';
const pending = new Map();
let nextId = 1;
let readyPromise = null;

function spawnServer() {
  proc = spawn('npx', ['-y', '@softeria/ms-365-mcp-server', '--preset', 'personal'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  proc.stderr.on('data', () => {});
  proc.on('close', () => {
    // Immediately reject all pending requests so callers don't wait 30s
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('M365 server process closed unexpectedly'));
    }
    pending.clear();
    proc = null;
    buffer = '';
    readyPromise = null;
  });
}

function sendRaw(msg) {
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject });
    const timer = setTimeout(() => {
      if (pending.has(msg.id)) {
        pending.delete(msg.id);
        reject(new Error(`M365 request ${msg.id} timed out`));
      }
    }, 30000);
    pending.get(msg.id).timer = timer;
    proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}

function ensure() {
  if (readyPromise) return readyPromise;
  spawnServer();
  readyPromise = sendRaw({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'telegram-bot', version: '1' },
    },
  }).then(() => {
    proc.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  });
  return readyPromise;
}

async function callTool(toolName, args) {
  await ensure();
  const id = nextId++;
  const result = await sendRaw({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args } });
  const content = result?.content;
  if (Array.isArray(content) && content[0]?.type === 'text') {
    const text = content[0].text;
    if (result.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  }
  return result;
}

module.exports = { callTool };
