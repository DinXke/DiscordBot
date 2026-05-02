require('dotenv').config();
const { haPost, haGet, AIRCO_ENTITIES, AIRCO_DISPLAY_NAMES } = require('./ha-query');

const ROOMS = Object.keys(AIRCO_ENTITIES);

const HA_TOOLS = [
  {
    name: 'airco_set_temperature',
    description: 'Stel de doeltemperatuur in van een airco. Gebruik dit wanneer de gebruiker een temperatuur opgeeft (bv. "21 graden", "22°C").',
    input_schema: {
      type: 'object',
      properties: {
        room: { type: 'string', enum: ROOMS, description: 'Kamer: woonkamer, slaapkamer, alexander, of julie' },
        temperature: { type: 'number', description: 'Gewenste temperatuur in °C (7–35)' },
      },
      required: ['room', 'temperature'],
    },
  },
  {
    name: 'airco_set_hvac_mode',
    description: 'Zet de werkingsmodus van een airco: cool (koelen), heat (verwarmen), heat_cool (auto), dry (drogen), fan_only (ventilator), of off (uit).',
    input_schema: {
      type: 'object',
      properties: {
        room: { type: 'string', enum: ROOMS },
        hvac_mode: {
          type: 'string',
          enum: ['off', 'cool', 'heat', 'heat_cool', 'dry', 'fan_only'],
          description: 'Modus: off=uit, cool=koelen, heat=verwarmen, heat_cool=automatisch, dry=ontvochtigen, fan_only=ventilator',
        },
      },
      required: ['room', 'hvac_mode'],
    },
  },
  {
    name: 'airco_set_fan_mode',
    description: 'Stel de ventilatorsnelheid in. Silence=stil/laagste, 1–5 (5=hardste stand/maximum), Auto=automatisch.',
    input_schema: {
      type: 'object',
      properties: {
        room: { type: 'string', enum: ROOMS },
        fan_mode: {
          type: 'string',
          enum: ['Auto', 'Silence', '1', '2', '3', '4', '5'],
          description: 'Auto=automatisch, Silence=stil, 1=laagste, 5=hardste/max',
        },
      },
      required: ['room', 'fan_mode'],
    },
  },
  {
    name: 'airco_set_preset',
    description: 'Activeer een preset op een airco. boost=volle kracht/snelst koelen of verwarmen, eco=zuinig, away=afwezig, none=normaal.',
    input_schema: {
      type: 'object',
      properties: {
        room: { type: 'string', enum: ROOMS },
        preset_mode: {
          type: 'string',
          enum: ['none', 'away', 'eco', 'boost'],
          description: 'none=normaal, boost=volle kracht, eco=zuinig, away=afwezig',
        },
      },
      required: ['room', 'preset_mode'],
    },
  },
  {
    name: 'airco_get_state',
    description: 'Haal de huidige status op van een airco (modus, temperatuur, ventilator, preset).',
    input_schema: {
      type: 'object',
      properties: {
        room: { type: 'string', enum: ROOMS },
      },
      required: ['room'],
    },
  },
  {
    name: 'airco_get_capabilities',
    description: 'Haal alle beschikbare opties op van een airco rechtstreeks uit Home Assistant: modi, ventilatorstanden, presets, zwenkstanden en temperatuurbereik.',
    input_schema: {
      type: 'object',
      properties: {
        room: { type: 'string', enum: ROOMS },
      },
      required: ['room'],
    },
  },
];

async function executeHATool(name, input) {
  const entityId = AIRCO_ENTITIES[input.room];
  const displayName = AIRCO_DISPLAY_NAMES[input.room];
  if (!entityId) return JSON.stringify({ error: `Onbekende kamer: ${input.room}` });

  try {
    switch (name) {
      case 'airco_set_temperature': {
        const temp = Math.min(35, Math.max(7, input.temperature));
        await haPost('/api/services/climate/set_temperature', { entity_id: entityId, temperature: temp });
        return JSON.stringify({ success: true, room: displayName, temperature: temp });
      }
      case 'airco_set_hvac_mode': {
        if (input.hvac_mode === 'off') {
          await haPost('/api/services/climate/turn_off', { entity_id: entityId });
        } else {
          await haPost('/api/services/climate/set_hvac_mode', { entity_id: entityId, hvac_mode: input.hvac_mode });
        }
        return JSON.stringify({ success: true, room: displayName, hvac_mode: input.hvac_mode });
      }
      case 'airco_set_fan_mode': {
        await haPost('/api/services/climate/set_fan_mode', { entity_id: entityId, fan_mode: input.fan_mode });
        return JSON.stringify({ success: true, room: displayName, fan_mode: input.fan_mode });
      }
      case 'airco_set_preset': {
        await haPost('/api/services/climate/set_preset_mode', { entity_id: entityId, preset_mode: input.preset_mode });
        return JSON.stringify({ success: true, room: displayName, preset_mode: input.preset_mode });
      }
      case 'airco_get_state': {
        const state = await haGet(`/api/states/${entityId}`);
        const a = state.attributes;
        return JSON.stringify({
          room: displayName,
          state: state.state,
          current_temperature: a.current_temperature,
          target_temperature: a.temperature,
          fan_mode: a.fan_mode,
          preset_mode: a.preset_mode,
          swing_mode: a.swing_mode,
        });
      }
      case 'airco_get_capabilities': {
        const state = await haGet(`/api/states/${entityId}`);
        const a = state.attributes;
        return JSON.stringify({
          room: displayName,
          hvac_modes: a.hvac_modes,
          fan_modes: a.fan_modes,
          preset_modes: a.preset_modes,
          swing_modes: a.swing_modes,
          min_temp: a.min_temp,
          max_temp: a.max_temp,
        });
      }
      default:
        return JSON.stringify({ error: `Onbekende tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

function isHATool(name) {
  return name.startsWith('airco_');
}

module.exports = { HA_TOOLS, executeHATool, isHATool };
