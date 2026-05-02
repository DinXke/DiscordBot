#!/usr/bin/env node
// Send an outbound Telegram message from PersonalAssistant and set the active context
// for that chat so inbound replies route back to the correct Paperclip issue.
//
// Usage: node pa-send-message.js <chat_id> <issue_id> <text...>
// Example: node pa-send-message.js 123456789 SCH-42 "Hier zijn je e-mails voor vandaag."

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const path = require('path');

const [,, chatIdArg, issueIdArg, ...textParts] = process.argv;
const text = textParts.join(' ');

if (!chatIdArg || !issueIdArg || !text) {
  console.error('Usage: node pa-send-message.js <chat_id> <issue_id> <text>');
  process.exit(1);
}

const chatId = parseInt(chatIdArg, 10);
if (isNaN(chatId)) {
  console.error(`Invalid chat_id: ${chatIdArg}`);
  process.exit(1);
}

const token = process.env.PA_TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: PA_TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const DB_FILE = path.join(__dirname, 'pa-messages.db');
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
const insertMessage = db.prepare(
  'INSERT INTO pa_messages (chat_id, direction, text, issue_id, timestamp) VALUES (?, ?, ?, ?, ?)'
);

const bot = new TelegramBot(token);

(async () => {
  try {
    await bot.sendMessage(chatId, text);
    const ts = new Date().toISOString();
    upsertContext.run(chatId, issueIdArg, ts);
    insertMessage.run(chatId, 'out', text, issueIdArg, ts);
    console.log(JSON.stringify({ sent: true, chat_id: chatId, issue_id: issueIdArg }));
    process.exit(0);
  } catch (err) {
    console.error('Failed to send message:', err.message);
    process.exit(1);
  }
})();
