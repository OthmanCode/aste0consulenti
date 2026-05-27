'use strict';
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const db       = require('./db');
const { runScraper } = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET'],
}));
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseAsta(row) {
  if (!row) return null;
  return {
    ...row,
    rischi: safeJson(row.rischi_json, []),
    passi:  safeJson(row.passi_json,  []),
    rischi_json: undefined,
    passi_json:  undefined,
    raw_html:    undefined,
  };
}

function safeJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── GET /api/aste ─────────────────────────────────────────────────────────────
// Params: citta, regione, tipo, rischio, prezzoMin, prezzoMax, q, sort, limit, offset
app.get('/api/aste', (req, res) => {
  try {
    const { citta, regione, tipo, rischio, prezzoMin, prezzoMax, q, sort, limit = '48', offset = '0' } = req.query;
    const params = { citta, regione, tipo, rischio, prezzoMin, prezzoMax, q, sort, limit, offset };
    const rows  = db.listAste(params);
    const total = db.countAste(params);
    res.json({
      ok:    true,
      total,
      limit: Number(limit),
      offset: Number(offset),
      aste:  rows.map(parseAsta),
    });
  } catch (err) {
    console.error('/api/aste error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/aste/:codice ─────────────────────────────────────────────────────
app.get('/api/aste/:codice', (req, res) => {
  try {
    const row = db.getAsta(req.params.codice);
    if (!row) return res.status(404).json({ ok: false, error: 'Asta non trovata' });
    res.json({ ok: true, asta: parseAsta(row) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getStats();
    const last  = db.getLastLog();
    res.json({ ok: true, stats, last_scraping: last });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── POST /api/scrape (trigger manuale, protetto da secret) ───────────────────
app.post('/api/scrape', express.json(), (req, res) => {
  const secret = process.env.SCRAPE_SECRET;
  if (secret && req.headers['x-scrape-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  res.json({ ok: true, message: 'Scraping avviato in background' });
  // Non aspettiamo il risultato
  runScraper({ once: true }).catch(e => console.error('Manual scrape error:', e));
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ AstaChiara API in ascolto su http://localhost:${PORT}`);
  scheduleScraper();
});

// ── Scheduler cron ────────────────────────────────────────────────────────────
function scheduleScraper() {
  // Ogni 6 ore: 0:00, 6:00, 12:00, 18:00
  const schedule = process.env.CRON_SCHEDULE || '0 */6 * * *';
  cron.schedule(schedule, () => {
    console.log(`[CRON ${new Date().toISOString()}] Avvio scraping programmato`);
    runScraper({ once: true }).catch(e => console.error('Cron scrape error:', e));
  }, { timezone: 'Europe/Rome' });

  // Primo avvio subito all'avvio del server (solo se DB è vuoto)
  const stats = db.getStats();
  if (!stats || stats.totale === 0) {
    console.log('DB vuoto — avvio primo scraping immediato...');
    setTimeout(() => {
      runScraper({ once: true }).catch(e => console.error('First run error:', e));
    }, 3000);
  } else {
    console.log(`DB ha già ${stats.totale} aste. Prossimo scraping: ${schedule}`);
  }
}

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
