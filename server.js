'use strict';
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const db      = require('./db');
const { runScraper, analizzaTutteLePerizie } = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

function parseRow(r) {
  if (!r) return null;
  const safe = s => { try { return JSON.parse(s); } catch { return []; } };
  return {
    ...r,
    rischi: safe(r.rischi_json),
    passi: safe(r.passi_json),
    rischi_json: undefined,
    passi_json: undefined,
    // Mappa i campi flat del DB nei blocchi oggetto usati dal frontend
    proprieta: {
      stato: r.proprieta_stato || 'unk',
      label: r.proprieta_label || 'Da verificare',
      dettaglio: r.proprieta_dettaglio || 'Scaricare la perizia per verificare.',
    },
    occupazione: {
      stato: r.occupazione_stato || 'unk',
      label: r.occupazione_label || 'Da verificare',
      dettaglio: r.occupazione_dettaglio || 'Contattare il custode giudiziario.',
    },
    abusi: {
      stato: r.abusi_stato || 'unk',
      label: r.abusi_label || 'Da verificare',
      dettaglio: r.abusi_dettaglio || 'Verificare nella perizia.',
    },
    sanatoria: {
      stato: r.sanatoria_stato || 'unk',
      label: r.sanatoria_label || 'Da verificare',
      dettaglio: r.sanatoria_dettaglio || 'Verificare nella perizia.',
    },
    affitto: r.affitto_canone ? {
      canone: r.affitto_canone,
      scadenza: r.affitto_scadenza,
      tipo: r.affitto_tipo,
      rendimento: r.prezzo ? parseFloat(((r.affitto_canone * 12 / r.prezzo) * 100).toFixed(1)) : null,
    } : null,
  };
}

app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/stats', (_, res) => {
  try { res.json({ ok: true, stats: db.getStats() }); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/aste', (req, res) => {
  try {
    const { citta, regione, tipo, rischio, prezzoMin, prezzoMax, q, sort, limit='48', offset='0' } = req.query;
    const { rows, total } = db.listAste({ citta, regione, tipo, rischio, prezzoMin, prezzoMax, q, sort, limit, offset });
    res.json({ ok: true, total, aste: rows.map(parseRow) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/aste/:codice', (req, res) => {
  try {
    const row = db.getAsta(req.params.codice);
    if (!row) return res.status(404).json({ ok: false, error: 'Non trovata' });
    res.json({ ok: true, asta: parseRow(row) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/scrape', (req, res) => {
  const secret = process.env.SCRAPE_SECRET;
  if (secret && req.headers['x-scrape-secret'] !== secret)
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  res.json({ ok: true, message: 'Scraping avviato' });
  runScraper().catch(e => console.error('Manual scrape error:', e));
});

// Trigger manuale analisi perizie
app.post('/api/analizza', (req, res) => {
  const secret = process.env.SCRAPE_SECRET;
  if (secret && req.headers['x-scrape-secret'] !== secret)
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  res.json({ ok: true, message: 'Analisi perizie avviata' });
  analizzaTutteLePerizie().catch(e => console.error('Analisi error:', e));
});

app.listen(PORT, () => {
  console.log('AstaChiara API attiva su porta ' + PORT);

  const schedule = process.env.CRON_SCHEDULE || '0 */6 * * *';
  cron.schedule(schedule, () => {
    console.log('[CRON] Scraping programmato');
    runScraper().catch(e => console.error('Cron error:', e));
  }, { timezone: 'Europe/Rome' });

  const stats = db.getStats();
  if (!stats || stats.totale === 0) {
    console.log('DB vuoto - avvio scraping tra 5 secondi...');
    setTimeout(() => runScraper().catch(e => console.error(e)), 5000);
  } else {
    console.log('DB ha ' + stats.totale + ' aste - avvio analisi perizie in background...');
    // Analizza le perizie già raccolte
    setTimeout(() => analizzaTutteLePerizie().catch(e => console.error(e)), 5000);
  }
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
