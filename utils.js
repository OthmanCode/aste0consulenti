'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min)) + min;
const generateId = codice => codice.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase().slice(0, 40);

function normalizePrezzo(raw) {
  if (!raw) return null;
  const s = raw.replace(/[^\d,\.]/g, '');
  const cleaned = s.replace(/\.(?=\d{3}(?:\.|,|$))/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

function detectTipo(raw) {
  if (!raw) return 'apt';
  const s = raw.toLowerCase();
  if (s.includes('a/7') || s.includes('a/8') || s.includes('villa') || s.includes('unifamiliare')) return 'villa';
  if (s.includes('c/1') || s.includes('c/3') || s.includes('commerciale') || s.includes('negozio') || s.includes('ufficio')) return 'comm';
  if (s.includes('c/6') || s.includes('box') || s.includes('garage') || s.includes('posto auto')) return 'box';
  if (s.includes('terreno') || s.includes('fondo rustico')) return 'land';
  return 'apt';
}

function detectRischio(opts) {
  const astaN = opts.astaN || 1;
  const stato = opts.stato || '';
  const titolo = opts.titolo || '';
  const s = (stato + ' ' + titolo).toLowerCase();
  if (astaN >= 3 || (s.includes('occup') && s.includes('proprietari')) || s.includes('abuso') || s.includes('vincolo')) return 'high';
  if (astaN === 2 || s.includes('occup') || s.includes('da verificare')) return 'med';
  return 'low';
}

const PROV_REGIONE = {
  MI:'Lombardia',MB:'Lombardia',BG:'Lombardia',BS:'Lombardia',MN:'Lombardia',PV:'Lombardia',CR:'Lombardia',LO:'Lombardia',LC:'Lombardia',SO:'Lombardia',VA:'Lombardia',CO:'Lombardia',
  RM:'Lazio',VT:'Lazio',RI:'Lazio',LT:'Lazio',FR:'Lazio',
  NA:'Campania',SA:'Campania',AV:'Campania',BN:'Campania',CE:'Campania',
  VE:'Veneto',VR:'Veneto',PD:'Veneto',VI:'Veneto',TV:'Veneto',RO:'Veneto',BL:'Veneto',
  FI:'Toscana',SI:'Toscana',AR:'Toscana',GR:'Toscana',LI:'Toscana',LU:'Toscana',PI:'Toscana',PT:'Toscana',PO:'Toscana',
  PA:'Sicilia',CT:'Sicilia',ME:'Sicilia',AG:'Sicilia',CL:'Sicilia',EN:'Sicilia',RG:'Sicilia',SR:'Sicilia',TP:'Sicilia',
  TO:'Piemonte',AL:'Piemonte',AT:'Piemonte',CN:'Piemonte',NO:'Piemonte',VC:'Piemonte',BI:'Piemonte',
  BO:'Emilia-Romagna',MO:'Emilia-Romagna',RE:'Emilia-Romagna',PR:'Emilia-Romagna',FE:'Emilia-Romagna',RA:'Emilia-Romagna',RN:'Emilia-Romagna',
  BA:'Puglia',BR:'Puglia',FG:'Puglia',LE:'Puglia',TA:'Puglia',BT:'Puglia',
  GE:'Liguria',SP:'Liguria',SV:'Liguria',IM:'Liguria',
  AN:'Marche',MC:'Marche',PU:'Marche',AP:'Marche',FM:'Marche',
  PG:'Umbria',TR:'Umbria',
  CA:'Sardegna',SS:'Sardegna',NU:'Sardegna',OR:'Sardegna',
  BZ:'Trentino-Alto Adige',TN:'Trentino-Alto Adige',
  AQ:'Abruzzo',CH:'Abruzzo',PE:'Abruzzo',TE:'Abruzzo',
  CB:'Molise',IS:'Molise',
  PZ:'Basilicata',MT:'Basilicata',
  CZ:'Calabria',CS:'Calabria',KR:'Calabria',RC:'Calabria',VV:'Calabria',
  TS:'Friuli-Venezia Giulia',UD:'Friuli-Venezia Giulia',GO:'Friuli-Venezia Giulia',PN:'Friuli-Venezia Giulia',
  AO:'Valle d\'Aosta',
};

function regioneFromProvincia(prov) {
  if (!prov) return '';
  return PROV_REGIONE[prov.trim().toUpperCase()] || '';
}

function buildSummary(opts) {
  const titolo = opts.titolo || '';
  const citta = opts.citta || '';
  const prezzo = opts.prezzo;
  const mercato = opts.mercato;
  const astaN = opts.astaN || 1;
  const stato = opts.stato || '';
  const eur = n => n ? new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n) : '';
  const parts = [];
  if (astaN > 1) parts.push(astaN + 'a asta');
  if (stato && stato.toLowerCase().includes('libero')) parts.push('immobile libero');
  else if (stato && stato.toLowerCase().includes('occup')) parts.push('immobile occupato');
  if (mercato && prezzo) {
    const pct = Math.round((1 - prezzo / mercato) * 100);
    if (pct > 5) parts.push('risparmio stimato ' + pct + '%');
  }
  return titolo.slice(0, 80) + (citta ? ' - ' + citta : '') + (parts.length ? '. ' + parts.join(', ') + '.' : '.');
}

function buildRischi(opts) {
  const astaN = opts.astaN || 1;
  const stato = opts.stato || '';
  const prezzo = opts.prezzo;
  const mercato = opts.mercato;
  const eur = n => n ? new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n) : '';
  const rischi = [];
  if (astaN > 1) {
    rischi.push({ tipo: 'warn', titolo: astaN + 'a asta - prezzo ridotto', testo: 'Questa e la ' + astaN + 'a asta consecutiva. Approfondisci con il custode perche le precedenti sono andate deserte.' });
  }
  const sl = stato.toLowerCase();
  if (sl.includes('occup')) {
    rischi.push({ tipo: 'danger', titolo: 'Immobile occupato', testo: 'Verifica con il custode i tempi di liberazione. Possono richiedere 6-24 mesi.' });
  } else {
    rischi.push({ tipo: 'safe', titolo: 'Stato: da confermare', testo: 'Conferma sempre con il custode e richiedi un sopralluogo prima dell\'asta.' });
  }
  if (prezzo && mercato && mercato > prezzo) {
    const pct = Math.round((1 - prezzo / mercato) * 100);
    rischi.push({ tipo: 'info', titolo: 'Risparmio potenziale: -' + pct + '%', testo: 'Prezzo base inferiore del ' + pct + '% rispetto alla stima di mercato (' + eur(mercato) + '). Includi sempre imposte e spese nel calcolo finale.' });
  }
  rischi.push({ tipo: 'info', titolo: 'Caparra: 10% del prezzo base', testo: 'La caparra e persa se vinci ma non completi l\'acquisto. Assicurati di avere la pre-approvazione del mutuo.' });
  return rischi;
}

