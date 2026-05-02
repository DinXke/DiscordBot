#!/usr/bin/env node
/**
 * Stuur een bericht of embed naar een Discord webhook.
 *
 * Gebruik:
 *   node discord-send.js <channel-key> "<bericht>"
 *   node discord-send.js <channel-key> --embed <embed-json-file>
 *
 * Channel-keys: energie, agents, huisje
 *
 * Vereiste env-variabelen (in .env):
 *   DISCORD_WEBHOOK_ENERGIE
 *   DISCORD_WEBHOOK_AGENTS
 *   DISCORD_WEBHOOK_HUISJE
 */
require('dotenv').config();

const CHANNEL_ENV_MAP = {
  energie: 'DISCORD_WEBHOOK_ENERGIE',
  agents: 'DISCORD_WEBHOOK_AGENTS',
  huisje: 'DISCORD_WEBHOOK_HUISJE',
};

async function sendDiscord(channelKey, payload) {
  const envKey = CHANNEL_ENV_MAP[channelKey];
  if (!envKey) {
    throw new Error(`Onbekende channel-key: ${channelKey}. Gebruik: ${Object.keys(CHANNEL_ENV_MAP).join(', ')}`);
  }

  const webhookUrl = process.env[envKey];
  if (!webhookUrl) {
    throw new Error(`Env-variabele ${envKey} is niet ingesteld. Stel in in .env.`);
  }

  const body = JSON.stringify(payload);

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord webhook mislukt (${res.status}): ${text}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Gebruik: node discord-send.js <channel-key> "<bericht>"');
    console.error('         node discord-send.js <channel-key> --embed <embed-json-file>');
    process.exit(1);
  }

  const [channelKey, ...rest] = args;

  let payload;
  if (rest[0] === '--embed') {
    const fs = require('fs');
    const embedFile = rest[1];
    if (!embedFile || !fs.existsSync(embedFile)) {
      console.error(`Embed-bestand niet gevonden: ${embedFile}`);
      process.exit(1);
    }
    const embed = JSON.parse(fs.readFileSync(embedFile, 'utf8'));
    payload = { embeds: Array.isArray(embed) ? embed : [embed] };
  } else {
    payload = { content: rest.join(' ') };
  }

  await sendDiscord(channelKey, payload);
  console.log(JSON.stringify({ success: true, channel: channelKey }));
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fout:', err.message);
    process.exit(1);
  });
}

module.exports = { sendDiscord };
