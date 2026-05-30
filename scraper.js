'use strict';
require('dotenv').config();
const { chromium } = require('playwright');
const https = require('https');
const http  = require('http');
const db = require('./db');
const {
  sleep, randomDelay, generateId, normalizePrezzo,
  detectTipo, detectRischio, regioneFromProvincia,
  buildSummary, buildRischi, buildPassi
} = require('./utils');

const MAX_PAGINE      = parseInt(process.env.MAX_PAGINE      || '30');
const DELAY_MIN       = parseInt(process.env.DELAY_MIN_MS    || '3000');
const DELAY_MAX       = parseInt(process.env.DELAY_MAX_MS    || '6000');
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY        || '';

// ── Scarica un file come Buffer ────────────────────────────────────────────────
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*',
      },
      timeout: 30000,
    }, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout download')); });
  });
}

// ── Analizza perizia PDF con Claude ───────────────────────────────────────────
async function analizzaPerizia(pdfBuffer, infoAsta) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY non configurata');

  const base64 = pdfBuffer.toString('base64');
  const prompt = `Sei un esperto di aste immobiliari italiane. Analizza questa perizia giudiziaria e rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo.

Il JSON deve avere esattamente questa struttura:
{
  "proprieta": {
    "stato": "ok|warn|bad|unk",
    "label": "testo breve (es: Piena proprietà)",
    "dettaglio": "spiegazione in italiano semplice, max 2 righe"
  },
  "occupazione": {
    "stato": "ok|warn|bad|unk",
    "label": "testo breve (es: Libero, Inquilino presente, Proprietario occupante)",
    "dettaglio": "spiegazione con dettagli pratici: chi c'è, fino a quando, cosa significa per l'acquirente"
  },
  "abusi": {
    "stato": "ok|warn|bad|unk",
    "label": "testo breve (es: Nessun abuso, Difformità sanabile, Abuso grave)",
    "dettaglio": "descrizione precisa dell'abuso se presente, costo stimato sanatoria se sanabile"
  },
  "sanatoria": {
    "stato": "ok|warn|bad|unk",
    "label": "testo breve (es: Nessuna, Ottenuta, Pendente, Non ottenibile)",
    "dettaglio": "stato delle pratiche, cosa deve fare l'acquirente"
  },
  "affitto": {
    "presente": true|false,
    "canone": numero o null,
    "scadenza": "data o null",
    "tipo": "tipo contratto o null"
  },
  "rischio_globale": "low|med|high",
  "alert_principale": "la cosa più importante che l'acquirente DEVE sapere, max 1 frase"
}

Regole per i stati:
- "ok" = nessun problema
- "warn" = attenzione ma risolvibile
- "bad" = problema grave
- "unk" = non determinabile dalla perizia

Contesto immobile: ${infoAsta}`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [{
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 }
      }, {
        type: 'text',
        text: prompt
      }]
    }]
  });

  return new Promise((resolve, reject) => {
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
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.content?.[0]?.text || '';
          // Estrai JSON dalla risposta
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return reject(new Error('Nessun JSON nella risposta'));
          const result = JSON.parse(jsonMatch[0]);
          resolve(result);
        } catch (e) {
          reject(new Error('Parse errore: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout API')); });
    req.write(body);
    req.end();
  });
}

// ── Analisi testuale senza PDF (da dati scraping) ─────────────────────────────
async function analizzaSenzaPDF(asta) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY non configurata');

  const info = [
    'Titolo: ' + asta.titolo,
    'Prezzo base: ' + (asta.prezzo || 'n.d.'),
    'Tribunale: ' + (asta.tribunale || 'n.d.'),
    'Numero asta: ' + (asta.asta_n || 1),
    'Stato occupazione (da scraping): ' + (asta.stato || 'non indicato'),
    'Scadenza: ' + (asta.scadenza || 'n.d.'),
  ].join('\n');

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Sei un esperto di aste immobiliari italiane. Basandoti sui dati disponibili di questa asta, fornisci una valutazione prudente. Rispondi SOLO con JSON valido senza testo prima o dopo.

Dati asta:
${info}

