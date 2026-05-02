require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const [, , chatId, ...textParts] = process.argv;
const text = textParts.join(' ');

if (!chatId || !text) {
  console.error('Usage: node send-message.js <chat_id> <text>');
  process.exit(1);
}

const bot = new TelegramBot(token);

bot.sendMessage(chatId, text)
  .then(() => {
    console.log(`Message sent to ${chatId}: "${text}"`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Failed to send message:', err.message);
    process.exit(1);
  });
