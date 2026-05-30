'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'aste.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS aste (
    id TEXT PRIMARY KEY,
    codice TEXT UNIQUE NOT NULL,
    titolo TEXT NOT NULL,
    indirizzo TEXT, citta TEXT, provincia TEXT, regione TEXT, tipo TEXT,
    prezzo REAL, mercato REAL, mq REAL, caparra REAL,
    rischio TEXT DEFAULT 'med',
    stato TEXT,
    asta_n INTEGER DEFAULT 1,
    data_asta TEXT, scadenza TEXT, rialzo TEXT,
    composizione TEXT, catastale TEXT, procedura TEXT, tribunale TEXT,
    summary TEXT,
    rischi_json TEXT,
    passi_json TEXT,
    url TEXT, url_perizia TEXT, url_avviso TEXT,
    -- Campi analisi AI perizia
    proprieta_stato TEXT DEFAULT 'unk',
    proprieta_label TEXT,
    proprieta_dettaglio TEXT,
    occupazione_stato TEXT DEFAULT 'unk',
    occupazione_label TEXT,
    occupazione_dettaglio TEXT,
    abusi_stato TEXT DEFAULT 'unk',
    abusi_label TEXT,
    abusi_dettaglio TEXT,
    sanatoria_stato TEXT DEFAULT 'unk',
    sanatoria_label TEXT,
    sanatoria_dettaglio TEXT,
    affitto_canone REAL,
    affitto_scadenza TEXT,
    affitto_tipo TEXT,
    perizia_analizzata INTEGER DEFAULT 0,
    aggiornato TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_citta   ON aste(citta);
  CREATE INDEX IF NOT EXISTS idx_regione ON aste(regione);
  CREATE INDEX IF NOT EXISTS idx_tipo    ON aste(tipo);
  CREATE INDEX IF NOT EXISTS idx_rischio ON aste(rischio);
  CREATE INDEX IF NOT EXISTS idx_prezzo  ON aste(prezzo);

  -- Aggiungi colonne se non esistono (per DB già esistenti)
  CREATE TABLE IF NOT EXISTS scraping_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    totale INTEGER, nuove INTEGER, aggiornate INTEGER,
    errori INTEGER, durata_ms INTEGER
  );
`);

// Aggiungi colonne mancanti per DB già esistenti
const existingCols = db.prepare("PRAGMA table_info(aste)").all().map(c => c.name);
const newCols = [
  ['proprieta_stato', 'TEXT DEFAULT "unk"'],
  ['proprieta_label', 'TEXT'],
  ['proprieta_dettaglio', 'TEXT'],
  ['occupazione_stato', 'TEXT DEFAULT "unk"'],
  ['occupazione_label', 'TEXT'],
  ['occupazione_dettaglio', 'TEXT'],
  ['abusi_stato', 'TEXT DEFAULT "unk"'],
  ['abusi_label', 'TEXT'],
  ['abusi_dettaglio', 'TEXT'],
  ['sanatoria_stato', 'TEXT DEFAULT "unk"'],
  ['sanatoria_label', 'TEXT'],
  ['sanatoria_dettaglio', 'TEXT'],
  ['affitto_canone', 'REAL'],
  ['affitto_scadenza', 'TEXT'],
  ['affitto_tipo', 'TEXT'],
  ['perizia_analizzata', 'INTEGER DEFAULT 0'],
];
for (const [col, def] of newCols) {
  if (!existingCols.includes(col)) {
    try { db.exec(`ALTER TABLE aste ADD COLUMN ${col} ${def}`); } catch(_) {}
  }
}

const stmtUpsert = db.prepare(`
  INSERT INTO aste (
    id, codice, titolo, indirizzo, citta, provincia, regione, tipo,
    prezzo, mercato, mq, caparra, rischio, stato, asta_n,
    data_asta, scadenza, rialzo, composizione, catastale, procedura,
    tribunale, summary, rischi_json, passi_json, url, url_perizia, url_avviso,
    aggiornato
  ) VALUES (
    @id, @codice, @titolo, @indirizzo, @citta, @provincia, @regione, @tipo,
    @prezzo, @mercato, @mq, @caparra, @rischio, @stato, @asta_n,
    @data_asta, @scadenza, @rialzo, @composizione, @catastale, @procedura,
    @tribunale, @summary, @rischi_json, @passi_json, @url, @url_perizia, @url_avviso,
    datetime('now')
  )
  ON CONFLICT(codice) DO UPDATE SET
    titolo=excluded.titolo, prezzo=excluded.prezzo, mercato=excluded.mercato,
    stato=excluded.stato, asta_n=excluded.asta_n, data_asta=excluded.data_asta,
    scadenza=excluded.scadenza, rischio=excluded.rischio, summary=excluded.summary,
    rischi_json=excluded.rischi_json, url_perizia=excluded.url_perizia,
    aggiornato=datetime('now')
