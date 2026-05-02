require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const token = process.env.PA_TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: PA_TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const DB_FILE = path.join(__dirname, 'pa-messages.db');
const PID_FILE = path.join(__dirname, 'pa-bot.pid');

(function acquireLock() {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 'SIGTERM');
        console.log(`Stopped previous PA bot instance (PID ${oldPid})`);
      } catch { /* already gone */ }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
})();

function releaseLock() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
process.on('SIGINT',  () => { releaseLock(); process.exit(0); });

const db = new Database(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS pa_contexts (
    chat_id INTEGER PRIMARY KEY,
    issue_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pa_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    text TEXT,
    issue_id TEXT,
    timestamp TEXT NOT NULL
  );
`);

const upsertContext = db.prepare(`
  INSERT INTO pa_contexts (chat_id, issue_id, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET issue_id = excluded.issue_id, updated_at = excluded.updated_at
`);
const getContext = db.prepare('SELECT issue_id FROM pa_contexts WHERE chat_id = ?');
const insertMessage = db.prepare(
  'INSERT INTO pa_messages (chat_id, direction, text, issue_id, timestamp) VALUES (?, ?, ?, ?, ?)'
);

function paperclipRequest(method, urlPath, body) {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) throw new Error('Paperclip not configured');

  const url = new URL(urlPath, apiUrl);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = lib.request(url.toString(), {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Paperclip request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function postPaperclipComment(issueId, body) {
  return paperclipRequest('POST', `/api/issues/${issueId}/comments`, { body });
}

// Expose context upsert for pa-send-message.js (via shared DB)
// pa-send-message.js writes to pa_contexts; this bot reads from it on each inbound message.

const bot = new TelegramBot(token, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from?.username || msg.from?.first_name || 'unknown';
  const text = msg.text || '';
  const ts = new Date(msg.date * 1000).toISOString();

  console.log(JSON.stringify({ direction: 'in', chat_id: chatId, user: username, text, ts }));

  const ctx = getContext.get(chatId);
  if (!ctx) {
    console.warn(`No active issue context for chat ${chatId} — message not routed to Paperclip`);
    insertMessage.run(chatId, 'in', text, null, ts);
    return;
  }

  const issueId = ctx.issue_id;
  insertMessage.run(chatId, 'in', text, issueId, ts);

  // All commands (1 unsub, 2 keep, all keep, freetext) are passed through as-is.
  const commentBody = `**Björn via Telegram:** ${text}`;
  try {
    await postPaperclipComment(issueId, commentBody);
    console.log(JSON.stringify({ routed: true, issue_id: issueId }));
  } catch (err) {
    // Graceful degrade: Paperclip unavailable does not affect bot availability.
    console.error(`Failed to post comment to ${issueId}: ${err.message}`);
  }
});

bot.on('polling_error', (err) => {
  console.error('PA bot polling error:', err.message);
});

console.log('PersonalAssistant Telegram bot started (long-polling)');
