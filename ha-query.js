require('dotenv').config();
const https = require('https');
const http = require('http');

const HA_BASE_URL = process.env.HA_BASE_URL;
const HA_TOKEN = process.env.HA_TOKEN;

// Room keyword → entity mappings
const TEMP_SENSORS = {
  slaapkamer: 'sensor.slaapkamer_inside_temperature',
  alexander: 'sensor.alexander_inside_temperature',
  woonkamer: 'sensor.woonkamer_inside_temperature',
  julie: 'sensor.julie_inside_temperature',
  buiten: 'sensor.buitentemperatuur',
  zithoek: 'sensor.zithoek',
};

const CLIMATE_ENTITIES = {
  slaapkamer: 'climate.slaapkamer',
  alexander: 'climate.alexander',
  woonkamer: 'climate.intelligente_ruimteregeling',
  julie: 'climate.kamer_julie',
  badkamer: 'climate.badkamer',
  wasplaats: 'climate.wasplaats',
};

const CLIMATE_DISPLAY_NAMES = {
  slaapkamer: 'Slaapkamer',
  alexander: 'Alexander',
  woonkamer: 'Woonkamer',
  julie: 'Julie',
  badkamer: 'Badkamer',
  wasplaats: 'Wasplaats',
};

const PERSON_ENTITIES = [
  { id: 'person.bjorn_scheepers', name: 'Björn' },
  { id: 'person.anja_michalski', name: 'Anja' },
];

const ALARM_ENTITIES = [
  { id: 'alarm_control_panel.alarmsysteem', name: 'Toegangen' },
  { id: 'alarm_control_panel.alarmsysteem_leefruimtes', name: 'Leefruimtes' },
  { id: 'alarm_control_panel.alarm_technische_ruimte', name: 'Techniek' },
  { id: 'alarm_control_panel.alarm_wapenkast', name: 'Wapenkast' },
];

const ALARM_STATE_NL = {
  disarmed: 'uitgeschakeld',
  armed_away: 'ingeschakeld (weg)',
  armed_home: 'ingeschakeld (thuis)',
  armed_night: 'ingeschakeld (nacht)',
  armed_vacation: 'ingeschakeld (vakantie)',
  triggered: '🚨 ALARM',
  pending: 'wacht op activering',
  arming: 'wordt ingeschakeld',
};

const LOCK_ENTITIES = [
  { id: 'lock.voordeur', name: 'Voordeur' },
  { id: 'lock.doorbird_voordeur', name: 'Voordeur (DoorBird)' },
];

const WEATHER_ENTITY = 'weather.forecast_thuis';

const WEATHER_STATE_NL = {
  'clear-night': '🌙 Helder (nacht)',
  cloudy: '☁️ Bewolkt',
  fog: '🌫️ Mist',
  hail: '🌨️ Hagel',
  lightning: '⚡ Onweer',
  'lightning-rainy': '⛈️ Onweer met regen',
  partlycloudy: '⛅ Gedeeltelijk bewolkt',
  pouring: '🌧️ Zware regen',
  rainy: '🌦️ Regen',
  snowy: '❄️ Sneeuw',
  'snowy-rainy': '🌨️ Natte sneeuw',
  sunny: '☀️ Zonnig',
  windy: '💨 Winderig',
  'windy-variant': '💨 Winderig',
  exceptional: '⚠️ Uitzonderlijk',
};

// Daikin airco entities (real aircos with full hvac control)
const AIRCO_ENTITIES = {
  woonkamer: 'climate.woonkamer_2',
  slaapkamer: 'climate.slaapkamer_2',
  alexander: 'climate.alexander_2',
  julie: 'climate.julie',
};

const AIRCO_DISPLAY_NAMES = {
  woonkamer: 'Woonkamer',
  slaapkamer: 'Slaapkamer',
  alexander: 'Alexander',
  julie: 'Julie',
};

function haGet(path) {
  return new Promise((resolve, reject) => {
    if (!HA_BASE_URL || !HA_TOKEN) {
      return reject(new Error('HA_BASE_URL or HA_TOKEN not configured'));
    }
    const url = new URL(path, HA_BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url.toString(), {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('HA request timeout')); });
  });
}

function haPost(path, body) {
  return new Promise((resolve, reject) => {
    if (!HA_BASE_URL || !HA_TOKEN) {
      return reject(new Error('HA_BASE_URL or HA_TOKEN not configured'));
    }
    const url = new URL(path, HA_BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('HA request timeout')); });
    req.write(payload);
    req.end();
  });
}

