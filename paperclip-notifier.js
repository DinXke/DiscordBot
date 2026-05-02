const Database = require('better-sqlite3');
const path = require('path');

const UPDATES_CHANNEL = '1500233747126288413';
const ALERTS_CHANNEL = '1500233748401229914';

const POLL_INTERVAL_MS = 30_000;

const STATUS_EMOJI = {
  todo: '📋', in_progress: '🔄', in_review: '👀',
  blocked: '🚫', done: '✅', cancelled: '❌', backlog: '📦',
};
const PRIORITY_EMOJI = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
const ALERT_STATUSES = new Set(['blocked', 'cancelled']);

function initDb() {
  const db = new Database(path.join(__dirname, 'notifier.db'), { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_comments (
      comment_id TEXT PRIMARY KEY,
      notified_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issue_states (
      issue_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function paperclipGet(url) {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  const fullUrl = url.replace('{companyId}', companyId);

  return fetch(`${apiUrl}${fullUrl}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }).then(r => r.json());
}

async function sendDiscord(client, channelId, payload) {
  const ch = client.channels.cache.get(channelId);
  if (!ch) return;
  await ch.send(payload);
}

function buildCommentEmbed(issue, comment, authorName) {
  const { EmbedBuilder } = require('discord.js');
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`💬 Nieuwe reactie op [${issue.identifier}] ${issue.title}`.slice(0, 256))
    .setDescription(comment.body.slice(0, 4000))
    .addFields(
      { name: 'Door', value: authorName || 'Onbekend', inline: true },
      { name: 'Status', value: `${STATUS_EMOJI[issue.status] || ''} ${issue.status}`, inline: true },
    )
    .setTimestamp(new Date(comment.createdAt || Date.now()));
}

function buildStatusEmbed(issue, oldStatus) {
  const { EmbedBuilder } = require('discord.js');
  const isAlert = ALERT_STATUSES.has(issue.status);
  return new EmbedBuilder()
    .setColor(issue.status === 'done' ? 0x57f287 : issue.status === 'blocked' ? 0xed4245 : 0xfee75c)
    .setTitle(`${STATUS_EMOJI[issue.status] || ''} Status gewijzigd: [${issue.identifier}] ${issue.title}`.slice(0, 256))
    .addFields(
      { name: 'Van', value: `${STATUS_EMOJI[oldStatus] || ''} ${oldStatus}`, inline: true },
      { name: 'Naar', value: `${STATUS_EMOJI[issue.status] || ''} ${issue.status}`, inline: true },
      { name: 'Prioriteit', value: `${PRIORITY_EMOJI[issue.priority] || ''} ${issue.priority || '-'}`, inline: true },
    )
    .setTimestamp(new Date());
}

async function pollOnce(client, db) {
  const companyId = process.env.PAPERCLIP_COMPANY_ID;

  const issues = await paperclipGet(
    `/api/companies/{companyId}/issues?status=todo,in_progress,in_review,blocked,done&limit=50`
  ).catch(() => null);

  if (!Array.isArray(issues)) return;

  const seenComment = db.prepare('SELECT 1 FROM seen_comments WHERE comment_id = ?');
  const insertComment = db.prepare('INSERT OR IGNORE INTO seen_comments (comment_id, notified_at) VALUES (?, ?)');
  const getState = db.prepare('SELECT status FROM issue_states WHERE issue_id = ?');
  const upsertState = db.prepare(`
    INSERT INTO issue_states (issue_id, status, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(issue_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
  `);

  for (const issue of issues) {
    // Track status changes
    const prev = getState.get(issue.id);
    if (prev && prev.status !== issue.status) {
      const embed = buildStatusEmbed(issue, prev.status);
      const channel = ALERT_STATUSES.has(issue.status) ? ALERTS_CHANNEL : UPDATES_CHANNEL;
      await sendDiscord(client, channel, { embeds: [embed] }).catch(console.error);
    }
    upsertState.run(issue.id, issue.status, Date.now());

    // Check new comments
    const comments = await paperclipGet(`/api/issues/${issue.id}/comments`).catch(() => null);
    if (!Array.isArray(comments)) continue;

    for (const comment of comments) {
      if (!comment.id || seenComment.get(comment.id)) continue;
      insertComment.run(comment.id, Date.now());

      // Skip system/auto messages
      if (comment.body?.startsWith('Paperclip automatically')) continue;

      const authorName = comment.authorAgent?.name || comment.authorUser?.name || 'Board';
      const embed = buildCommentEmbed(issue, comment, authorName);
      await sendDiscord(client, UPDATES_CHANNEL, { embeds: [embed] }).catch(console.error);
    }
  }
}

function startNotifier(client) {
  const db = initDb();

  // Seed existing comments/states without notifying (first run)
  let seeded = false;

  async function seed() {
    const companyId = process.env.PAPERCLIP_COMPANY_ID;
    const issues = await paperclipGet(
      `/api/companies/{companyId}/issues?status=todo,in_progress,in_review,blocked,done&limit=50`
    ).catch(() => null);
    if (!Array.isArray(issues)) return;

    const insertComment = db.prepare('INSERT OR IGNORE INTO seen_comments (comment_id, notified_at) VALUES (?, ?)');
    const upsertState = db.prepare(`
      INSERT INTO issue_states (issue_id, status, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    `);

    for (const issue of issues) {
      upsertState.run(issue.id, issue.status, Date.now());
      const comments = await paperclipGet(`/api/issues/${issue.id}/comments`).catch(() => null);
      if (!Array.isArray(comments)) continue;
      for (const c of comments) {
        if (c.id) insertComment.run(c.id, Date.now());
      }
    }
    console.log('Notifier: bestaande issues en comments geseeded');
    seeded = true;
  }

  seed().then(() => {
    setInterval(() => {
      if (!seeded) return;
      pollOnce(client, db).catch(err => console.error('Notifier error:', err.message));
    }, POLL_INTERVAL_MS);
    console.log(`Notifier gestart — poll elke ${POLL_INTERVAL_MS / 1000}s`);
  });
}

module.exports = { startNotifier };