`);

const stmtUpdatePerizia = db.prepare(`
  UPDATE aste SET
    proprieta_stato=@proprieta_stato, proprieta_label=@proprieta_label, proprieta_dettaglio=@proprieta_dettaglio,
    occupazione_stato=@occupazione_stato, occupazione_label=@occupazione_label, occupazione_dettaglio=@occupazione_dettaglio,
    abusi_stato=@abusi_stato, abusi_label=@abusi_label, abusi_dettaglio=@abusi_dettaglio,
    sanatoria_stato=@sanatoria_stato, sanatoria_label=@sanatoria_label, sanatoria_dettaglio=@sanatoria_dettaglio,
    affitto_canone=@affitto_canone, affitto_scadenza=@affitto_scadenza, affitto_tipo=@affitto_tipo,
    rischio=@rischio, perizia_analizzata=1, aggiornato=datetime('now')
  WHERE codice=@codice
`);

module.exports = {
  upsertAsta(row) {
    const safe = {
      id: row.id || '', codice: row.codice || '', titolo: row.titolo || '',
      indirizzo: row.indirizzo || null, citta: row.citta || null,
      provincia: row.provincia || null, regione: row.regione || null,
      tipo: row.tipo || 'apt', prezzo: row.prezzo || null, mercato: row.mercato || null,
      mq: row.mq || null, caparra: row.caparra || null, rischio: row.rischio || 'med',
      stato: row.stato || null, asta_n: row.asta_n || 1,
      data_asta: row.data_asta || null, scadenza: row.scadenza || null,
      rialzo: row.rialzo || null, composizione: row.composizione || null,
      catastale: row.catastale || null, procedura: row.procedura || null,
      tribunale: row.tribunale || null, summary: row.summary || null,
      rischi_json: row.rischi_json || null, passi_json: row.passi_json || null,
      url: row.url || null, url_perizia: row.url_perizia || null, url_avviso: row.url_avviso || null,
    };
    return stmtUpsert.run(safe);
  },

  updatePerizia(codice, analisi) {
    return stmtUpdatePerizia.run({ codice, ...analisi });
  },

  getAste_senzaPerizia(limit = 20) {
    return db.prepare(`
      SELECT codice, url_perizia, url, titolo, prezzo, mercato, asta_n, stato, tribunale, scadenza, caparra
      FROM aste
      WHERE perizia_analizzata = 0 AND url_perizia IS NOT NULL
      LIMIT ?
    `).all(limit);
  },

  getAste_senzaPerizia_noPDF(limit = 20) {
    return db.prepare(`
      SELECT codice, url_perizia, url, titolo, prezzo, mercato, asta_n, stato, tribunale, scadenza, caparra
      FROM aste
      WHERE perizia_analizzata = 0
      LIMIT ?
    `).all(limit);
  },

  getAsta(codice) {
    return db.prepare('SELECT * FROM aste WHERE codice=? OR id=?').get(codice, codice);
  },

  getStats() {
    return db.prepare('SELECT COUNT(*) AS totale, MAX(aggiornato) AS ultimo FROM aste').get();
  },

  logScraping(d) {
    db.prepare('INSERT INTO scraping_log (totale,nuove,aggiornate,errori,durata_ms) VALUES (?,?,?,?,?)')
      .run(d.totale, d.nuove, d.aggiornate, d.errori, d.durata_ms);
  },

  listAste({ citta, regione, tipo, rischio, prezzoMin, prezzoMax, q, sort, limit=48, offset=0 } = {}) {
    let where = 'WHERE 1=1';
    const p = {};
    if (citta)     { where += ' AND citta LIKE :citta';     p.citta = '%' + citta + '%'; }
    if (regione)   { where += ' AND regione = :regione';    p.regione = regione; }
    if (tipo)      { where += ' AND tipo = :tipo';          p.tipo = tipo; }
    if (rischio)   { where += ' AND rischio = :rischio';    p.rischio = rischio; }
    if (prezzoMin) { where += ' AND prezzo >= :prezzoMin';  p.prezzoMin = Number(prezzoMin); }
    if (prezzoMax) { where += ' AND prezzo <= :prezzoMax';  p.prezzoMax = Number(prezzoMax); }
    if (q)         { where += ' AND (titolo LIKE :q OR citta LIKE :q OR indirizzo LIKE :q)'; p.q = '%' + q + '%'; }
    const orderMap = { prezzo_asc: 'prezzo ASC', prezzo_desc: 'prezzo DESC', risparmio: '(1.0 - prezzo / MAX(mercato,1)) DESC' };
    const order = orderMap[sort] || 'aggiornato DESC';
    p.limit = Number(limit); p.offset = Number(offset);
    const rows  = db.prepare('SELECT * FROM aste ' + where + ' ORDER BY ' + order + ' LIMIT :limit OFFSET :offset').all(p);
    const total = db.prepare('SELECT COUNT(*) AS n FROM aste ' + where).get(p).n;
    return { rows, total };
  },

  close() { db.close(); },
};