async function getState(entityId) {
  return haGet(`/api/states/${entityId}`);
}

async function getAllStates() {
  return haGet('/api/states');
}

// Detect which room keyword appears in a message (Dutch)
function detectRoom(text) {
  const lower = text.toLowerCase();
  if (lower.includes('alexander')) return 'alexander';
  if (lower.includes('julie')) return 'julie';
  if (lower.includes('slaapkamer')) return 'slaapkamer';
  if (lower.includes('woonkamer')) return 'woonkamer';
  if (lower.includes('badkamer')) return 'badkamer';
  if (lower.includes('wasplaats')) return 'wasplaats';
  if (lower.includes('zithoek')) return 'zithoek';
  if (lower.includes('buiten')) return 'buiten';
  return null;
}

function isTemperatureQuery(text) {
  return text.includes('warm') || text.includes('temp') || text.includes('graden') || text.includes('koud');
}

function isLightsQuery(text) {
  return text.includes('licht') || text.includes('lamp') || text.includes('verlichting') || text.includes('branden');
}

function isClimateQuery(text) {
  return text.includes('airco') || text.includes('klimaat') || text.includes('verwarming') || text.includes('ingesteld') || text.includes('koeling');
}

function isCapabilitiesQuery(text) {
  return (text.includes('mogelijkhed') || text.includes('optie') || text.includes('welke') || text.includes('wat kan') || text.includes('wat zijn') || text.includes('standen') || text.includes('modi')) &&
    (text.includes('airco') || text.includes('koel') || text.includes('verwarm') || text.includes('ventilator') || text.includes('fan'));
}

function isAircoControlCommand(text) {
  const hasAirco = text.includes('airco') || text.includes('koeling') || text.includes('koel') || text.includes('verwarm');
  const hasControl = text.includes(' aan') || text.includes(' uit') || text.includes('zet') || text.includes('graden') || text.includes('°') || /\b\d{2}\b/.test(text);
  return hasAirco && hasControl;
}

function detectTargetTemperature(text) {
  const match = text.match(/(\d{1,2}(?:[.,]\d)?)\s*(?:graden|°c|°|gr\b)/i) || text.match(/op\s+(\d{1,2}(?:[.,]\d)?)/i);
  if (!match) return null;
  return parseFloat(match[1].replace(',', '.'));
}

function detectHvacMode(text) {
  if (text.includes('koel') || text.includes('cooling') || text.includes('cool')) return 'cool';
  if (text.includes('verwarm') || text.includes('heat') || text.includes('verwarmen')) return 'heat';
  if (text.includes('dry') || text.includes('drogen') || text.includes('ontvochtigen')) return 'dry';
  if (text.includes('ventilator') || text.includes('fan') || text.includes('alleen ventilator')) return 'fan_only';
  if (text.includes('auto') || text.includes('heat_cool')) return 'heat_cool';
  if (text.includes(' uit') || text.includes('uitschakelen') || text.includes('stoppen')) return 'off';
  if (text.includes(' aan') || text.includes('inschakelen')) return 'cool';
  return null;
}

function isPresenceQuery(text) {
  return text.includes('thuis') || text.includes('aanwezig') || text.includes('wie is') || text.includes('wie er') || text.includes('iemand thuis') || text.includes('bjorn') || text.includes('björn') || text.includes('anja');
}

function isAlarmQuery(text) {
  return text.includes('alarm') || text.includes('beveiligd') || text.includes('beveiliging') || text.includes('ingeschakeld');
}

function isWeatherQuery(text) {
  return text.includes('weer') || text.includes('regen') || text.includes('weersverwachting') || text.includes('zon') || text.includes('wind') || text.includes('neerslag') || text.includes('bewolkt');
}

function isLockQuery(text) {
  return (text.includes('slot') || text.includes('vergrendeld') || text.includes('op slot') || text.includes('deur')) && !text.includes('licht');
}

function isCoverQuery(text) {
  return text.includes('rolluik') || text.includes('screen') || text.includes('poort') || text.includes('zonwering') || text.includes('gordijn');
}

async function queryPresence() {
  const results = [];
  for (const { id, name } of PERSON_ENTITIES) {
    try {
      const s = await getState(id);
      const icon = s.state === 'home' ? '🏠' : '🚗';
      const label = s.state === 'home' ? 'thuis' : s.state === 'not_home' ? 'weg' : s.state;
      results.push(`${icon} ${name}: ${label}`);
    } catch {}
  }
  return results.length ? `👥 Aanwezigheid:\n${results.join('\n')}` : 'Kan aanwezigheidsdata niet ophalen.';
}

