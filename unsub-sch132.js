/**
 * SCH-132: Unsubscribe from Catawiki, New York Times, Dominos, Patrick Adair Designs
 */

const { callTool } = require('./m365-client');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const SENDERS = [
  { name: 'Catawiki',               email: 'info@mailing.catawiki.com' },
  { name: 'New York Times (direct)',email: 'nytdirect@nytimes.com' },
  { name: 'New York Times (breaking news)', email: 'breakingnews@nytimes.com' },
  { name: 'New York Times (e)',     email: 'nytimes@e.newyorktimes.com' },
  { name: 'Dominos',               email: 'info@vip.dominos.be' },
  { name: 'Patrick Adair Designs', email: 'info@patrickadairdesigns.com' },
];

function decodeMimeHeader(str) {
  return str.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=\s*/g, (match, charset, encoding, encoded) => {
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
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 200) }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function getMessageHeaders(sender) {
  const result = await callTool('list-mail-messages', {
    search: `"from:${sender.email}"`,
    top: 1,
    select: 'id,subject,from,receivedDateTime',
  });
  const msgs = result?.value || [];
  if (msgs.length === 0) return { found: false };
  const msgId = msgs[0].id;
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
  console.error(`  LU: mailto=${mailto ? 'yes' : 'no'}, https=${httpsUrl ? httpsUrl.slice(0, 60) + '...' : 'no'}, post=${rawPost || 'none'}`);

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
      if (!mailto) return { status: 'failed', method: 'one-click-post', url: httpsUrl, detail: e.message };
    }
  }

  if (mailto) {
    try {
      const url = new URL(mailto);
      const to = url.pathname;
      const subject = url.searchParams.get('subject') || 'Unsubscribe';
      const body = url.searchParams.get('body') || '';
      await callTool('send-mail', {
        body: {
          Message: {
            subject: decodeURIComponent(subject),
            body: { contentType: 'text', content: decodeURIComponent(body) },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          SaveToSentItems: true,
        },
      });
      return { status: 'done', method: 'mailto', to, subject: decodeURIComponent(subject), detail: 'Unsub e-mail verstuurd' };
    } catch (e) {
      return { status: 'failed', method: 'mailto', detail: e.message };
    }
  }

  if (httpsUrl) {
    return { status: 'manual', method: 'https', url: httpsUrl, detail: 'Geen List-Unsubscribe-Post header — handmatig bezoeken vereist' };
  }

  return { status: 'no_header', detail: `Konden geen URL extraheren uit: ${rawUnsub.slice(0, 200)}` };
}

async function main() {
  console.error('SCH-132 unsubscribe execution starting...');
  const results = [];

  for (const sender of SENDERS) {
    console.error(`\nProcessing: ${sender.name} <${sender.email}>`);
    let entry = { sender: sender.name, email: sender.email };
    try {
      const { found, msg, headers } = await getMessageHeaders(sender);
      if (!found) {
        entry.result = { status: 'not_found', detail: 'Geen e-mail gevonden in mailbox' };
      } else {
        entry.lastEmail = msg.subject;
        entry.received = msg.received;
        entry.result = await executeUnsub(sender, headers);
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
