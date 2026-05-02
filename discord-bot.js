#!/usr/bin/env node
require('dotenv').config();

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { executeTool, isPaperclipAvailable, TOOLS } = require('./paperclip-handler');

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = '1500218535098449930';

if (!DISCORD_BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN is not set');
  process.exit(1);
}

const STATUS_EMOJI = {
  todo: '📋',
  in_progress: '🔄',
  in_review: '👀',
  blocked: '🚫',
  done: '✅',
  cancelled: '❌',
  backlog: '📦',
};

const PRIORITY_EMOJI = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

function formatIssue(issue) {
  const status = STATUS_EMOJI[issue.status] || '❓';
  const priority = PRIORITY_EMOJI[issue.priority] || '';
  return `${status} **[${issue.identifier}]** ${issue.title} ${priority}`.trim();
}

function chunkText(text, maxLen = 1900) {
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, maxLen));
    text = text.slice(maxLen);
  }
  return chunks;
}

const commands = [
  new SlashCommandBuilder()
    .setName('issues')
    .setDescription('Toon Paperclip issues')
    .addStringOption(o => o.setName('status').setDescription('Filter op status').setRequired(false)
      .addChoices(
        { name: 'todo', value: 'todo' },
        { name: 'in_progress', value: 'in_progress' },
        { name: 'in_review', value: 'in_review' },
        { name: 'blocked', value: 'blocked' },
        { name: 'done', value: 'done' },
      ))
    .addStringOption(o => o.setName('search').setDescription('Zoekterm').setRequired(false)),

  new SlashCommandBuilder()
    .setName('issue')
    .setDescription('Toon details van een specifiek issue')
    .addStringOption(o => o.setName('id').setDescription('Issue ID (bv. SCH-10)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Toon Paperclip dashboard'),

  new SlashCommandBuilder()
    .setName('comment')
    .setDescription('Voeg een reactie toe aan een issue')
    .addStringOption(o => o.setName('id').setDescription('Issue ID (bv. SCH-10)').setRequired(true))
    .addStringOption(o => o.setName('tekst').setDescription('Je reactie').setRequired(true)),

  new SlashCommandBuilder()
    .setName('create')
    .setDescription('Maak een nieuw Paperclip issue aan')
    .addStringOption(o => o.setName('titel').setDescription('Titel van het issue').setRequired(true))
    .addStringOption(o => o.setName('beschrijving').setDescription('Beschrijving').setRequired(false))
    .addStringOption(o => o.setName('prioriteit').setDescription('Prioriteit').setRequired(false)
      .addChoices(
        { name: 'critical', value: 'critical' },
        { name: 'high', value: 'high' },
        { name: 'medium', value: 'medium' },
        { name: 'low', value: 'low' },
      )),

  new SlashCommandBuilder()
    .setName('paperclip')
    .setDescription('Stel een vraag of geef een opdracht aan Paperclip (AI)')
    .addStringOption(o => o.setName('vraag').setDescription('Je vraag of opdracht').setRequired(true)),
].map(c => c.toJSON());

async function registerCommands(guildId) {
  const rest = new REST().setToken(DISCORD_BOT_TOKEN);
  const route = guildId
    ? Routes.applicationGuildCommands(CLIENT_ID, guildId)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Slash commands registered${guildId ? ` for guild ${guildId}` : ' globally'}`);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function askClaude(userMessage) {
  const messages = [{ role: 'user', content: userMessage }];
  let response;

  for (let i = 0; i < 5; i++) {
    response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: 'Je bent een Paperclip assistent. Gebruik de beschikbare tools om issues te beheren. Antwoord kort en bondig in het Nederlands.',
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        let result;
        try { result = await executeTool(block.name, block.input); }
        catch (e) { result = `Error: ${e.message}`; }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || 'Geen antwoord.';
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once('ready', async () => {
  console.log(`Discord bot online als ${client.user.tag}`);
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length > 0) {
    for (const guild of guilds) {
      await registerCommands(guild.id).catch(console.error);
      await setupGuildChannels(guild).catch(console.error);
    }
  } else {
    await registerCommands().catch(console.error);
  }
});

async function setupGuildChannels(guild) {
  const existing = await guild.channels.fetch();
  const hasPaperclip = existing.some(c => c.name === 'paperclip' && c.type === 4);
  if (hasPaperclip) return;

  const me = await guild.members.fetchMe();
  if (!me.permissions.has('ManageChannels')) {
    console.log(`No MANAGE_CHANNELS in ${guild.name}, skipping channel setup`);
    return;
  }

  const category = await guild.channels.create({ name: 'Paperclip', type: 4, position: 1 });

  const channels = [
    { name: 'commando-s', topic: 'Gebruik slash commands: /issues /issue /dashboard /comment /create /paperclip' },
    { name: 'updates', topic: 'Automatische Paperclip issue-updates' },
    { name: 'alerts', topic: 'Kritieke en geblokkeerde issues' },
  ];

  for (const ch of channels) {
    await guild.channels.create({ name: ch.name, type: 0, parent: category.id, topic: ch.topic });
  }

  console.log(`Set up Paperclip channels in ${guild.name}`);
  const commandChannel = existing.find(c => c.name === 'commando-s' || c.name === 'algemeen');
  if (commandChannel) {
    await commandChannel.send(
      '**Paperclip bot is klaar!** 🚀\n\n' +
      'Beschikbare commando\'s:\n' +
      '• `/issues` — toon open issues\n' +
      '• `/issue <id>` — details van een issue\n' +
      '• `/dashboard` — Paperclip overzicht\n' +
      '• `/comment <id> <tekst>` — reageer op een issue\n' +
      '• `/create <titel>` — nieuw issue aanmaken\n' +
      '• `/paperclip <vraag>` — AI-assistent voor Paperclip'
    ).catch(() => {});
  }
}

client.on('guildCreate', async (guild) => {
  console.log(`Joined guild: ${guild.name} (${guild.id})`);
  await registerCommands(guild.id).catch(console.error);
  await setupGuildChannels(guild).catch(console.error);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  const { commandName } = interaction;

  try {
    if (commandName === 'issues') {
      const status = interaction.options.getString('status');
      const search = interaction.options.getString('search');
      const issues = await executeTool('paperclip_list_issues', { status, q: search });
      const parsed = JSON.parse(issues);
      const list = Array.isArray(parsed) ? parsed : (parsed.issues || []);
      if (list.length === 0) {
        await interaction.editReply('Geen issues gevonden.');
        return;
      }
      const lines = list.slice(0, 20).map(formatIssue);
      const text = lines.join('\n');
      await interaction.editReply(text.length > 1900 ? text.slice(0, 1900) + '…' : text);
    }

    else if (commandName === 'issue') {
      const id = interaction.options.getString('id');
      const issue = JSON.parse(await executeTool('paperclip_get_issue', { issueId: id }));
      const embed = new EmbedBuilder()
        .setTitle(`${STATUS_EMOJI[issue.status] || ''} [${issue.identifier}] ${issue.title}`)
        .setDescription(issue.description ? issue.description.slice(0, 4000) : '_Geen beschrijving_')
        .addFields(
          { name: 'Status', value: issue.status || '-', inline: true },
          { name: 'Prioriteit', value: `${PRIORITY_EMOJI[issue.priority] || ''} ${issue.priority || '-'}`, inline: true },
          { name: 'Assignee', value: issue.assigneeAgent?.name || issue.assigneeUser?.name || '_Niemand_', inline: true },
        )
        .setColor(issue.status === 'done' ? 0x57f287 : issue.status === 'blocked' ? 0xed4245 : 0x5865f2);
      await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'dashboard') {
      const data = JSON.parse(await executeTool('paperclip_get_dashboard', {}));
      const lines = [];
      if (data.openIssues !== undefined) lines.push(`📋 Open issues: **${data.openIssues}**`);
      if (data.inProgress !== undefined) lines.push(`🔄 In progress: **${data.inProgress}**`);
      if (data.blocked !== undefined) lines.push(`🚫 Geblokkeerd: **${data.blocked}**`);
      if (data.done !== undefined) lines.push(`✅ Gedaan: **${data.done}**`);
      await interaction.editReply(lines.join('\n') || JSON.stringify(data, null, 2).slice(0, 1900));
    }

    else if (commandName === 'comment') {
      const id = interaction.options.getString('id');
      const tekst = interaction.options.getString('tekst');
      await executeTool('paperclip_update_issue', { issueId: id, comment: tekst });
      await interaction.editReply(`✅ Reactie toegevoegd aan **${id}**.`);
    }

    else if (commandName === 'create') {
      const titel = interaction.options.getString('titel');
      const beschrijving = interaction.options.getString('beschrijving') || '';
      const prioriteit = interaction.options.getString('prioriteit') || 'medium';
      const issue = JSON.parse(await executeTool('paperclip_create_issue', {
        title: titel,
        description: beschrijving,
        priority: prioriteit,
        status: 'todo',
      }));
      await interaction.editReply(`✅ Issue aangemaakt: **${issue.identifier}** — ${issue.title}`);
    }

    else if (commandName === 'paperclip') {
      const vraag = interaction.options.getString('vraag');
      if (!isPaperclipAvailable() || !process.env.ANTHROPIC_API_KEY) {
        await interaction.editReply('❌ Paperclip of Anthropic API niet geconfigureerd.');
        return;
      }
      const answer = await askClaude(vraag);
      const chunks = chunkText(answer);
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
      }
    }

  } catch (err) {
    console.error(`Error in /${commandName}:`, err);
    await interaction.editReply(`❌ Fout: ${err.message}`);
  }
});

client.login(DISCORD_BOT_TOKEN);