async function queryAlarm() {
  const results = [];
  for (const { id, name } of ALARM_ENTITIES) {
    try {
      const s = await getState(id);
      const label = ALARM_STATE_NL[s.state] || s.state;
      results.push(`${name}: ${label}`);
    } catch {}
  }
  return results.length ? `🔒 Alarmstatus:\n${results.join('\n')}` : 'Kan alarmstatus niet ophalen.';
}

async function queryWeather() {
  try {
    const s = await getState(WEATHER_ENTITY);
    const label = WEATHER_STATE_NL[s.state] || s.state;
    const a = s.attributes;
    const lines = [
      `${label}`,
      `🌡️ ${a.temperature}°C`,
      `💧 Luchtvochtigheid: ${a.humidity}%`,
      `💨 Wind: ${a.wind_speed} km/h`,
    ];
    if (a.pressure) lines.push(`📊 Luchtdruk: ${a.pressure} hPa`);
    return `🌤️ Weer:\n${lines.join('\n')}`;
  } catch {
    return 'Kan weerdata niet ophalen.';
  }
}

async function queryLocks() {
  const results = [];
  for (const { id, name } of LOCK_ENTITIES) {
    try {
      const s = await getState(id);
      if (s.state === 'unavailable') continue;
      const icon = s.state === 'locked' ? '🔒' : '🔓';
      const label = s.state === 'locked' ? 'op slot' : s.state === 'unlocked' ? 'open' : s.state;
      results.push(`${icon} ${name}: ${label}`);
    } catch {}
  }
  return results.length ? `🚪 Sloten:\n${results.join('\n')}` : 'Kan slotstatus niet ophalen.';
}

function cleanCoverName(friendlyName) {
  let name = friendlyName.replace(/^loxone\s+/i, '');
  const words = name.split(' ');
  const half = Math.floor(words.length / 2);
  if (half > 0 && words.slice(0, half).join(' ') === words.slice(half).join(' ')) {
    name = words.slice(0, half).join(' ');
  }
  return name;
}

async function queryCovers() {
  try {
    const states = await getAllStates();
    const covers = states.filter((s) => s.entity_id.startsWith('cover.'));
    if (!covers.length) return 'Geen rolluiken gevonden.';
    const open = covers.filter((s) => s.state === 'open' || s.state === 'opening');
    const closed = covers.filter((s) => s.state === 'closed' || s.state === 'closing');
    const lines = [];
    if (open.length) lines.push(`🔼 Open (${open.length}): ${open.map((s) => cleanCoverName(s.attributes.friendly_name || s.entity_id)).join(', ')}`);
    if (closed.length) lines.push(`🔽 Gesloten (${closed.length}): ${closed.map((s) => cleanCoverName(s.attributes.friendly_name || s.entity_id)).join(', ')}`);
    return `🪟 Rolluiken:\n${lines.join('\n')}`;
  } catch {
    return 'Kan rolluikstatus niet ophalen.';
  }
}

function cleanLightName(entityId, friendlyName) {
  let name = friendlyName.replace(/^loxone\s+/i, '');
  name = name.split('-')[0].trim();
  const words = name.split(' ');
  const half = Math.floor(words.length / 2);
  if (half > 0 && words.slice(0, half).join(' ') === words.slice(half).join(' ')) {
    name = words.slice(0, half).join(' ');
  }
  return name;
}