Rispondi con questo JSON esatto:
{
  "proprieta": {"stato":"unk","label":"Da verificare in perizia","dettaglio":"Scaricare la perizia dal sito del tribunale per verificare il tipo di proprieta e l'assenza di comproprietari."},
  "occupazione": {"stato":"unk","label":"${asta.stato || 'Da verificare'}","dettaglio":"Contattare il custode giudiziario per confermare lo stato attuale dell'immobile prima di fare offerta."},
  "abusi": {"stato":"unk","label":"Da verificare in perizia","dettaglio":"Verificare nella perizia la conformita urbanistica e catastale. Cercare le parole: difformita, abuso, sanatoria, condono."},
  "sanatoria": {"stato":"unk","label":"Da verificare","dettaglio":"Verificare nella perizia se esistono pratiche di condono o sanatoria aperte che passerebbero al nuovo proprietario."},
  "affitto": {"presente":${asta.stato && asta.stato.toLowerCase().includes('inquilin') ? 'true' : 'false'},"canone":null,"scadenza":null,"tipo":null},
  "rischio_globale":"${asta.asta_n >= 3 ? 'high' : asta.asta_n >= 2 ? 'med' : 'low'}",
  "alert_principale":"Perizia non ancora analizzata. Scaricare il PDF perizia e caricarlo su AstaChiara per l'analisi completa."
}`
    }]
  });

  return new Promise((resolve, reject) => {
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
      timeout: 30000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.content?.[0]?.text || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return reject(new Error('Nessun JSON'));
          resolve(JSON.parse(jsonMatch[0]));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Processa analisi AI e salva nel DB ────────────────────────────────────────
async function processaAnalisi(asta, analisi) {
  const rischioMap = { low: 'low', med: 'med', high: 'high' };
  return db.updatePerizia(asta.codice, {
    proprieta_stato:     analisi.proprieta?.stato     || 'unk',
    proprieta_label:     analisi.proprieta?.label     || 'Da verificare',
    proprieta_dettaglio: analisi.proprieta?.dettaglio || '',
    occupazione_stato:     analisi.occupazione?.stato     || 'unk',
    occupazione_label:     analisi.occupazione?.label     || 'Da verificare',
    occupazione_dettaglio: analisi.occupazione?.dettaglio || '',
    abusi_stato:     analisi.abusi?.stato     || 'unk',
    abusi_label:     analisi.abusi?.label     || 'Da verificare',
    abusi_dettaglio: analisi.abusi?.dettaglio || '',
    sanatoria_stato:     analisi.sanatoria?.stato     || 'unk',
    sanatoria_label:     analisi.sanatoria?.label     || 'Da verificare',
    sanatoria_dettaglio: analisi.sanatoria?.dettaglio || '',
    affitto_canone:   analisi.affitto?.canone   || null,
    affitto_scadenza: analisi.affitto?.scadenza || null,
    affitto_tipo:     analisi.affitto?.tipo     || null,
    rischio: rischioMap[analisi.rischio_globale] || 'med',
  });
}

// ── Ciclo analisi perizie in background ───────────────────────────────────────
async function analizzaTutteLePerizie() {
  if (!ANTHROPIC_KEY) {
    console.log('[PERIZIE] ANTHROPIC_API_KEY non configurata - salto analisi');
    return;
  }
  console.log('[PERIZIE] Inizio analisi perizie...');
  let analizzate = 0, errori = 0;

  // Prima: aste con URL perizia (analisi PDF reale)
  const asteConPDF = db.getAste_senzaPerizia(30);
  console.log('[PERIZIE] ' + asteConPDF.length + ' aste con perizia PDF da analizzare');

  for (const asta of asteConPDF) {
    try {
      console.log('[PERIZIE] Download perizia: ' + asta.codice);
      const pdfBuffer = await downloadBuffer(asta.url_perizia);
      if (pdfBuffer.length < 1000) throw new Error('PDF troppo piccolo o non valido');

      const infoAsta = 'Codice: ' + asta.codice + ', Prezzo: ' + asta.prezzo + ', Tribunale: ' + asta.tribunale + ', ' + asta.asta_n + ' asta, Stato: ' + asta.stato;
      const analisi = await analizzaPerizia(pdfBuffer, infoAsta);
      await processaAnalisi(asta, analisi);
      analizzate++;
      console.log('[PERIZIE] OK: ' + asta.codice + ' - ' + (analisi.alert_principale || ''));
      await sleep(2000); // pausa tra chiamate API
    } catch (e) {
      errori++;
      console.error('[PERIZIE] Errore PDF ' + asta.codice + ': ' + e.message);
      // Fallback: analisi testuale
      try {
        const analisi = await analizzaSenzaPDF(asta);
        await processaAnalisi(asta, analisi);
        analizzate++;
      } catch(e2) {
        console.error('[PERIZIE] Errore fallback ' + asta.codice + ': ' + e2.message);
      }
    }
  }

  // Poi: aste senza URL perizia (analisi testuale)
  const asteSenzaPDF = db.getAste_senzaPerizia_noPDF(50);
  console.log('[PERIZIE] ' + asteSenzaPDF.length + ' aste senza PDF da analizzare testualmente');

  for (const asta of asteSenzaPDF) {
    try {
      const analisi = await analizzaSenzaPDF(asta);
      await processaAnalisi(asta, analisi);
      analizzate++;
      await sleep(1000);
    } catch(e) {
      errori++;
      console.error('[PERIZIE] Errore testuale ' + asta.codice + ': ' + e.message);
    }
  }

  console.log('[PERIZIE] Fine: ' + analizzate + ' analizzate, ' + errori + ' errori');
}

// ── Scraping principale ────────────────────────────────────────────────────────
async function runScraper() {
  const t0 = Date.now();
  console.log('[' + new Date().toISOString() + '] Avvio scraping...');
  let totale = 0, nuove = 0, aggiornate = 0, errori = 0;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'it-IT',
      timezoneId: 'Europe/Rome',
      extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9' },
    });
    await ctx.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,otf,eot}', r => r.abort());
    const page = await ctx.newPage();

    for (let p = 1; p <= MAX_PAGINE; p++) {
      const url = p === 1
        ? 'https://www.astalegale.net/Immobili'
        : 'https://www.astalegale.net/Immobili?pagina=' + p;

      console.log('  Pagina ' + p + '/' + MAX_PAGINE);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(3000);
      } catch (e) { errori++; continue; }

      let links = [];
      const sels = [
        'a[href*="/Aste/Detail/"]', 'a[href*="/aste/detail/"]',
        'a[href*="Detail"]', '.card a', 'h2 a', 'h3 a',
        '[class*="asta"] a', '.list-group-item a',
      ];
      for (const sel of sels) {
        try {
          const found = await page.$$eval(sel, els =>
            [...new Set(els.map(e => e.href).filter(h =>
              h && h.includes('astalegale.net') &&
              (h.includes('/Aste/') || h.includes('Detail')) && h.length > 50
            ))]
          );
          if (found.length > 0) links = [...new Set([...links, ...found])];
        } catch(_) {}
      }

      if (links.length === 0) {
        const body = await page.$eval('body', el => el.innerText.slice(0, 200)).catch(() => '');
        console.log('  No links. Body: ' + body.replace(/\s+/g,' '));
        if (p === 1) break;
        break;
      }

      console.log('  Trovati ' + links.length + ' link');

      for (const link of links.slice(0, 50)) {
        try {
          const asta = await scrapeDetail(page, link);
          if (asta) {
            const existing = db.getAsta(asta.codice);
            db.upsertAsta(asta);
            if (!existing) { nuove++; console.log('  NUOVA: ' + asta.titolo.slice(0, 60)); }
            else aggiornate++;
            totale++;
          }
          await sleep(randomDelay(DELAY_MIN, DELAY_MAX));
        } catch (err) {
          errori++;
          console.error('  Errore ' + link + ': ' + err.message);
          await sleep(1000);
        }
      }
      await sleep(randomDelay(DELAY_MIN, DELAY_MAX));
    }
    await ctx.close();
  } catch(e) {
    console.error('Errore fatale: ' + e.message);
  } finally {
    await browser.close();
  }

  const durata = Date.now() - t0;
  db.logScraping({ totale, nuove, aggiornate, errori, durata_ms: durata });
  console.log('[' + new Date().toISOString() + '] Scraping fine: ' + nuove + ' nuove, ' + aggiornate + ' aggiornate');

  // Dopo lo scraping, analizza le perizie in background
  analizzaTutteLePerizie().catch(e => console.error('[PERIZIE] Errore:', e.message));
}

async function scrapeDetail(page, link) {
  try {
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(800);
  } catch(e) { throw new Error('Timeout: ' + e.message); }

  const urlParts = link.split('/');
  const lastPart = urlParts[urlParts.length - 1] || '';
  const codiceMatch = lastPart.match(/([A-Z]{1,3}\d{5,})/i);
  const codice = codiceMatch ? codiceMatch[1].toUpperCase() : lastPart.split('-')[0].slice(0, 20);
  if (!codice || codice.length < 4) return null;

  const get = async (sels) => {
    for (const s of sels) {
      try {
        const el = await page.$(s);
        if (el) { const t = (await el.textContent()).trim(); if (t) return t; }
      } catch(_) {}
    }
    return null;
  };

  const titolo = await get(['h1','h2.titolo','.detail-title','.page-title','[class*="titolo"]'])
    || lastPart.replace(/-/g,' ').slice(0, 120);

  const prezzoRaw = await get([
    '.prezzo-base strong','.prezzo strong','[class*="prezzo"] strong',
    '[class*="prezzo"]','.base-price','td:has-text("Prezzo base") + td',
    'td:has-text("Prezzo") + td','.importo',
  ]);
  const prezzo = normalizePrezzo(prezzoRaw);
  if (!prezzo) return null;

  const tribunale   = await get(['td:has-text("Tribunale") + td','.tribunale','[class*="tribunale"]']);
  const dataAsta    = await get(['td:has-text("Data") + td','.data-asta','[class*="data-vendita"]']);
  const mqRaw       = await get(['td:has-text("Superficie") + td','.superficie','[class*="mq"]']);
  const stato       = await get(['td:has-text("Occupazione") + td','.occupazione','[class*="occup"]','td:has-text("Stato") + td']) || 'Da verificare';
  const catEl       = await get(['td:has-text("Categoria catastale") + td','td:has-text("Categoria") + td','[class*="categoria"]']);
  const indirizzoEl = await get(['.indirizzo','[class*="address"]','td:has-text("Indirizzo") + td','.localita','td:has-text("Comune") + td']);
  const scadRaw     = await get(['td:has-text("Scadenza") + td','.scadenza']);
  const rialzoRaw   = await get(['td:has-text("Rialzo") + td','.rialzo-minimo']);
  const mercatoRaw  = await get(['td:has-text("Valore stimato") + td','td:has-text("Valore di mercato") + td']);
  const caparraRaw  = await get(['td:has-text("Cauzione") + td','.cauzione','td:has-text("Caparra") + td']);
  const astaNumRaw  = await get(['.numero-asta','td:has-text("Esperimento") + td','td:has-text("N. vendita") + td']);

  let citta = '', provincia = '', regione = '';
  if (indirizzoEl) {
    const mProv = indirizzoEl.match(/\(([A-Z]{2})\)/);
    if (mProv) provincia = mProv[1];
    const parts = indirizzoEl.split(',');
    citta = parts.length >= 2
      ? parts[parts.length - 2].trim().replace(/\([A-Z]{2}\)/,'').trim()
      : indirizzoEl.replace(/\([A-Z]{2}\)/,'').trim().slice(0,50);
    regione = regioneFromProvincia(provincia);
  }

  const mercato = normalizePrezzo(mercatoRaw) || Math.round(prezzo * 1.55);
  const caparra = normalizePrezzo(caparraRaw) || Math.round(prezzo * 0.1);
  const astaN   = parseInt(astaNumRaw) || 1;
  const tipo    = detectTipo(catEl || titolo);
  const rischio = detectRischio({ astaN, stato, titolo });
  const mq      = mqRaw ? parseFloat(mqRaw.replace(/[^\d,.]/g,'').replace(',','.')) : null;
  const urlPerizia = await page.$eval(
    'a[href*="/file/"],a[href*="perizia"],a[href*="Perizia"]',
    e => e.href
  ).catch(() => null);

  return {
    id: generateId(codice), codice,
    titolo: titolo.slice(0,250),
    indirizzo: indirizzoEl, citta, provincia, regione, tipo,
    prezzo, mercato, mq, caparra, rischio, stato,
    asta_n: astaN, data_asta: dataAsta, scadenza: scadRaw, rialzo: rialzoRaw,
    composizione: null, catastale: catEl, procedura: 'Vendita telematica', tribunale,
    summary: buildSummary({ titolo, citta, prezzo, mercato, astaN, stato }),
    rischi_json: JSON.stringify(buildRischi({ astaN, stato, prezzo, mercato })),
    passi_json: JSON.stringify(buildPassi({ tribunale, caparra, scadenza: scadRaw })),
    url: link, url_perizia: urlPerizia, url_avviso: null,
  };
}

if (require.main === module) {
  runScraper().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runScraper, analizzaTutteLePerizie };
