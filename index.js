require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { handleHAQuery } = require('./ha-query');
const { handleWithClaude } = require('./claude-handler');
const {
  createNotifyServer,
  handleCallbackQuery,
  handleStatusCommand,
  handlePlanCommand,
  handleStopCommand,
  handleHelpCommand,
} = require('./smartmarstek-notify');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('Warning: ANTHROPIC_API_KEY is not set — Claude fallback disabled');
}

// PID-lock: kill any previous instance on this machine before starting
const PID_FILE = path.join(__dirname, 'bot.pid');
(function acquireLock() {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 'SIGTERM');
        console.log(`Stopped previous bot instance (PID ${oldPid})`);
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

const db = new Database(path.join(__dirname, 'messages.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    username TEXT,
    text TEXT,
    timestamp TEXT NOT NULL
  )
`);

const insert = db.prepare(
  'INSERT INTO messages (chat_id, username, text, timestamp) VALUES (?, ?, ?, ?)'
);

// Per-chat conversation history for Claude (max 20 messages)
const MAX_HISTORY = 20;
const chatHistories = new Map();

function getHistory(chatId) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  return chatHistories.get(chatId);
}

function appendHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

const bot = new TelegramBot(token, { polling: true });

// Start SmartMarstek notify HTTP server (port 3001)
createNotifyServer(bot);

// SmartMarstek inline-button callbacks
bot.on('callback_query', async (query) => {
  try {
    await handleCallbackQuery(bot, query);
  } catch (err) {
    console.error('callback_query error:', err.message);
  }
});

// SmartMarstek commands
bot.onText(/^\/status(@\w+)?$/, (msg) => handleStatusCommand(bot, msg.chat.id));
bot.onText(/^\/plan(@\w+)?$/,   (msg) => handlePlanCommand(bot, msg.chat.id));
bot.onText(/^\/stop(@\w+)?$/,   (msg) => handleStopCommand(bot, msg.chat.id));
bot.onText(/^\/help(@\w+)?$/,   (msg) => handleHelpCommand(bot, msg.chat.id));

bot.on('message', async (msg) => {
  // Skip command messages — handled above
  if (msg.text?.startsWith('/')) return;
  const chat_id = msg.chat.id;
  const username = msg.from?.username || msg.from?.first_name || 'unknown';
  const text = msg.text || '';
  const ts = new Date(msg.date * 1000).toISOString();

  insert.run(chat_id, username, text, ts);
  console.log(JSON.stringify({ chat_id, user: username, text, ts }));

  try {
    const haReply = await handleHAQuery(text);
    if (haReply) {
      await bot.sendMessage(chat_id, haReply);
      return;
    }
  } catch (err) {
    console.error('HA query error:', err.message);
  }

  try {
    const history = getHistory(chat_id);
    const claudeReply = await handleWithClaude(text, history);
    if (claudeReply) {
      appendHistory(chat_id, 'user', text);
      appendHistory(chat_id, 'assistant', claudeReply);
      await bot.sendMessage(chat_id, claudeReply);
    }
  } catch (err) {
    console.error('Claude error:', err.message);
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('Telegram bot started (long-polling)');
