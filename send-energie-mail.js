#!/usr/bin/env node
/**
 * Stuur de energie nieuwsbrief via M365 (paperclip@scheepers.one).
 * Post daarnaast ook een embed in #energie-advies op Discord (niet-blokkerend).
 *
 * Gebruik:
 *   node send-energie-mail.js <to> <subject> <html-file>
 *
 * Voorbeeld:
 *   node send-energie-mail.js "bjorn@scheepers.one,anja.m@skynet.be" \
 *     "⚡ Stroomadvies 25-04-2026" /tmp/energie_nieuwsbrief.html
 */
require('dotenv').config();
const { callTool } = require('./m365-client');
const { sendDiscord } = require('./discord-send');
const { buildEnergieEmbed } = require('./discord-energie-embed');
const fs = require('fs');
const path = require('path');

function detectAdviesType(subject) {
  const s = subject.toLowerCase();
  if (s.includes('rood') || s.includes('hoog') || s.includes('piek')) return 'rood';
  if (s.includes('oranje') || s.includes('matig')) return 'oranje';
  return 'groen';
}

async function postDiscord(subject) {
  try {
    const adviesType = detectAdviesType(subject);
    const embed = buildEnergieEmbed({
      titel: subject,
      omschrijving: 'Nieuw energie-advies verstuurd. Zie je e-mail voor details.',
      adviesType,
    });
    await sendDiscord('energie', { embeds: [embed] });
    console.log(JSON.stringify({ discord: true, channel: 'energie' }));
  } catch (err) {
    console.error('Discord-post mislukt (mail gaat door):', err.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Gebruik: node send-energie-mail.js <to> <subject> <html-file>');
    process.exit(1);
  }

  const [toArg, subject, htmlFile] = args;

  if (!fs.existsSync(htmlFile)) {
    console.error(`HTML-bestand niet gevonden: ${htmlFile}`);
    process.exit(1);
  }

  const htmlContent = fs.readFileSync(htmlFile, 'utf8');
  const recipients = toArg.split(',').map(s => s.trim()).filter(Boolean);

  // Discord-post parallel aan de mail-flow (niet-blokkerend)
  const discordPromise = postDiscord(subject);

  let sentCount = 0;
  const errors = [];

  for (const to of recipients) {
    try {
      const result = await callTool('send-mail', {
        body: {
          Message: {
            subject,
            body: {
              contentType: 'html',
              content: htmlContent,
            },
            toRecipients: [{ emailAddress: { address: to } }],
            from: { emailAddress: { address: 'paperclip@scheepers.one', name: 'EnergieAdviseur' } },
          },
          SaveToSentItems: true,
        },
      });
      console.log(JSON.stringify({ success: true, to, subject }));
      sentCount++;
    } catch (err) {
      const msg = `Fout bij versturen naar ${to}: ${err.message}`;
      console.error(msg);
      errors.push(msg);
    }
  }

  await discordPromise;

  if (errors.length > 0 && sentCount === 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Onverwachte fout:', err.message);
  process.exit(1);
});
