# Communicatie — Telegram Bots

Dit project zorgt ervoor dat het gezin en de digitale assistenten via **Telegram** met elkaar kunnen praten. Er draaien twee aparte bots naast elkaar: de **Huisje-bot** (voor iedereen) en de **PA-bot** (alleen voor Björn en zijn persoonlijke assistent).

---

## Wat is Telegram?

Telegram is een gratis berichtenapp, vergelijkbaar met WhatsApp. Je hebt er al een account voor nodig. De bots zijn onzichtbare deelnemers in een gesprek: je stuurt ze een bericht, zij antwoorden automatisch.

---

## De twee bots

### Huisje-bot

De Huisje-bot is de algemene assistent van het huis.

**Wat kan hij?**
- Vragen over het huis beantwoorden (via Home Assistant, bv. "Is het alarm aan?")
- Meldingen sturen over SmartMarstek (het energiebeheer-systeem)
- Vragen die hij zelf niet weet doorsturen naar Claude (een slim AI-systeem)
- Alle berichten bewaren in een logboek

**Hoe gebruik je hem?**  
Stuur gewoon een berichtje naar de Huisje-bot in Telegram. Hij antwoordt vanzelf.

---

### PA-bot (Persoonlijke Assistent)

De PA-bot is een privékanaal tussen Björn en zijn digitale Persoonlijke Assistent.

**Wat doet hij?**
- De Persoonlijke Assistent stuurt berichten naar Björn via Telegram (bv. een dagelijks overzicht van e-mails)
- Als Björn antwoordt, wordt dat antwoord automatisch doorgestuurd naar de juiste taak in het systeem zodat de assistent kan reageren

**Voorbeeld:**  
De Persoonlijke Assistent stuurt: *"Je hebt 3 nieuwe e-mails. Wil je ze nu lezen?"*  
Björn antwoordt: *"Ja."*  
De assistent ziet dat antwoord en handelt erop.

---

## Hoe werkt het technisch (kort)?

- Beide bots luisteren continu naar Telegram zonder dat er een speciale verbinding of poort nodig is (dit heet *long-polling*).
- Berichten worden bewaard in kleine lokale bestanden op de server (`messages.db` en `pa-messages.db`).
- De bots starten automatisch op als de server opstart (via een systeemservice).

---

## Installatie (voor de beheerder)

### Vereisten

- Node.js (versie 18 of nieuwer)
- Een Telegram-bottoken — aan te maken via [BotFather](https://t.me/BotFather) in Telegram

### Stap 1 — Instellingen invullen

```bash
cp .env.example .env
# Open .env en vul in:
#   TELEGRAM_BOT_TOKEN      → token van de Huisje-bot
#   PA_TELEGRAM_BOT_TOKEN   → token van de PA-bot
#   ANTHROPIC_API_KEY       → (optioneel) voor Claude-AI-antwoorden
```

### Stap 2 — Afhankelijkheden installeren

```bash
npm install
```

### Stap 3 — Bots starten

**Huisje-bot:**
```bash
node index.js
# of automatisch via de systeemservice:
systemctl --user start huisje-bot
```

**PA-bot:**
```bash
systemctl --user start pa-bot
```

---

## Systeemservices instellen (eenmalig)

Zo starten de bots automatisch mee op bij herstart van de server:

```bash
# Huisje-bot
cp huisje-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable huisje-bot
systemctl --user start huisje-bot

# PA-bot
cp pa-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable pa-bot
systemctl --user start pa-bot
```

---

## Veelgebruikte beheeracties

### Bot herstarten

```bash
systemctl --user restart huisje-bot
systemctl --user restart pa-bot
```

### Status controleren

```bash
systemctl --user status huisje-bot
systemctl --user status pa-bot
```

### Logboek bekijken

```bash
journalctl --user -u huisje-bot -f
journalctl --user -u pa-bot -f
```

---

## Een bericht handmatig sturen (voor beheerders)

**Via de Huisje-bot:**
```bash
node send-message.js <chat_id> "Je bericht hier"
```

**Via de PA-bot** (koppelt het bericht aan een taak):
```bash
node pa-send-message.js <chat_id> SCH-42 "Hier zijn de e-mails voor vandaag."
```

- `chat_id` — het Telegram-nummer van de ontvanger
- `SCH-42` — de taakreferentie waar antwoorden naartoe gaan

---

## Probleemoplossing

| Probleem | Wat te doen |
|----------|-------------|
| Bot reageert niet | Controleer status: `systemctl --user status pa-bot` |
| Foutmelding over token | Controleer of `.env` correct is ingevuld |
| Bot crasht na herstart server | Controleer of de service enabled is: `systemctl --user enable pa-bot` |
| Token verlopen of gestolen | Maak een nieuw token via BotFather, vul in `.env`, herstart de service |

---

## Bestanden in dit project

| Bestand | Wat het doet |
|---------|-------------|
| `index.js` | De Huisje-bot server |
| `pa-bot.js` | De PA-bot server |
| `send-message.js` | Handmatig een bericht sturen via Huisje-bot |
| `pa-send-message.js` | Handmatig een bericht sturen via PA-bot |
| `messages.db` | Berichtenlogboek van de Huisje-bot |
| `pa-messages.db` | Berichtenlogboek en contextkaart van de PA-bot |
| `huisje-bot.service` | Systeemservice voor de Huisje-bot |
| `pa-bot.service` | Systeemservice voor de PA-bot |
| `.env` | Geheime sleutels — nooit uploaden of delen! |

---

---

## Discord-kanaal

Naast Telegram stuurt dit project ook berichten naar Discord via **webhooks** (alleen uitgaand, Fase 1).

### Kanalen

| Channel-key | Env-variabele             | Doel                                      |
|-------------|---------------------------|-------------------------------------------|
| `energie`   | `DISCORD_WEBHOOK_ENERGIE` | Energie-advies posts (#energie-advies)    |
| `agents`    | `DISCORD_WEBHOOK_AGENTS`  | Agent-statusmeldingen (#agents)           |
| `huisje`    | `DISCORD_WEBHOOK_HUISJE`  | Huisberichten (#huisje)                   |

### Instellen

1. Open de Discord-server → Serverinstellingen → Integraties → Webhooks.
2. Maak een webhook aan voor elk kanaal.
3. Kopieer de webhook-URL en vul in in `.env`:

```bash
DISCORD_WEBHOOK_ENERGIE=https://discord.com/api/webhooks/<id>/<token>
DISCORD_WEBHOOK_AGENTS=https://discord.com/api/webhooks/<id>/<token>
DISCORD_WEBHOOK_HUISJE=https://discord.com/api/webhooks/<id>/<token>
```

> **Let op:** de webhook-URL bevat een geheim token. Sla hem nooit op in git of logs.

### Handmatig een bericht sturen

```bash
# Tekst
node discord-send.js energie "Stroomadvies: goedkoop tarief tot 23:00"

# Embed (JSON-bestand)
node discord-send.js energie --embed /tmp/mijn-embed.json
```

### Energie-advies (automatisch)

`send-energie-mail.js` post automatisch een Discord-embed in `#energie-advies` naast de e-mail.  
Een mislukte Discord-post logt een fout maar blokkeert de e-mail nooit.

---

## Vragen of problemen?

Neem contact op met de beheerder (Björn) of dien een melding in via het interne taaксysteem.
