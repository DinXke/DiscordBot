'use strict';

const http = require('http');

const SMARTMARSTEK_URL = process.env.SMARTMARSTEK_URL || 'http://localhost:5000';

function formatPrice(p) {
  if (p == null) return '?';
  return `€${p.toFixed(3)}/kWh`;
}

function buildText(event_type, payload) {
  switch (event_type) {
    case 'plan_ready':
      return `📋 *Energieplan gereed*\n\nHet nieuwe plan is berekend en actief.\n_Gebruik /plan voor details._`;

    case 'grid_charge_opportunity': {
      const price = formatPrice(payload.price_eur_kwh);
      const soc   = payload.soc != null ? `${payload.soc}%` : '?';
      const kwh   = payload.recommended_kwh ?? 3;
      return `⚡ *Laadkans via net*\n\nStroomprijs: ${price}\nAccu: ${soc}\nAdvies: ${kwh} kWh\n\nWil je nu via het net laden?`;
    }

    case 'negative_price_detected':
      return `💰 *Negatieve stroomprijs!*\n\nPrijs: ${formatPrice(payload.price_eur_kwh)}\nZet extra verbruikers aan!`;

    case 'esphome_failed':
      return `🚨 *ESPHome verbinding verbroken*\n\n${payload.device || 'Apparaat onbekend'}\nControleer de verbinding.`;

    case 'daily_summary': {
      const lines = [];
      if (payload.soc_pct != null)        lines.push(`Accu: ${payload.soc_pct}%`);
      if (payload.solar_kwh != null)      lines.push(`Zonne-energie: ${payload.solar_kwh} kWh`);
      if (payload.grid_kwh != null)       lines.push(`Net: ${payload.grid_kwh} kWh`);
      if (payload.savings_eur != null)    lines.push(`Besparing: €${payload.savings_eur.toFixed(2)}`);
      return `📊 *Dagrapport*\n\n${lines.join('\n') || 'Geen data beschikbaar'}`;
    }

    case 'unusual_consumption':
      return `⚠️ *Ongewoon verbruik gedetecteerd*\n\n${payload.message || `Piek: ${payload.peak_w ?? '?'} W`}`;

    default:
      return `📢 *${event_type}*\n\n${JSON.stringify(payload, null, 2)}`;
  }
}

async function handleNotify(bot, data) {
  const { event_type, payload = {}, requires_approval, approval_id, chat_id } = data;
  if (!chat_id) throw new Error('chat_id required');

  const text = buildText(event_type, payload);

  if (requires_approval && approval_id) {
    await bot.sendMessage(chat_id, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ja, start laden', callback_data: `approve:${approval_id}` },
          { text: '❌ Sla over',        callback_data: `reject:${approval_id}` },
        ]],
      },
    });
  } else {
    await bot.sendMessage(chat_id, text, { parse_mode: 'Markdown' });
  }
}

function createNotifyServer(bot) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/notify') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          await handleNotify(bot, data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          console.error('[smartmarstek-notify] error:', err.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(3001, () => {
    console.log('[smartmarstek-notify] listening on :3001');
  });

  return server;
}

async function handleCallbackQuery(bot, query) {
  const data = query.data || '';
  const [action, approval_id] = data.split(':');
  if (!['approve', 'reject'].includes(action) || !approval_id) return false;

  const chatId   = query.message.chat.id;
  const messageId = query.message.message_id;

  await bot.answerCallbackQuery(query.id);

  try {
    const body = JSON.stringify({ approval_id, action });
    const resp = await fetch(`${SMARTMARSTEK_URL}/api/telegram/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    const result = await resp.json();
    if (result.ok) {
      const label = action === 'approve' ? '✅ Laden gestart' : '❌ Overgeslagen';
      await bot.editMessageText(`${query.message.text}\n\n_${label}_`, {
        chat_id:    chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
      });
    } else {
      await bot.sendMessage(chatId, `⚠️ Fout: ${result.error || 'onbekend'}`);
    }
  } catch (err) {
    console.error('[smartmarstek-notify] callback error:', err.message);
    await bot.sendMessage(chatId, '⚠️ Kon SmartMarstek niet bereiken.');
  }

  return true;
}

async function handleStatusCommand(bot, chatId) {
  try {
    const [autoResp, socResp] = await Promise.allSettled([
      fetch(`${SMARTMARSTEK_URL}/api/automation`).then(r => r.json()),
      fetch(`${SMARTMARSTEK_URL}/api/debug/soc`).then(r => r.json()),
    ]);

    const auto = autoResp.status === 'fulfilled' ? autoResp.value : null;
    const soc  = socResp.status  === 'fulfilled' ? socResp.value  : null;

    const lines = ['📡 *SmartMarstek status*\n'];

    if (auto) {
      lines.push(`Automatie: ${auto.enabled ? '✅ actief' : '❌ uitgeschakeld'}`);
      if (auto.current_action) lines.push(`Actie: \`${auto.current_action}\``);
      if (auto.last_applied)   lines.push(`Laatste update: ${auto.last_applied.replace('T', ' ').slice(0, 16)}`);
    }

    if (soc) {
      const socVal = soc.last_soc_json?.soc ?? soc.esphome_poll?.average;
      if (socVal != null) lines.push(`Accu SoC: ${socVal}%`);
    }

    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Status ophalen mislukt: ${err.message}`);
  }
}

async function handlePlanCommand(bot, chatId) {
  try {
    const resp = await fetch(`${SMARTMARSTEK_URL}/api/strategy/plan`);
    const data = await resp.json();

    if (data.error) {
      await bot.sendMessage(chatId, `⚠️ ${data.error}`);
      return;
    }

    const lines = ['📋 *Energieplan*\n'];
    const slots = (data.slots || []).slice(0, 8);
    if (slots.length === 0) {
      lines.push('_Geen plan beschikbaar_');
    } else {
      for (const s of slots) {
        const price  = s.price_eur_kwh != null ? `${(s.price_eur_kwh * 100).toFixed(1)}ct` : '?ct';
        const action = s.action ?? s.recommended_action ?? '-';
        lines.push(`${String(s.hour ?? '?').padStart(2, '0')}:00  ${price}  \`${action}\``);
      }
    }
    if (data.strategy_mode) lines.push(`\n_Strategie: ${data.strategy_mode}_`);

    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Plan ophalen mislukt: ${err.message}`);
  }
}

async function handleStopCommand(bot, chatId) {
  try {
    const resp = await fetch(`${SMARTMARSTEK_URL}/api/automation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const data = await resp.json();
    if (!data.enabled) {
      await bot.sendMessage(chatId, '🛑 *Automatie uitgeschakeld.* Gebruik /status om te controleren.', { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '⚠️ Kon automatie niet uitschakelen.');
    }
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Stop mislukt: ${err.message}`);
  }
}

async function handleHelpCommand(bot, chatId) {
  const text = `🤖 *SmartMarstek commando\'s*

/status — Huidige SoC, automatiestatus en actie
/plan — Energieplan voor de komende uren
/stop — Schakel automatie uit (noodstop)
/help — Dit overzicht

_Goedkeuringsverzoeken verschijnen automatisch als ze worden gedetecteerd._`;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

module.exports = {
  createNotifyServer,
  handleCallbackQuery,
  handleStatusCommand,
  handlePlanCommand,
  handleStopCommand,
  handleHelpCommand,
};