function buildPassi(opts) {
  const tribunale = opts.tribunale || 'tribunale competente';
  const caparra = opts.caparra;
  const scadenza = opts.scadenza;
  const eur = n => n ? new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n) : '10% del prezzo base';
  return [
    { t: 'Contatta il custode giudiziario', d: 'Chiama il custode del ' + tribunale + ' per prenotare una visita. Chiedi: libero o occupato? Spese condominiali arretrate? Abusi in perizia?' },
    { t: 'Scarica e analizza la perizia', d: 'Scarica la perizia dal portale del tribunale. Caricala su AstaChiara per l\'analisi AI automatica.' },
    { t: 'Calcola il costo totale reale', d: 'Al prezzo base aggiungi: imposte (2% prima casa, 9% seconda), onorari delegato (~1%), spese procedura (~1.800 euro), eventuali lavori.' },
    { t: 'Pre-approva il mutuo', d: 'Contatta la tua banca per una pre-delibera prima di partecipare. Senza liquidita certa, non depositare la caparra.' },
    { t: 'Presenta offerta entro ' + (scadenza || 'la scadenza indicata'), d: 'Deposita la caparra (' + eur(caparra) + ') tramite bonifico e invia la tua offerta online.' },
  ];
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
  buildRischi,
  buildPassi,
};
