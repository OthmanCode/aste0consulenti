'use strict';
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const https   = require('https');
const db      = require('./db');
const { runScraper, analizzaTutteLePerizie } = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 8080;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json({ limit: '20mb' }));

function parseRow(r) {
  if (!r) return null;
  const safe = s => { try { return JSON.parse(s); } catch { return []; } };
  return {
    ...r,
    rischi: safe(r.rischi_json),
    passi: safe(r.passi_json),
    rischi_json: undefined,
    passi_json: undefined,
    proprieta: {
      stato: r.proprieta_stato || 'unk',
      label: r.proprieta_label || 'Da verificare',
      dettaglio: r.proprieta_dettaglio || 'Scarica la perizia per verificare.',
    },
    occupazione: {
      stato: r.occupazione_stato || 'unk',
      label: r.occupazione_label || 'Da verificare',
      dettaglio: r.occupazione_dettaglio || 'Contatta il custode giudiziario.',
    },
    abusi: {
      stato: r.abusi_stato || 'unk',
      label: r.abusi_label || 'Da verificare',
      dettaglio: r.abusi_dettaglio || 'Verifica nella perizia.',
    },
    sanatoria: {
      stato: r.sanatoria_stato || 'unk',
      label: r.sanatoria_label || 'Da verificare',
      dettaglio: r.sanatoria_dettaglio || 'Verifica nella perizia.',
    },
    affitto: r.affitto_canone ? {
      canone: r.affitto_canone,
      scadenza: r.affitto_scadenza,
      tipo: r.affitto_tipo,
      rendimento: r.prezzo ? parseFloat(((r.affitto_canone * 12 / r.prezzo) * 100).toFixed(1)) : null,
    } : null,
  };
}

// ── Helper: chiama Anthropic dal server ───────────────────────────────────────
function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_KEY) return reject(new Error('ANTHROPIC_API_KEY non configurata sul server'));
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ── API ROUTES ─────────────────────────────────────────────────────────────────

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

// ── PROXY AI — il frontend chiama questo, la chiave resta sul server ──────────
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { messages, system, max_tokens } = req.body;
    if (!messages) return res.status(400).json({ ok: false, error: 'messages richiesto' });
    const result = await callAnthropic({
      model: 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 900,
      system: system || 'Sei AstaChiara AI, esperto di aste immobiliari italiane. Parla in italiano semplice e diretto.',
      messages,
    });
    if (result.error) return res.status(500).json({ ok: false, error: result.error.message });
    res.json({ ok: true, content: result.content });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── PROXY AI — analisi documento (PDF/immagine) ───────────────────────────────
app.post('/api/ai/document', async (req, res) => {
  try {
    const { base64, media_type, prompt } = req.body;
    if (!base64 || !media_type) return res.status(400).json({ ok: false, error: 'base64 e media_type richiesti' });
    const isImage = media_type.startsWith('image/');
    const content = isImage
      ? [{ type: 'image', source: { type: 'base64', media_type, data: base64 } }, { type: 'text', text: prompt }]
      : [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, { type: 'text', text: prompt }];
    const result = await callAnthropic({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1400,
      messages: [{ role: 'user', content }],
    });
    if (result.error) return res.status(500).json({ ok: false, error: result.error.message });
    res.json({ ok: true, content: result.content });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/scrape', (req, res) => {
  const secret = process.env.SCRAPE_SECRET;
  if (secret && req.headers['x-scrape-secret'] !== secret)
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  res.json({ ok: true, message: 'Scraping avviato' });
  runScraper().catch(e => console.error('Scrape error:', e));
});

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
    console.log('DB ha ' + stats.totale + ' aste - avvio analisi perizie...');
    setTimeout(() => analizzaTutteLePerizie().catch(e => console.error(e)), 5000);
  }
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
