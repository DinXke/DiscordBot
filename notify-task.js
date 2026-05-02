#!/usr/bin/env node
/**
 * Send a task-completion notification to Björn on Telegram.
 *
 * Usage:
 *   node notify-task.js --agent "AgentName" --task "SCH-42" \
 *     --title "Do something" --outcome "Done" [--company-prefix SCH]
 *
 * Or via stdin JSON (used by the Paperclip routine webhook handler):
 *   echo '{"agentName":"X","taskId":"SCH-42","taskTitle":"...","outcome":"..."}' | node notify-task.js
 */
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const BJORN_CHAT_ID = 896640302;
const PAPERCLIP_URL = process.env.PAPERCLIP_API_URL || 'http://localhost:3100';

function buildMessage({ agentName, taskId, taskTitle, outcome, companyPrefix }) {
  const prefix = companyPrefix || (taskId ? taskId.split('-')[0] : 'SCH');
  const deepLink = `${PAPERCLIP_URL}/${prefix}/issues/${taskId}`;
  return [
    `✅ *Taak voltooid*`,
    ``,
    `*Agent:* ${agentName}`,
    `*Taak:* [${taskId}](${deepLink}) — ${taskTitle}`,
    `*Resultaat:* ${outcome}`,
  ].join('\n');
}

async function send(payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }
  const bot = new TelegramBot(token);
  const text = buildMessage(payload);
  await bot.sendMessage(BJORN_CHAT_ID, text, { parse_mode: 'Markdown' });
  console.log(`Notification sent to chat ${BJORN_CHAT_ID}`);
}

async function main() {
  let payload;

  const args = process.argv.slice(2);
  if (args.includes('--agent')) {
    // Parse CLI args: --agent --task --title --outcome [--company-prefix]
    const get = (flag) => {
      const i = args.indexOf(flag);
      return i !== -1 ? args[i + 1] : null;
    };
    payload = {
      agentName: get('--agent'),
      taskId: get('--task'),
      taskTitle: get('--title'),
      outcome: get('--outcome'),
      companyPrefix: get('--company-prefix'),
    };
  } else {
    // Read JSON from stdin
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString());
  }

  if (!payload.agentName || !payload.taskId || !payload.taskTitle || !payload.outcome) {
    console.error('Required fields: agentName, taskId, taskTitle, outcome');
    process.exit(1);
  }

  await send(payload);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
