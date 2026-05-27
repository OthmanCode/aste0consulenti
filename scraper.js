'use strict';
/**
 * AstaChiara Scraper
 * ─────────────────────────────────────────────────────────────────────────────
 * Sorgenti supportate:
 *   1. astalegale.net     — maggior copertura nazionale
 *   2. portaleaste.com    — fonte alternativa / cross-check
 *
 * Strategia anti-ban:
 *   - User-agent realistico (Chromium headless con fingerprint standard)
 *   - Delay random tra richieste (2-6 secondi)
 *   - Rotazione viewport e language headers
 *   - Rispetto del crawl delay
 *   - Nessun download di PDF (solo URL salvato nel DB)
 *
 * Output: salva nel DB SQLite via db.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { chromium } = require('playwright');
const db = require('./db');
const { sleep, randomDelay, normalizePrezzo, detectTipo, detectRischio, regioneFromProvincia, generateId, buildSummary } = require('./utils');

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_PAGINE        = parseInt(process.env.MAX_PAGINE       || '50');
const DELAY_MIN_MS      = parseInt(process.env.DELAY_MIN_MS     || '2000');
const DELAY_MAX_MS      = parseInt(process.env.DELAY_MAX_MS     || '5000');
const HEADLESS          = process.env.HEADLESS !== 'false';
const CONCURRENCY       = 1; // una pagina alla volta per non stressare il server

// ── Entry point ───────────────────────────────────────────────────────────────
async function runScraper({ once = false } = {}) {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] 🚀 Avvio scraping...`);

  let totale = 0, nuove = 0, aggiornate = 0, errori = 0;

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    // ── 1. astalegale.net ─────────────────────────────────────────────────────
    const res1 = await scrapeAstalegale(browser);
    totale     += res1.totale;
    nuove      += res1.nuove;
    aggiornate += res1.aggiornate;
    errori     += res1.errori;

    // ── 2. portaleaste.com ────────────────────────────────────────────────────
    const res2 = await scrapePortaleAste(browser);
    totale     += res2.totale;
    nuove      += res2.nuove;
    aggiornate += res2.aggiornate;
    errori     += res2.errori;

  } finally {
    await browser.close();
  }

  const durata = Date.now() - start;
  db.logScraping({ source: 'all', totale, nuove, aggiornate, errori, durata_ms: durata });
  console.log(`[${new Date().toISOString()}] ✅ Scraping completato in ${(durata/1000).toFixed(1)}s — ${nuove} nuove, ${aggiornate} aggiornate, ${errori} errori`);
}

// ── astalegale.net ────────────────────────────────────────────────────────────
async function scrapeAstalegale(browser) {
  const SOURCE = 'astalegale.net';
  let totale = 0, nuove = 0, aggiornate = 0, errori = 0;

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    extraHTTPHeaders: {
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const page = await context.newPage();

  // Blocca risorse inutili (velocità)
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf}', r => r.abort());
  await page.route('**/analytics**', r => r.abort());
  await page.route('**/google-analytics**', r => r.abort());
  await page.route('**/ads**', r => r.abort());

  try {
    // Naviga alla lista aste immobiliari
    await page.goto('https://www.astalegale.net/Aste?categoria=IMMOBILI&ordinamento=dataAsta', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(randomDelay(DELAY_MIN_MS, DELAY_MAX_MS));

    // Estrai il numero totale di pagine
    let nPagine = 1;
    try {
      const lastPageEl = await page.$('.pagination li:last-child a, .pager .last a, [data-page]:last-child');
      if (lastPageEl) {
        const txt = await lastPageEl.textContent();
        nPagine = Math.min(parseInt(txt.trim()) || 1, MAX_PAGINE);
      }
    } catch (_) {}

    console.log(`  [${SOURCE}] Trovate ~${nPagine} pagine da scrapare`);

    // Scorri le pagine
    for (let p = 1; p <= nPagine; p++) {
      console.log(`  [${SOURCE}] Pagina ${p}/${nPagine}...`);
      if (p > 1) {
        await page.goto(`https://www.astalegale.net/Aste?categoria=IMMOBILI&ordinamento=dataAsta&pagina=${p}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await sleep(randomDelay(DELAY_MIN_MS, DELAY_MAX_MS));
      }

      // Estrai i link alle schede
      const links = await page.$$eval(
        'a[href*="/Aste/Detail/"], a[href*="/aste/detail/"], .asta-item a, .listing-item a, .card-asta a',
        els => [...new Set(els.map(e => e.href).filter(h => h.includes('/Aste/') || h.includes('/aste/')))]
      );

      if (!links.length) {
        console.log(`  [${SOURCE}] Nessun link trovato a pagina ${p} — possibile fine paginazione`);
        break;
      }

      // Processa ogni scheda
      for (const url of links) {
        try {
          const asta = await scrapeDetailAstalegale(page, url);
          if (asta) {
            const existing = db.getAsta(asta.codice);
            const result = db.upsertAsta(asta);
            if (!existing) nuove++; else aggiornate++;
            totale++;
          }
          await sleep(randomDelay(DELAY_MIN_MS, DELAY_MAX_MS));
        } catch (err) {
          errori++;
          console.error(`  [${SOURCE}] Errore su ${url}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    errori++;
    console.error(`  [${SOURCE}] Errore fatale: ${err.message}`);
  } finally {
    await context.close();
  }

  return { totale, nuove, aggiornate, errori };
}

// ── Scraping di una singola scheda astalegale.net ─────────────────────────────
async function scrapeDetailAstalegale(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(500);

  const html = await page.content();

  // ── Estrazione selettori multipli (robusta a layout changes) ─────────────
  const get = async (selectors) => {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) return (await el.textContent()).trim();
      } catch (_) {}
    }
    return null;
  };

  const getAll = async (sel) => {
    try {
      return await page.$$eval(sel, els => els.map(e => e.textContent.trim()).filter(Boolean));
    } catch (_) { return []; }
  };

  const getAttr = async (sel, attr) => {
    try {
      const el = await page.$(sel);
      if (el) return await el.getAttribute(attr);
    } catch (_) {}
    return null;
  };

  // Codice procedura dall'URL
  const urlParts = url.split('/');
  const codiceRaw = urlParts.find(p => /^[A-Z]{1,3}\d{6,}/.test(p)) || urlParts[urlParts.length - 1].split('-')[0];
  const codice = codiceRaw.split('-')[0];
  if (!codice || codice.length < 5) return null;

  // Titolo
  const titolo = await get([
    'h1.titolo-asta',
    'h1.detail-title',
    'h1[class*="title"]',
    '.asta-title h1',
    'h1',
  ]) || url.split('/').pop().replace(/-/g, ' ').slice(0, 100);

  // Prezzo base
  const prezzoRaw = await get([
    '[data-prezzo-base]',
    '.prezzo-base strong',
    '.prezzo strong',
    'td:contains("Prezzo base") + td',
    '.detail-price',
    '[class*="prezzo"] strong',
  ]);
  const prezzo = normalizePrezzo(prezzoRaw);

  // Dati tabellari
  const tribunaleEl = await get(['td:has-text("Tribunale") + td', '.tribunale', '[class*="tribunale"]', 'td.label:contains("Tribunal") + td']);
  const dataAstaRaw = await get(['td:has-text("Data") + td', '.data-asta', '[class*="data-vendita"]', '.detail-date']);
  const mqRaw = await get(['td:has-text("Superficie") + td', '.superficie', '[class*="mq"]']);
  const statoOcc = await get(['td:has-text("Occupazione") + td', '.occupazione', '[class*="occup"]', 'td:has-text("Stato") + td']);

  // Indirizzo / città
  const indirizzoEl = await get(['.indirizzo', '[class*="address"]', 'td:has-text("Indirizzo") + td', '.localita']);
  let citta = '', provincia = '', regione = '';
  if (indirizzoEl) {
    const mProv = indirizzoEl.match(/\b([A-Z]{2})\b/);
    if (mProv) provincia = mProv[1];
    const mCity = indirizzoEl.match(/(?:,\s*)([A-Za-zÀ-ú\s]+)(?:\s+\(|$)/);
    if (mCity) citta = mCity[1].trim();
    regione = regioneFromProvincia(provincia);
  }

  // Categoria catastale → tipo
  const catEl = await get(['td:has-text("Categoria catastale") + td', '[class*="categoria"]', 'td:has-text("Destinazione") + td']);
  const tipo = detectTipo(catEl || titolo);

  // Composizione
  const comp = await get(['td:has-text("Composizione") + td', '.composizione', '[class*="compos"]']);

  // URL documenti
  const urlPerizia = await getAttr('a[href*="/file/"][href*="perizia"], a[href*="perizia"]', 'href')
    || await getAttr('a[href*="documents.astalegale"]:first-child', 'href');
  const urlAvviso  = await getAttr('a[href*="avviso"], a[href*="vendita"]', 'href');

  // Numero asta (es. "2ª vendita")
  const astaNumRaw = await get(['.numero-asta', '[class*="num-asta"]', 'td:has-text("N. Esperimento") + td']);
  const astaN = astaNumRaw ? (parseInt(astaNumRaw) || 1) : 1;

  // Scadenza offerte
  const scadRaw = await get(['td:has-text("Scadenza") + td', '.scadenza', '[class*="scadenza"]']);

  // Rialzo minimo
  const rialzoRaw = await get(['td:has-text("Rialzo") + td', '.rialzo-minimo', '[class*="rialzo"]']);

  // Stima valore mercato (da perizia se presente)
  const mercatoRaw = await get(['td:has-text("Valore stimato") + td', '.valore-stimato', '[class*="valore-perizia"]']);
  const mercato = normalizePrezzo(mercatoRaw) || (prezzo ? Math.round(prezzo * 1.55) : null);

  // Caparra
  const caparraRaw = await get(['td:has-text("Cauzione") + td', '.cauzione', '[class*="caparra"]']);
  const caparra = normalizePrezzo(caparraRaw) || (prezzo ? Math.round(prezzo * 0.1) : null);

  if (!prezzo) return null; // senza prezzo non ha senso salvare

  const rischio = detectRischio({ astaN, stato: statoOcc, titolo, catEl });
  const summary = buildSummary({ titolo, citta, prezzo, mercato, astaN, stato: statoOcc });

  return {
    id:           generateId(codice),
    codice,
    titolo:       titolo.slice(0, 250),
    indirizzo:    indirizzoEl,
    citta,
    provincia,
    regione,
    tipo,
    prezzo,
    mercato,
    mq:           mqRaw ? parseFloat(mqRaw.replace(',', '.')) : null,
    caparra,
    rischio,
    stato:        statoOcc || 'Da verificare',
    asta_n:       astaN,
    data_asta:    dataAstaRaw,
    scadenza:     scadRaw,
    rialzo:       rialzoRaw,
    composizione: comp,
    catastale:    catEl,
    procedura:    'Vendita telematica',
    tribunale:    tribunaleEl,
    summary,
    rischi_json:  JSON.stringify(buildRischi({ astaN, stato: statoOcc, prezzo, mercato, catEl })),
    passi_json:   JSON.stringify(buildPassi({ tribunale: tribunaleEl, caparra, scadenza: scadRaw, urlPerizia })),
    url,
    url_perizia:  urlPerizia,
    url_avviso:   urlAvviso,
    raw_html:     html.slice(0, 50000),
  };
}

// ── portaleaste.com ────────────────────────────────────────────────────────────
async function scrapePortaleAste(browser) {
  const SOURCE = 'portaleaste.com';
  let totale = 0, nuove = 0, aggiornate = 0, errori = 0;

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  });

  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2}', r => r.abort());

  try {
    await page.goto('https://www.portaleaste.com/aste-immobiliari', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(randomDelay(DELAY_MIN_MS, DELAY_MAX_MS));

    let nPagine = 1;
    try {
      const lastPage = await page.$eval(
        '.pagination a:last-child, .page-last, [aria-label="Last"]',
        el => el.href
      );
      const m = lastPage.match(/pagina[=\/](\d+)/i) || lastPage.match(/page[=\/](\d+)/i);
      if (m) nPagine = Math.min(parseInt(m[1]), MAX_PAGINE);
    } catch (_) {}

    for (let p = 1; p <= nPagine; p++) {
      if (p > 1) {
        await page.goto(`https://www.portaleaste.com/aste-immobiliari?page=${p}`, {
          waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await sleep(randomDelay(DELAY_MIN_MS, DELAY_MAX_MS));
      }

      const links = await page.$$eval(
        '.asta-card a, .listing-asta a, a[href*="/asta/"], a[href*="/lotto/"]',
        els => [...new Set(els.map(e => e.href).filter(h => h.includes('portaleaste.com')))]
      );

      for (const url of links) {
        try {
          const asta = await scrapeDetailPortaleAste(page, url);
          if (asta) {
            const existing = db.getAsta(asta.codice);
            db.upsertAsta(asta);
            if (!existing) nuove++; else aggiornate++;
            totale++;
          }
          await sleep(randomDelay(DELAY_MIN_MS, DELAY_MAX_MS));
        } catch (err) {
          errori++;
          console.error(`  [${SOURCE}] Errore ${url}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`  [${SOURCE}] Errore fatale: ${err.message}`);
    errori++;
  } finally {
    await context.close();
  }

  return { totale, nuove, aggiornate, errori };
}

async function scrapeDetailPortaleAste(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(400);

  const get = async (sels) => {
    for (const s of sels) {
      try { const el = await page.$(s); if (el) return (await el.textContent()).trim(); } catch (_) {}
    }
    return null;
  };

  const codice = url.split('/').pop().split('-')[0] || url.split('/').pop();
  if (!codice) return null;

  const titolo    = await get(['h1', '.titolo', '.title']) || codice;
  const prezzoRaw = await get(['.prezzo-base', '.base-price', '[class*="prezzo"]']);
  const prezzo    = normalizePrezzo(prezzoRaw);
  if (!prezzo) return null;

  const citta      = await get(['.citta', '.city', '[class*="luogo"]']) || '';
  const tribunale  = await get(['.tribunale', '[class*="tribunal"]']) || '';
  const dataAsta   = await get(['.data-asta', '.auction-date', '[class*="data"]']) || '';
  const mq         = await get(['.mq', '.superficie', '[class*="superficie"]']);
  const stato      = await get(['.stato-occupazione', '[class*="occupazione"]', '[class*="occupaz"]']) || 'Da verificare';
  const catEl      = await get(['.categoria', '[class*="categoria-catastale"]']) || '';

  const tipo    = detectTipo(catEl || titolo);
  const mercato = prezzo ? Math.round(prezzo * 1.5) : null;
  const caparra = prezzo ? Math.round(prezzo * 0.1) : null;
  const rischio = detectRischio({ stato, titolo });
  const regione = regioneFromProvincia(citta.slice(-2));

  return {
    id:           generateId('PA-' + codice),
    codice:       'PA-' + codice,
    titolo:       titolo.slice(0, 250),
    indirizzo:    citta,
    citta:        citta.split(',')[0]?.trim() || citta,
    provincia:    '',
    regione,
    tipo,
    prezzo,
    mercato,
    mq:           mq ? parseFloat(mq) : null,
    caparra,
    rischio,
    stato,
    asta_n:       1,
    data_asta:    dataAsta,
    scadenza:     null,
    rialzo:       null,
    composizione: null,
    catastale:    catEl,
    procedura:    'Vendita telematica',
    tribunale,
    summary:      buildSummary({ titolo, citta, prezzo, mercato, astaN: 1, stato }),
    rischi_json:  JSON.stringify(buildRischi({ stato, prezzo, mercato })),
    passi_json:   JSON.stringify(buildPassi({ tribunale, caparra, scadenza: null })),
    url,
    url_perizia:  null,
    url_avviso:   null,
    raw_html:     null,
  };
}

// ── Costruttori rischi e passi ────────────────────────────────────────────────
function buildRischi({ astaN = 1, stato = '', prezzo, mercato, catEl = '' }) {
  const rischi = [];
  if (astaN > 1) rischi.push({ tipo: 'warn', titolo: `${astaN}ª asta — prezzo ridotto`, testo: `Questa è la ${astaN}ª asta consecutiva. Il prezzo è stato ridotto rispetto alle precedenti. Approfondisci con il custode per capire perché le aste precedenti sono andate deserte.` });
  const statoLower = (stato || '').toLowerCase();
  if (statoLower.includes('occup') || statoLower.includes('inquilin')) {
    rischi.push({ tipo: 'danger', titolo: 'Immobile occupato', testo: 'L\'immobile risulta occupato. Prima di fare offerta verifica con il custode i tempi e le modalità di liberazione. Possono richiedere da 6 a 24 mesi.' });
  } else if (statoLower.includes('libero') || statoLower === '') {
    rischi.push({ tipo: 'safe', titolo: 'Stato: libero (da verificare)', testo: 'L\'immobile risulta libero. Conferma sempre con il custode e richiedi un sopralluogo prima dell\'asta.' });
  }
  if (prezzo && mercato && mercato > prezzo) {
    const pct = Math.round((1 - prezzo / mercato) * 100);
    rischi.push({ tipo: pct > 40 ? 'safe' : 'info', titolo: `Risparmio potenziale: −${pct}%`, testo: `Il prezzo base è inferiore del ${pct}% rispetto al valore stimato di mercato (${new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(mercato)}). Includi sempre nel calcolo: imposte, spese procedura, eventuali lavori.` });
  }
  rischi.push({ tipo: 'info', titolo: 'Caparra: 10% del prezzo base', testo: 'La caparra versata prima dell\'asta è persa se vinci l\'asta ma non riesci a completare l\'acquisto. Assicurati di avere la liquidità necessaria o una pre-approvazione mutuo.' });
  return rischi;
}

function buildPassi({ tribunale, caparra, scadenza, urlPerizia }) {
  return [
    { t: 'Contatta il custode giudiziario', d: `Chiama il custode delegato del ${tribunale || 'tribunale competente'} per prenotare una visita e chiedere: immobile libero o occupato? Spese condominiali arretrate? Abusi edilizi?` },
    { t: 'Scarica e analizza la perizia', d: `Scarica la perizia dal portale del tribunale${urlPerizia ? ' (link disponibile sulla scheda)' : ''}. Caricala qui su AstaChiara per l\'analisi AI automatica.` },
    { t: 'Calcola il costo totale reale', d: `Al prezzo base aggiungi: imposte di registro (2% prima casa, 9% seconda), onorari delegato (~1%), spese procedura (€1.500-2.500), eventuali lavori. Non guardare solo il prezzo base.` },
    { t: 'Pre-approva il mutuo', d: 'Contatta la tua banca per una pre-approvazione del mutuo prima di partecipare. Senza disponibilità finanziaria certa, non depositare la caparra.' },
    { t: `Presenta offerta entro ${scadenza || 'la scadenza indicata'}`, d: `Deposita la caparra (${caparra ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(caparra) : '10% del prezzo base'}) tramite bonifico e invia la tua offerta online.` },
  ];
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const once = process.argv.includes('--once');
  runScraper({ once }).catch(err => {
    console.error('Errore fatale scraper:', err);
    process.exit(1);
  });
}

module.exports = { runScraper };