async function queryLights() {
  try {
    const states = await getAllStates();
    const on = states.filter((s) => {
      if (!s.entity_id.startsWith('light.')) return false;
      if (s.state !== 'on') return false;
      const fn = s.attributes.friendly_name || '';
      if (/status.?led|ap\s|\bled\b/i.test(fn) && !/woonkamer|slaapkamer|bureau|keuken|eettafel|badkamer/i.test(fn)) return false;
      return true;
    });
    const seen = new Set();
    const unique = on.filter((s) => {
      const name = cleanLightName(s.entity_id, s.attributes.friendly_name || '');
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    if (!unique.length) return '💡 Er branden geen lichten.';
    const names = unique.map((s) => cleanLightName(s.entity_id, s.attributes.friendly_name || ''));
    return `💡 Lichten aan (${unique.length}):\n${names.slice(0, 20).join('\n')}`;
  } catch {
    return 'Kan lichtstatus niet ophalen.';
  }
}

async function queryTemperature(room) {
  if (!room || !TEMP_SENSORS[room]) {
    const results = [];
    for (const [roomKey, entityId] of Object.entries(TEMP_SENSORS)) {
      if (roomKey === 'buiten') continue;
      try {
        const s = await getState(entityId);
        if (s.state && s.state !== 'unavailable' && s.state !== 'unknown') {
          results.push(`${roomKey.charAt(0).toUpperCase() + roomKey.slice(1)}: ${s.state}°C`);
        }
      } catch {}
    }
    try {
      const buiten = await getState(TEMP_SENSORS.buiten);
      if (buiten.state && buiten.state !== 'unavailable') {
        results.push(`Buiten: ${buiten.state}°C`);
      }
    } catch {}
    return results.length ? `🌡️ Temperaturen:\n${results.join('\n')}` : 'Kan temperaturen niet ophalen.';
  }

  try {
    const s = await getState(TEMP_SENSORS[room]);
    if (s.state === 'unavailable' || s.state === 'unknown') {
      return `Temperatuur ${room} is momenteel niet beschikbaar.`;
    }
    return `🌡️ ${room.charAt(0).toUpperCase() + room.slice(1)}: ${s.state}°C`;
  } catch (e) {
    return `Kan temperatuur voor ${room} niet ophalen.`;
  }
}

async function queryClimate(room) {
  if (!room || !CLIMATE_ENTITIES[room]) {
    const results = [];
    for (const [roomKey, entityId] of Object.entries(CLIMATE_ENTITIES)) {
      try {
        const s = await getState(entityId);
        if (s.state === 'unavailable') continue;
        const cur = s.attributes.current_temperature;
        const set = s.attributes.temperature;
        const mode = s.state;
        results.push(`${CLIMATE_DISPLAY_NAMES[roomKey]}: ${cur}°C huidig, ingesteld op ${set}°C (${mode})`);
      } catch {}
    }
    return results.length ? `❄️ Klimaatinstellingen:\n${results.join('\n')}` : 'Kan klimaatdata niet ophalen.';
  }

  const entityId = CLIMATE_ENTITIES[room];
  if (!entityId) return `Geen klimaatentiteit gevonden voor ${room}.`;

  try {
    const s = await getState(entityId);
    if (s.state === 'unavailable') return `Airco ${room} is momenteel niet beschikbaar.`;
    const cur = s.attributes.current_temperature;
    const set = s.attributes.temperature;
    const mode = s.state;
    const fan = s.attributes.fan_mode ? ` | ventilator: ${s.attributes.fan_mode}` : '';
    const name = CLIMATE_DISPLAY_NAMES[room] || room;
    return `❄️ Airco ${name}: ${cur}°C huidig, ingesteld op ${set}°C | modus: ${mode}${fan}`;
  } catch {
    return `Kan klimaatdata voor ${room} niet ophalen.`;
  }
}

const HVAC_MODE_NL = {
  off: 'Uit',
  cool: 'Koelen',
  heat: 'Verwarmen',
  heat_cool: 'Automatisch (koelen + verwarmen)',
  dry: 'Ontvochtigen',
  fan_only: 'Alleen ventilator',
};

async function queryAircoCapabilities(room) {
  const entityId = room ? AIRCO_ENTITIES[room] : AIRCO_ENTITIES.woonkamer;
  const displayName = room ? AIRCO_DISPLAY_NAMES[room] : null;

  if (!entityId) {
    const lines = ['🌀 Beschikbare kamers voor airco:'];
    for (const [r, name] of Object.entries(AIRCO_DISPLAY_NAMES)) {
      lines.push(`  • ${name}`);
    }
    return lines.join('\n');
  }

  try {
    const state = await getState(entityId);
    const a = state.attributes;
    const lines = [`🌀 Airco ${displayName || 'overzicht'} — beschikbare opties:\n`];

    if (a.hvac_modes?.length) {
      lines.push('🔧 Modi:');
      for (const m of a.hvac_modes) lines.push(`  • ${HVAC_MODE_NL[m] || m}`);
    }
    if (a.fan_modes?.length) {
      lines.push('\n💨 Ventilatorstanden:');
      for (const f of a.fan_modes) lines.push(`  • ${f}`);
    }
    if (a.preset_modes?.length) {
      lines.push('\n⚡ Presets:');
      for (const p of a.preset_modes) lines.push(`  • ${p}`);
    }
    if (a.swing_modes?.length) {
      lines.push('\n🔄 Zwenkstanden:');
      for (const s of a.swing_modes) lines.push(`  • ${s}`);
    }

    lines.push(`\n🌡️ Temperatuurbereik: ${a.min_temp}°C – ${a.max_temp}°C`);
    return lines.join('\n');
  } catch {
    return 'Kan opties niet ophalen van Home Assistant.';
  }
}

async function controlAirco(room, mode, temperature) {
  const entityId = room ? AIRCO_ENTITIES[room] : null;
  const displayName = room ? AIRCO_DISPLAY_NAMES[room] : null;

  if (!entityId) return null;

  const actions = [];

  try {
    if (mode === 'off') {
      await haPost('/api/services/climate/turn_off', { entity_id: entityId });
      actions.push(`uitgeschakeld`);
    } else {
      if (mode && mode !== 'off') {
        await haPost('/api/services/climate/set_hvac_mode', { entity_id: entityId, hvac_mode: mode });
        const modeLabel = { cool: 'koelen', heat: 'verwarmen', dry: 'drogen', fan_only: 'ventilator', heat_cool: 'auto' }[mode] || mode;
        actions.push(`modus: ${modeLabel}`);
      }
      if (temperature !== null && temperature !== undefined) {
        const clamped = Math.min(35, Math.max(7, temperature));
        await haPost('/api/services/climate/set_temperature', { entity_id: entityId, temperature: clamped });
        actions.push(`temperatuur: ${clamped}°C`);
      }
    }
    return `✅ Airco ${displayName} — ${actions.join(', ')}`;
  } catch (err) {
    return `❌ Fout bij aansturen airco ${displayName}: ${err.message}`;
  }
}

async function controlAllAircos(mode, temperature) {
  const results = [];
  for (const [room, entityId] of Object.entries(AIRCO_ENTITIES)) {
    try {
      if (mode === 'off') {
        await haPost('/api/services/climate/turn_off', { entity_id: entityId });
        results.push(`✅ ${AIRCO_DISPLAY_NAMES[room]}: uit`);
      } else {
        if (mode) {
          await haPost('/api/services/climate/set_hvac_mode', { entity_id: entityId, hvac_mode: mode });
        }
        if (temperature !== null && temperature !== undefined) {
          const clamped = Math.min(35, Math.max(7, temperature));
          await haPost('/api/services/climate/set_temperature', { entity_id: entityId, temperature: clamped });
        }
        results.push(`✅ ${AIRCO_DISPLAY_NAMES[room]}: ok`);
      }
    } catch (err) {
      results.push(`❌ ${AIRCO_DISPLAY_NAMES[room]}: fout`);
    }
  }
  return `🌀 Alle aircos:\n${results.join('\n')}`;
}

// Main entry: given a Telegram message text, return a reply or null if not an HA query
async function handleHAQuery(text) {
  if (!text) return null;

  const lower = text.toLowerCase();

  if (isCapabilitiesQuery(lower)) return queryAircoCapabilities(detectRoom(lower));

  // Airco control must be checked before climate read queries
  if (isAircoControlCommand(lower)) {
    const room = detectRoom(lower);
    const mode = detectHvacMode(lower);
    const temperature = detectTargetTemperature(lower);

    // "uit" with no room → turn off all
    if (!room && (mode === 'off' || (lower.includes(' uit') && !lower.includes(' aan')))) {
      return controlAllAircos('off', null);
    }
    // With room specified
    if (room && AIRCO_ENTITIES[room]) {
      return controlAirco(room, mode, temperature);
    }
    // No room + not an "all off" → let Claude handle or fall through to status
  }

  if (isPresenceQuery(lower)) return queryPresence();
  if (isAlarmQuery(lower)) return queryAlarm();
  if (isWeatherQuery(lower)) return queryWeather();
  if (isLockQuery(lower)) return queryLocks();
  if (isCoverQuery(lower)) return queryCovers();
  if (isClimateQuery(lower)) return queryClimate(detectRoom(text));
  if (isTemperatureQuery(lower)) return queryTemperature(detectRoom(text));
  if (isLightsQuery(lower)) return queryLights();

  return null;
}

module.exports = {
  handleHAQuery,
  queryTemperature,
  queryClimate,
  queryLights,
  queryPresence,
  queryAlarm,
  queryWeather,
  queryLocks,
  queryCovers,
  controlAirco,
  controlAllAircos,
  haGet,
  haPost,
  AIRCO_ENTITIES,
  AIRCO_DISPLAY_NAMES,
};
