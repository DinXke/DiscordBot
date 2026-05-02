/**
 * Execute List-Unsubscribe for 8 approved senders.
 * Strategy:
 *  1. Find most recent email from each sender via list-mail-messages
 *  2. Fetch full message with internetMessageHeaders
 *  3. Parse List-Unsubscribe header
 *  4. Execute: mailto → send-mail, https + List-Unsubscribe-Post → HTTP POST, https only → note
 */

const { callTool } = require('./m365-client');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const SENDERS = [
  { name: 'Patrick Adair Designs', email: 'info@patrickadairdesigns.com' },
  { name: 'Built Different',       email: 'team@built-different.co' },
  { name: 'Edureka / Birchwood',   email: 'neha@edureka.co' },
  { name: 'Just Russel',           email: 'hello@justrussel.com' },
  { name: 'Catawiki',              email: 'info@mailing.catawiki.com' },
  { name: 'HBM Machines',          email: 'info@hbm-machines.com' },
  { name: 'New York Times',        email: 'breakingnews@nytimes.com' },
  { name: 'Udemy',                 email: 'hello@students.udemy.com' },
];

function decodeMimeHeader(str) {
  // Decode MIME encoded-words (=?charset?Q/B?...?=), stripping whitespace between adjacent words
  return str
    .replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=\s*/g, (match, charset, encoding, encoded) => {
      if (encoding.toUpperCase() === 'Q') {
        return encoded.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
      return Buffer.from(encoded, 'base64').toString('utf8');
    });
}

function parseUnsubscribeHeader(headerValue) {
  if (!headerValue) return { mailto: null, https: null };
  const decoded = decodeMimeHeader(headerValue);
  const parts = decoded.split(/,\s*(?=<)/);
  let mailto = null;
  let httpsUrl = null;
  for (const part of parts) {
    const m = part.match(/<([^>]+)>/);
    if (!m) continue;
    const val = m[1].trim();
    if (val.startsWith('mailto:')) mailto = val;
    else if (val.startsWith('http://') || val.startsWith('https://')) httpsUrl = val;
  }
  return { mailto, https: httpsUrl };
}

function httpPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(body || 'List-Unsubscribe=One-Click');
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': data.length,
        'User-Agent': 'Mozilla/5.0 (compatible; UnsubscribeBot/1.0)',
      },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UnsubscribeBot/1.0)',
      },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      // Follow redirects (simplified)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpGet(res.headers.location));
        return;
      }
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getMessageHeaders(sender) {
  // Search for most recent email from this sender using KQL (can't combine filter + search)
  const result = await callTool('list-mail-messages', {
    search: `"from:${sender.email}"`,
    top: 1,
    select: 'id,subject,from,receivedDateTime',
  });
  const msgs = result?.value || [];
  if (msgs.length === 0) {
    return { found: false, msg: null, headers: null };
  }
  const msgId = msgs[0].id;
  // Get full message with internetMessageHeaders
  const full = await callTool('get-mail-message', {
    messageId: msgId,
    select: 'id,subject,from,receivedDateTime,internetMessageHeaders',
  });
  const headers = full?.internetMessageHeaders || [];
  const headerMap = {};
  for (const h of headers) {
    headerMap[h.name.toLowerCase()] = h.value;
  }
  return {
    found: true,
    msg: { id: msgId, subject: msgs[0].subject, received: msgs[0].receivedDateTime },
    headers: headerMap,
  };
}

async function executeUnsub(sender, headerMap) {
  const rawUnsub = headerMap['list-unsubscribe'];
  const rawPost = headerMap['list-unsubscribe-post'];

  if (!rawUnsub) {
    return { status: 'no_header', detail: 'Geen List-Unsubscribe header gevonden' };
  }

  const { mailto, https: httpsUrl } = parseUnsubscribeHeader(rawUnsub);

  // Prefer one-click POST (RFC 8058)
  if (httpsUrl && rawPost && rawPost.toLowerCase().includes('one-click')) {
    try {
      const res = await httpPost(httpsUrl, 'List-Unsubscribe=One-Click');
      const ok = res.status >= 200 && res.status < 400;
      return {
        status: ok ? 'done' : 'failed',
        method: 'one-click-post',
        url: httpsUrl,
        httpStatus: res.status,
        detail: ok ? `HTTP POST ${res.status} OK` : `HTTP POST mislukt (${res.status})`,
      };
    } catch (e) {
      // Fall through to mailto
      if (!mailto) return { status: 'failed', method: 'one-click-post', url: httpsUrl, detail: e.message };
    }
  }

  // mailto: unsubscribe
  if (mailto) {
    try {
      const url = new URL(mailto);
      const to = url.pathname;
      const subject = url.searchParams.get('subject') || 'Unsubscribe';
      const body = url.searchParams.get('body') || '';
      await callTool('send-mail', {
        body: {
          Message: {
            subject,
            body: { contentType: 'text', content: body },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          SaveToSentItems: true,
        },
      });
      return { status: 'done', method: 'mailto', to, subject, detail: 'Unsub e-mail verstuurd' };
    } catch (e) {
      return { status: 'failed', method: 'mailto', detail: e.message };
    }
  }

  // https only — no one-click post header
  if (httpsUrl) {
    return {
      status: 'manual',
      method: 'https',
      url: httpsUrl,
      detail: 'Geen List-Unsubscribe-Post header — handmatig bezoeken vereist',
    };
  }

  const decoded = decodeMimeHeader(rawUnsub);
  const { mailto: mto2, https: hurl2 } = parseUnsubscribeHeader(decoded);
  if (hurl2) return { status: 'manual', method: 'https', url: hurl2, detail: 'Handmatig bezoeken (header was MIME-encoded)' };
  if (mto2) {
    // already called above but header was MIME — shouldn't reach here normally
  }
  return { status: 'no_header', detail: `Ongeparseerde header: ${rawUnsub.slice(0, 200)}` };
}

async function main() {
  console.error('Starting unsubscribe execution...');
  const results = [];

  for (const sender of SENDERS) {
    console.error(`Processing: ${sender.name} <${sender.email}>`);
    let entry = { sender: sender.name, email: sender.email };
    try {
      const { found, msg, headers } = await getMessageHeaders(sender);
      if (!found) {
        entry.result = { status: 'not_found', detail: 'Geen e-mail gevonden in mailbox' };
      } else {
        entry.lastEmail = msg.subject;
        entry.received = msg.received;
        const unsubResult = await executeUnsub(sender, headers);
        entry.result = unsubResult;
        // Small delay between sends
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      entry.result = { status: 'error', detail: e.message };
    }
    results.push(entry);
    console.error(`  => ${entry.result.status}: ${entry.result.detail || ''}`);
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
