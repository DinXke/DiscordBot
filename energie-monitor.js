#!/usr/bin/env node
/**
 * energie-monitor.js — bewaakt Frank energieprijzen via FLUX en stuurt
 * Discord-meldingen naar het #energie-advies kanaal wanneer:
 *   - een negatieve prijsperiode begint
 *   - een negatieve prijsperiode eindigt
 *
 * Vereiste env-variabelen (in .env):
 *   SMARTMARSTEK_URL          (default: http://localhost:5000)
 *   FLUX_ENERGIE_ADVIES_TOKEN (optioneel — als ingesteld in FLUX)
 *   DISCORD_WEBHOOK_ENERGIE   (webhook URL voor #energie-advies)
 *
 * Integratie: aanroepen via pa-bot.js of als aparte service.
 */
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { sendDiscord }      = require('./discord-send');
const { buildEnergieEmbed } = require('./discord-energie-embed');

const FLUX_URL     = process.env.SMARTMARSTEK_URL || 'http://localhost:5000';
const FLUX_TOKEN   = process.env.FLUX_ENERGIE_ADVIES_TOKEN || '';
const STATE_FILE   = path.join(__dirname, 'energie-monitor-state.json');
const POLL_MS      = 5 * 60 * 1000; // 5 minuten

// ── state helpers ─────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return { inNegativePeriod: false, periodStart: null, lastCheck: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── prix fetch ────────────────────────────────────────────────────────────

async function fetchPrices() {
  const headers = { 'Content-Type': 'application/json' };
  if (FLUX_TOKEN) headers['Authorization'] = `Bearer ${FLUX_TOKEN}`;

  const res = await fetch(`${FLUX_URL}/api/energie-advies/prices`, { headers });
  if (!res.ok) {
    throw new Error(`FLUX /api/energie-advies/prices fout (${res.status})`);
  }
  return res.json();
}

// ── embed builders ────────────────────────────────────────────────────────

function formatPrice(p) {
  if (p == null) return '?';
  return `€${(p * 100).toFixed(2)} ct/kWh`;
}

function formatHour(h) {
  if (h == null) return '?';
  const hh = String(h).padStart(2, '0');
  return `${hh}:00`;
}

function buildNegativeStartEmbed(window, allSlots) {
  const minPrice = window.min_price;
  const endHour  = window.end_hour != null ? window.end_hour + 1 : null;

  const slotLines = (window.slots || []).map(s => {
    const p = s.price_eur_kwh ?? s.price;
    return `\`${formatHour(s.hour)}\`  ${formatPrice(p)}`;
  });

  return buildEnergieEmbed({
    titel:       'Negatieve stroomprijs gestart!',
    omschrijving: `💸 De stroomprijs is negatief — **je wordt betaald om stroom te gebruiken.**\n\nZet extra verbruikers aan: wasmachine, vaatwasser, waterboiler, batterij opladen.`,
    adviesType:  'groen',
    velden: [
      { naam: 'Van',       waarde: formatHour(window.start_hour),  inline: true },
      { naam: 'Tot (uur)', waarde: endHour ? formatHour(endHour) : '?', inline: true },
      { naam: 'Min. prijs', waarde: formatPrice(minPrice),         inline: true },
      ...(slotLines.length > 0 ? [{ naam: 'Uurtarieven', waarde: slotLines.join('\n'), inline: false }] : []),
    ],
  });
}

function buildNegativeEndEmbed(startedAt) {
  const duration = startedAt
    ? Math.round((Date.now() - new Date(startedAt).getTime()) / 60000)
    : null;

  return buildEnergieEmbed({
    titel:       'Negatieve prijsperiode voorbij',
    omschrijving: `⚡ De stroomprijs is weer positief. Normale tarieven gelden weer.`,
    adviesType:  'oranje',
    velden: duration != null
      ? [{ naam: 'Duur', waarde: `${duration} minuten`, inline: true }]
      : [],
  });
}

function buildDagOverzichtEmbed(data) {
  const today    = data.today    || [];
  const tomorrow = data.tomorrow || [];
  const windows  = (data.negative_windows?.today || [])
    .concat(data.negative_windows?.tomorrow || []);

  if (windows.length === 0) return null;

  const lines = windows.map(w => {
    const end = w.end_hour != null ? w.end_hour + 1 : '?';
    return `${formatHour(w.start_hour)}–${formatHour(end)}  min ${formatPrice(w.min_price)}`;
  });

  return buildEnergieEmbed({
    titel:       'Negatieve prijsvensters vandaag/morgen',
    omschrijving: 'Overzicht van verwachte negatieve stroomtarieven.',
    adviesType:  'groen',
    velden: [
      { naam: 'Periodes', waarde: lines.join('\n'), inline: false },
    ],
  });
}

// ── main check ────────────────────────────────────────────────────────────

async function checkPrices() {
  let data;
  try {
    data = await fetchPrices();
  } catch (err) {
    console.error('[energie-monitor] prijzen ophalen mislukt:', err.message);
    return;
  }

  const state = loadState();
  const slots  = data.today || [];
  const now    = new Date();
  const curHour = now.getHours();

  // Huidige slot
  const currentSlot = slots.find(s => s.hour === curHour);
  const currentPrice = currentSlot
    ? (currentSlot.price_eur_kwh ?? currentSlot.price ?? null)
    : null;

  const isNegativeNow = currentPrice != null && currentPrice < 0;

  // Detecteer start negatieve periode
  if (isNegativeNow && !state.inNegativePeriod) {
    console.log(`[energie-monitor] ⚠️  Negatieve prijs gedetecteerd: ${currentPrice} €/kWh`);
    state.inNegativePeriod = true;
    state.periodStart = now.toISOString();
    saveState(state);

    // Vind het huidige window
    const windows = data.negative_windows?.today || [];
    const activeWindow = windows.find(w =>
      w.start_hour <= curHour && (w.end_hour >= curHour)
    ) || { start_hour: curHour, end_hour: curHour, min_price: currentPrice, slots: [currentSlot] };

    try {
      const embed = buildNegativeStartEmbed(activeWindow, slots);
      await sendDiscord('energie', { embeds: [embed] });
      console.log('[energie-monitor] Discord melding verstuurd: negatieve prijs gestart');
    } catch (err) {
      console.error('[energie-monitor] Discord embed mislukt:', err.message);
    }
  }

  // Detecteer einde negatieve periode
  if (!isNegativeNow && state.inNegativePeriod) {
    console.log('[energie-monitor] Negatieve prijsperiode voorbij');
    const startedAt = state.periodStart;
    state.inNegativePeriod = false;
    state.periodStart = null;
    saveState(state);

    try {
      const embed = buildNegativeEndEmbed(startedAt);
      await sendDiscord('energie', { embeds: [embed] });
      console.log('[energie-monitor] Discord melding verstuurd: periode voorbij');
    } catch (err) {
      console.error('[energie-monitor] Discord embed mislukt:', err.message);
    }
  }

  state.lastCheck = now.toISOString();
  saveState(state);
}

// ── loop ──────────────────────────────────────────────────────────────────

async function start() {
  console.log(`[energie-monitor] gestart (poll elke ${POLL_MS / 1000}s, FLUX: ${FLUX_URL})`);
  await checkPrices();
  setInterval(checkPrices, POLL_MS);
}

if (require.main === module) {
  start().catch(err => {
    console.error('[energie-monitor] fatale fout:', err.message);
    process.exit(1);
  });
}

module.exports = { checkPrices, start };
