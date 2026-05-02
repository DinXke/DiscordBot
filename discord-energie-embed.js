/**
 * Bouwt een Discord embed voor energie-advies berichten.
 *
 * adviesType: 'groen' | 'oranje' | 'rood'
 */

const KLEUREN = {
  groen: 0x2ecc71,
  oranje: 0xe67e22,
  rood: 0xe74c3c,
};

const ICONEN = {
  groen: '🟢',
  oranje: '🟠',
  rood: '🔴',
};

function buildEnergieEmbed({ titel, omschrijving, adviesType = 'groen', velden = [], timestamp = true }) {
  const kleur = KLEUREN[adviesType] ?? KLEUREN.groen;
  const icoon = ICONEN[adviesType] ?? ICONEN.groen;

  const embed = {
    title: `${icoon} ${titel}`,
    description: omschrijving,
    color: kleur,
    footer: { text: 'EnergieAdviseur · Scheepers Paperclip' },
  };

  if (velden.length > 0) {
    embed.fields = velden.map(v => ({
      name: v.naam,
      value: v.waarde,
      inline: v.inline ?? false,
    }));
  }

  if (timestamp) {
    embed.timestamp = new Date().toISOString();
  }

  return embed;
}

module.exports = { buildEnergieEmbed };
