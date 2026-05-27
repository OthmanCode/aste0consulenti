'use strict';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min)) + min;
const generateId = (codice) => codice.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase().slice(0, 40);

// ── Normalizza prezzo ─────────────────────────────────────────────────────────
function normalizePrezzo(raw) {
  if (!raw) return null;
  // "€ 127.000,00" → "1234567890" → 127000
  const s = raw.replace(/[^\d,\.]/g, '').replace(',', '.');
  // Se ha punto come separatore migliaia: 127.000 → 127000
  const cleaned = s.replace(/\.(?=\d{3}(?:\.|$))/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

// ── Rileva tipo immobile dalla categoria catastale o titolo ──────────────────
function detectTipo(raw = '') {
  const s = raw.toLowerCase();
  if (s.includes('a/2') || s.includes('a/3') || s.includes('a/4') || s.includes('appartam') || s.includes('abitaz')) return 'apt';
  if (s.includes('a/7') || s.includes('a/8') || s.includes('villa') || s.includes('unifamiliare') || s.includes('casa indipend')) return 'villa';
  if (s.includes('c/1') || s.includes('c/3') || s.includes('commerciale') || s.includes('negozio') || s.includes('ufficio') || s.includes('d/')) return 'comm';
  if (s.includes('c/6') || s.includes('box') || s.includes('garage') || s.includes('autorimessa')) return 'box';
  if (s.includes('terreno') || s.includes('a/10') || s.includes('b/')) return 'land';
  return 'apt';
}

// ── Calcola livello di rischio ────────────────────────────────────────────────
function detectRischio({ astaN = 1, stato = '', titolo = '', catEl = '' } = {}) {
  const s = (stato + ' ' + titolo).toLowerCase();
  if (
    astaN >= 3 ||
    s.includes('occup') && (s.includes('iniquilin') || s.includes('proprietari')) ||
    s.includes('vincolo') ||
    s.includes('abuso') ||
    s.includes('difformit')
  ) return 'high';
  if (astaN === 2 || s.includes('occup') || s.includes('da verificare') || s.includes('arretr')) return 'med';
  return 'low';
}

// ── Regione da sigla provincia ────────────────────────────────────────────────
const PROV_REGIONE = {
  MI:'Lombardia',MB:'Lombardia',BG:'Lombardia',BS:'Lombardia',MN:'Lombardia',
  PV:'Lombardia',CR:'Lombardia',LO:'Lombardia',LC:'Lombardia',SO:'Lombardia',VA:'Lombardia',CO:'Lombardia',
  RM:'Lazio',VT:'Lazio',RI:'Lazio',LT:'Lazio',FR:'Lazio',
  NA:'Campania',SA:'Campania',AV:'Campania',BN:'Campania',CE:'Campania',
  VE:'Veneto',VR:'Veneto',PD:'Veneto',VI:'Veneto',TV:'Veneto',RO:'Veneto',BL:'Veneto',
  FI:'Toscana',SI:'Toscana',AR:'Toscana',GR:'Toscana',LI:'Toscana',LU:'Toscana',MS:'Toscana',PI:'Toscana',PT:'Toscana',PO:'Toscana',
  PA:'Sicilia',CT:'Sicilia',ME:'Sicilia',AG:'Sicilia',CL:'Sicilia',EN:'Sicilia',RG:'Sicilia',SR:'Sicilia',TP:'Sicilia',
  TO:'Piemonte',AL:'Piemonte',AT:'Piemonte',BI:'Piemonte',CN:'Piemonte',NO:'Piemonte',VB:'Piemonte',VC:'Piemonte',
  BO:'Emilia-Romagna',MO:'Emilia-Romagna',RE:'Emilia-Romagna',PR:'Emilia-Romagna',PC:'Emilia-Romagna',FE:'Emilia-Romagna',RA:'Emilia-Romagna',FC:'Emilia-Romagna',RN:'Emilia-Romagna',
  BA:'Puglia',BR:'Puglia',FG:'Puglia',LE:'Puglia',TA:'Puglia',BT:'Puglia',
  GE:'Liguria',IM:'Liguria',SP:'Liguria',SV:'Liguria',
  AN:'Marche',AP:'Marche',FM:'Marche',MC:'Marche',PU:'Marche',
  AQ:'Abruzzo',CH:'Abruzzo',PE:'Abruzzo',TE:'Abruzzo',
  PG:'Umbria',TR:'Umbria',
  CB:'Molise',IS:'Molise',
  PZ:'Basilicata',MT:'Basilicata',
  CZ:'Calabria',CS:'Calabria',KR:'Calabria',RC:'Calabria',VV:'Calabria',
  CA:'Sardegna',CI:'Sardegna',MD:'Sardegna',NU:'Sardegna',OG:'Sardegna',OR:'Sardegna',OT:'Sardegna',SS:'Sardegna',VS:'Sardegna',
  BZ:'Trentino-Alto Adige',TN:'Trentino-Alto Adige',
  AO:'Valle d\'Aosta',
  TS:'Friuli-Venezia Giulia',UD:'Friuli-Venezia Giulia',GO:'Friuli-Venezia Giulia',PN:'Friuli-Venezia Giulia',
};

function regioneFromProvincia(prov = '') {
  return PROV_REGIONE[prov.trim().toUpperCase()] || '';
}

// ── Genera summary leggibile ──────────────────────────────────────────────────
function buildSummary({ titolo, citta, prezzo, mercato, astaN, stato }) {
  const eur = (n) => n ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n) : '—';
  const parts = [];
  if (astaN > 1) parts.push(`${astaN}ª asta`);
  if (stato && stato.toLowerCase().includes('libero')) parts.push('immobile libero');
  else if (stato && stato.toLowerCase().includes('occup')) parts.push('⚠ immobile occupato');
  if (mercato && prezzo) {
    const pct = Math.round((1 - prezzo / mercato) * 100);
    if (pct > 5) parts.push(`risparmio stimato ${pct}% (mercato ${eur(mercato)})`);
  }
  const base = titolo.slice(0, 80) + (citta ? ` — ${citta}` : '');
  return base + (parts.length ? '. ' + parts.join(', ') + '.' : '.');
}

module.exports = {
  sleep,
  randomDelay,
  generateId,
  normalizePrezzo,
  detectTipo,
  detectRischio,
  regioneFromProvincia,
  buildSummary,
};
