require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { executeTool, isPaperclipAvailable, TOOLS } = require('./paperclip-handler');
const { HA_TOOLS, executeHATool, isHATool } = require('./ha-tools');
const { M365_TOOLS, isM365Tool, executeM365Tool } = require('./m365-tools');

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const OPUS = 'claude-opus-4-7';

function buildSystemPrompt() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const todayStart = `${today}T00:00:00`;
  const todayEnd = `${today}T23:59:59`;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

  return (
    'Je bent een behulpzame assistent in een Telegram-chat. Antwoord in dezelfde taal als de gebruiker. Wees bondig en duidelijk.' +
    '\n\nJe hebt tools om de airco in huis aan te sturen. Gebruik ze wanneer de gebruiker iets over de airco wil doen of weten.' +
    '\nBeschikbare kamers: woonkamer, slaapkamer, alexander, julie.' +
    '\nModi: cool=koelen, heat=verwarmen, heat_cool=auto, dry=drogen, fan_only=alleen ventilator, off=uit.' +
    '\nVentilatorsnelheid: Silence=stil, 1=laagste, 5=hardste stand/max, Auto=automatisch.' +
    '\nPresets: boost=volle kracht, eco=zuinig, away=afwezig, none=normaal.' +
    '\nAls de gebruiker "boost" vraagt, gebruik airco_set_preset met preset_mode="boost".' +
    '\nAls de gebruiker "hardste stand" of "max" vraagt, gebruik airco_set_fan_mode met fan_mode="5".' +
    '\nJe kunt meerdere tools combineren (bv. modus instellen + temperatuur instellen).' +
    '\n\nJe hebt ook toegang tot Microsoft 365 van Björn (bjorn@scheepers.one). Gebruik de m365_* tools wanneer de gebruiker vraagt over:' +
    '\n- e-mails, inbox, ongelezen mails, mails van iemand specifiek' +
    '\n- agenda, afspraken, vergaderingen, kalender' +
    `\n\nHuidige datum: ${today} (vandaag = ${todayStart} t/m ${todayEnd}, morgen = ${tomorrowStr}T00:00:00 t/m ${tomorrowStr}T23:59:59).` +
    '\nGebruik altijd correcte ISO 8601-datums in de tools.' +
    '\n\nAls je tools hebt voor Paperclip, gebruik ze dan wanneer de gebruiker vraagt over taken, issues, agents, of projecten in Paperclip.'
  );
}

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    client = new Anthropic({ apiKey });
  }
  return client;
}

async function classifyComplexity(text) {
  const c = getClient();
  if (!c) return 5;
  try {
    const response = await c.messages.create({
      model: HAIKU,
      max_tokens: 20,
      system: 'Rate the complexity of this question on a scale from 1 to 10 (1=trivial, 10=expert-level). Reply with only the number.',
      messages: [{ role: 'user', content: text }],
    });
    const raw = response.content[0]?.text?.trim() ?? '5';
    const score = parseInt(raw, 10);
    return Number.isNaN(score) ? 5 : Math.min(10, Math.max(1, score));
  } catch {
    return 5;
  }
}

function selectModel(score) {
  if (score <= 3) return HAIKU;
  if (score <= 7) return SONNET;
  return OPUS;
}

async function handleWithClaude(text, chatHistory) {
  const c = getClient();
  if (!c) {
    console.warn('ANTHROPIC_API_KEY not set — skipping Claude fallback');
    return null;
  }

  const score = await classifyComplexity(text);
  const model = selectModel(score);
  console.log(JSON.stringify({ claude_complexity: score, model }));

  const messages = [
    ...chatHistory,
    { role: 'user', content: text },
  ];

  const systemPrompt = buildSystemPrompt();
  const hasPaperclip = isPaperclipAvailable();
  const tools = [...HA_TOOLS, ...M365_TOOLS, ...(hasPaperclip ? TOOLS : [])];

  // Agentic tool-use loop: keep calling until no more tool_use blocks
  let currentMessages = messages;
  for (let i = 0; i < 10; i++) {
    const requestParams = {
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: currentMessages,
    };
    if (tools && tools.length > 0) requestParams.tools = tools;

    const response = await c.messages.create(requestParams);

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock?.text ?? null;
    }

    // Execute all tool calls and build tool_result blocks
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        let result;
        try {
          console.log(JSON.stringify({ tool_call: block.name, input: block.input }));
          if (isHATool(block.name)) {
            result = await executeHATool(block.name, block.input);
          } else if (isM365Tool(block.name)) {
            result = await executeM365Tool(block.name, block.input);
          } else {
            result = await executeTool(block.name, block.input);
          }
        } catch (err) {
          console.error(`Tool ${block.name} error:`, err.message);
          result = JSON.stringify({ error: err.message });
        }
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        };
      })
    );

    // Append assistant message + tool results and continue the loop
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];
  }

  return 'Kon het verzoek niet voltooien na meerdere stappen.';
}

module.exports = { handleWithClaude };
