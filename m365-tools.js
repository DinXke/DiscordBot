/**
 * Microsoft 365 tools for Claude.
 * Follows the same pattern as ha-tools.js.
 */
const { callTool } = require('./m365-client');

function fmt(addr) {
  if (!addr) return '?';
  return addr.name ? `${addr.name} <${addr.address}>` : (addr.address || '?');
}

function formatMail(m) {
  return {
    id: m.id,
    van: fmt(m.from?.emailAddress),
    onderwerp: m.subject,
    ontvangen: m.receivedDateTime,
    gelezen: m.isRead,
    preview: m.bodyPreview,
  };
}

function formatEvent(e) {
  return {
    titel: e.subject,
    start: e.start?.dateTime,
    einde: e.end?.dateTime,
    locatie: e.location?.displayName || null,
    online: e.isOnlineMeeting || false,
  };
}

const M365_TOOLS = [
  {
    name: 'm365_list_mail',
    description:
      'Haal e-mails op uit de mailbox van Björn (bjorn@scheepers.one). ' +
      'Gebruik filter="isRead eq false" voor ongelezen mails. ' +
      'Gebruik search= voor zoeken op onderwerp of afzender.',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'OData filter, bijv. "isRead eq false" voor ongelezen mails, of "from/emailAddress/address eq \'x@y.com\'"',
        },
        search: {
          type: 'string',
          description: 'Zoekterm voor mails op onderwerp, afzender of inhoud (KQL)',
        },
        top: {
          type: 'number',
          description: 'Aantal mails (standaard 5, max 20)',
        },
      },
    },
  },
  {
    name: 'm365_get_calendar',
    description:
      'Haal agenda-afspraken op voor een datumbereik van Björn. ' +
      'Geef startDateTime en endDateTime als ISO 8601. ' +
      'Voor "vandaag": start=vandaag 00:00, einde=vandaag 23:59. ' +
      'Voor "deze week": start=maandag 00:00, einde=zondag 23:59.',
    input_schema: {
      type: 'object',
      properties: {
        startDateTime: {
          type: 'string',
          description: 'Startdatum/-tijd, bijv. "2026-04-18T00:00:00"',
        },
        endDateTime: {
          type: 'string',
          description: 'Einddatum/-tijd, bijv. "2026-04-18T23:59:59"',
        },
      },
      required: ['startDateTime', 'endDateTime'],
    },
  },
  {
    name: 'm365_get_mail_body',
    description: 'Haal de volledige tekst op van een specifieke e-mail (gebruik het id uit m365_list_mail).',
    input_schema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'Het id van de e-mail, verkregen via m365_list_mail',
        },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'm365_send_mail',
    description: 'Stuur een e-mail vanuit de gedeelde Paperclip-mailbox (paperclip@scheepers.one). ' +
      'Alle uitgaande mails worden standaard verzonden vanuit paperclip@scheepers.one.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'E-mailadres van de ontvanger' },
        subject: { type: 'string', description: 'Onderwerp van de e-mail' },
        body: { type: 'string', description: 'Inhoud van de e-mail (HTML of platte tekst)' },
        isHtml: { type: 'boolean', description: 'true als body HTML is, false voor platte tekst (standaard: false)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

function isM365Tool(name) {
  return name.startsWith('m365_');
}

async function executeM365Tool(name, input) {
  try {
    if (name === 'm365_list_mail') {
      const args = {
        top: Math.min(input.top || 5, 20),
        select: 'id,subject,from,receivedDateTime,bodyPreview,isRead',
        orderby: 'receivedDateTime desc',
      };
      if (input.filter) args.filter = input.filter;
      if (input.search) args.search = `"${input.search}"`;
      const result = await callTool('list-mail-messages', args);
      const mails = (result?.value || []).map(formatMail);
      return JSON.stringify({ mails, totaal: mails.length });
    }

    if (name === 'm365_get_calendar') {
      const result = await callTool('get-calendar-view', {
        startDateTime: input.startDateTime,
        endDateTime: input.endDateTime,
        timezone: 'Europe/Brussels',
        select: 'subject,start,end,location,isOnlineMeeting',
        top: 25,
      });
      const events = (result?.value || []).map(formatEvent);
      return JSON.stringify({ afspraken: events, totaal: events.length });
    }

    if (name === 'm365_get_mail_body') {
      const result = await callTool('get-mail-message', {
        messageId: input.messageId,
        select: 'subject,from,receivedDateTime,body,bodyPreview',
      });
      const body = result?.body?.content || result?.bodyPreview || '';
      // Strip HTML tags for plain text
      const plain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
      return JSON.stringify({
        onderwerp: result?.subject,
        van: fmt(result?.from?.emailAddress),
        ontvangen: result?.receivedDateTime,
        inhoud: plain,
      });
    }

    if (name === 'm365_send_mail') {
      if (!input.body) return JSON.stringify({ error: 'body is verplicht — geef de volledige e-mailinhoud mee in het body-veld' });
      await callTool('send-mail', {
        body: {
          Message: {
            subject: input.subject,
            body: {
              contentType: input.isHtml ? 'html' : 'text',
              content: input.body,
            },
            toRecipients: [{ emailAddress: { address: input.to } }],
            from: { emailAddress: { address: 'paperclip@scheepers.one', name: 'Paperclip' } },
          },
          SaveToSentItems: true,
        },
      });
      return JSON.stringify({ success: true, naar: input.to, onderwerp: input.subject, van: 'paperclip@scheepers.one' });
    }

    return JSON.stringify({ error: `Onbekende M365-tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

module.exports = { M365_TOOLS, isM365Tool, executeM365Tool };
