'use strict';
require('dotenv').config();
const { chromium } = require('playwright');
const db = require('./db');
const {
  sleep, randomDelay, generateId, normalizePrezzo,
  detectTipo, detectRischio, regioneFromProvincia,
  buildSummary, buildRischi, buildPassi
} = require('./utils');

const MAX_PAGINE = parseInt(process.env.MAX_PAGINE || '30');
const DELAY_MIN  = parseInt(process.env.DELAY_MIN_MS || '3000');
const DELAY_MAX  = parseInt(process.env.DELAY_MAX_MS || '6000');

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
      extraHTTPHeaders: {
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    await ctx.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,otf,eot}', r => r.abort());

    const page = await ctx.newPage();

    for (let p = 1; p <= MAX_PAGINE; p++) {
      const url = p === 1
        ? 'https://www.astalegale.net/Aste?categoria=IMMOBILI'
        : 'https://www.astalegale.net/Aste?categoria=IMMOBILI&pagina=' + p;

      console.log('  Pagina ' + p + '/' + MAX_PAGINE + ': ' + url);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(3000);
      } catch (e) {
        console.error('  Timeout pagina ' + p + ': ' + e.message);
        errori++;
        continue;
      }

      const pageTitle = await page.title().catch(() => 'N/A');
      console.log('  Titolo pagina: ' + pageTitle);

      let links = [];

      // Prova selettori specifici prima
      const selectors = [
        'a[href*="/Aste/Detail/"]',
        'a[href*="/aste/detail/"]',
        'a[href*="Detail"]',
        '.asta-item a', '.listing-item a', '.card a',
        'article a', '.immobile a', 'h2 a', 'h3 a',
        '.titolo a', 'a.titolo', '[class*="asta"] a',
        '[class*="lotto"] a', '.list-group-item a',
      ];

      for (const sel of selectors) {
        try {
          const found = await page.$$eval(sel, els =>
            [...new Set(els
              .map(e => e.href)
              .filter(h => h && h.includes('astalegale.net') && h.length > 40)
            )]
          );
          if (found.length > 0) {
            console.log('  Trovati ' + found.length + ' link con: ' + sel);
            links = [...new Set([...links, ...found])];
          }
        } catch (_) {}
      }

      // Fallback: tutti i link della pagina
      if (links.length === 0) {
        try {
          const allLinks = await page.$$eval('a[href]', els =>
            els.map(e => e.href).filter(h =>
              h && h.includes('astalegale.net') &&
              (h.includes('/Aste/') || h.includes('/aste/') || h.includes('Detail')) &&
              h.length > 50
            )
          );
          links = [...new Set(allLinks)];
          console.log('  Fallback: ' + links.length + ' link');

          if (links.length === 0) {
            const bodySnippet = await page.$eval('body', el => el.innerText.slice(0, 300)).catch(() => '');
            console.log('  Body snippet: ' + bodySnippet.replace(/\s+/g, ' '));
          }
        } catch (e) {
          console.error('  Errore fallback: ' + e.message);
        }
      }

      if (links.length === 0) {
        console.log('  Nessun link trovato a pagina ' + p);
        if (p === 1) break;
        break;
      }

      console.log('  Processo ' + links.length + ' aste da pagina ' + p);

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
          console.error('  Errore su ' + link + ': ' + err.message);
          await sleep(1000);
        }
      }

      await sleep(randomDelay(DELAY_MIN, DELAY_MAX));
    }

    await ctx.close();
  } catch (e) {
    console.error('Errore fatale: ' + e.message);
    errori++;
  } finally {
    await browser.close();
  }

  const durata = Date.now() - t0;
  db.logScraping({ totale, nuove, aggiornate, errori, durata_ms: durata });
  console.log('[' + new Date().toISOString() + '] Fine: ' + nuove + ' nuove, ' + aggiornate + ' aggiornate, ' + errori + ' errori, ' + (durata/1000).toFixed(0) + 's');
}

async function scrapeDetail(page, link) {
  try {
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(1000);
  } catch (e) {
    throw new Error('Timeout: ' + e.message);
  }

  const urlParts = link.split('/');
  const lastPart = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || '';
  const codiceMatch = lastPart.match(/([A-Z]{1,3}\d{5,})/i);
  const codice = codiceMatch ? codiceMatch[1].toUpperCase() : lastPart.split('-')[0].slice(0, 20);
  if (!codice || codice.length < 4) return null;

  const get = async (sels) => {
    for (const s of sels) {
      try {
        const el = await page.$(s);
        if (el) { const txt = (await el.textContent()).trim(); if (txt) return txt; }
      } catch (_) {}
    }
    return null;
  };

  const titolo = await get(['h1','h2.titolo','.detail-title','.page-title','[class*="titolo"]'])
    || lastPart.replace(/-/g, ' ').slice(0, 120);

  const prezzoRaw = await get([
    '.prezzo-base strong','.prezzo strong','[class*="prezzo"] strong',
    '[class*="prezzo"]','.base-price','.price',
    'td:has-text("Prezzo base") + td','td:has-text("Prezzo") + td',
    '[data-prezzo]','.importo','dt:has-text("Prezzo") + dd',
  ]);
  const prezzo = normalizePrezzo(prezzoRaw);
  if (!prezzo) return null;

  const tribunale = await get(['td:has-text("Tribunale") + td','.tribunale','[class*="tribunale"]','th:has-text("Tribunale") ~ td']);
  const dataAsta  = await get(['td:has-text("Data") + td','.data-asta','[class*="data-vendita"]','.auction-date']);
  const mqRaw     = await get(['td:has-text("Superficie") + td','.superficie','[class*="mq"]']);
  const stato     = await get(['td:has-text("Occupazione") + td','.occupazione','[class*="occup"]','td:has-text("Stato") + td']) || 'Da verificare';
  const catEl     = await get(['td:has-text("Categoria catastale") + td','td:has-text("Categoria") + td','[class*="categoria"]']);
  const indirizzoEl = await get(['.indirizzo','[class*="address"]','td:has-text("Indirizzo") + td','.localita','td:has-text("Comune") + td']);
  const scadRaw   = await get(['td:has-text("Scadenza") + td','.scadenza']);
  const rialzoRaw = await get(['td:has-text("Rialzo") + td','.rialzo-minimo']);
  const mercatoRaw = await get(['td:has-text("Valore stimato") + td','td:has-text("Valore di mercato") + td']);
  const caparraRaw = await get(['td:has-text("Cauzione") + td','.cauzione','td:has-text("Caparra") + td']);
  const astaNumRaw = await get(['.numero-asta','td:has-text("Esperimento") + td','td:has-text("N. vendita") + td']);

  let citta = '', provincia = '', regione = '';
  if (indirizzoEl) {
    const mProv = indirizzoEl.match(/\(([A-Z]{2})\)/);
    if (mProv) provincia = mProv[1];
    const parts = indirizzoEl.split(',');
    citta = parts.length >= 2
      ? parts[parts.length - 2].trim().replace(/\([A-Z]{2}\)/, '').trim()
      : indirizzoEl.replace(/\([A-Z]{2}\)/, '').trim().slice(0, 50);
    regione = regioneFromProvincia(provincia);
  }

  const mercato = normalizePrezzo(mercatoRaw) || Math.round(prezzo * 1.55);
  const caparra = normalizePrezzo(caparraRaw) || Math.round(prezzo * 0.1);
  const astaN   = parseInt(astaNumRaw) || 1;
  const tipo    = detectTipo(catEl || titolo);
  const rischio = detectRischio({ astaN, stato, titolo });
  const mq      = mqRaw ? parseFloat(mqRaw.replace(/[^\d,.]/g, '').replace(',', '.')) : null;
  const urlPerizia = await page.$eval('a[href*="/file/"],a[href*="perizia"]', e => e.href).catch(() => null);

  return {
    id: generateId(codice), codice,
    titolo: titolo.slice(0, 250),
    indirizzo: indirizzoEl, citta, provincia, regione, tipo,
    prezzo, mercato, mq, caparra, rischio, stato,
    asta_n: astaN, data_asta: dataAsta, scadenza: scadRaw, rialzo: rialzoRaw,
    composizione: null, catastale: catEl,
    procedura: 'Vendita telematica', tribunale,
    summary: buildSummary({ titolo, citta, prezzo, mercato, astaN, stato }),
    rischi_json: JSON.stringify(buildRischi({ astaN, stato, prezzo, mercato })),
    passi_json: JSON.stringify(buildPassi({ tribunale, caparra, scadenza: scadRaw })),
    url: link, url_perizia: urlPerizia, url_avviso: null,
  };
}

if (require.main === module) {
  runScraper().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runScraper };
