'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'aste.db');
const db = new Database(DB_PATH);

// ── Pragmas per performance ───────────────────────────────────────────────────
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS aste (
    id          TEXT PRIMARY KEY,
    codice      TEXT UNIQUE NOT NULL,
    titolo      TEXT NOT NULL,
    indirizzo   TEXT,
    citta       TEXT,
    provincia   TEXT,
    regione     TEXT,
    tipo        TEXT,           -- apt | villa | comm | land | box | altro
    prezzo      REAL,
    mercato     REAL,
    mq          REAL,
    caparra     REAL,
    rischio     TEXT DEFAULT 'med',  -- low | med | high
    stato       TEXT,           -- es. "Libero" o "Occupato — inquilino"
    asta_n      INTEGER DEFAULT 1,
    data_asta   TEXT,
    scadenza    TEXT,
    rialzo      TEXT,
    composizione TEXT,
    catastale   TEXT,
    procedura   TEXT,
    tribunale   TEXT,
    summary     TEXT,
    rischi_json TEXT,           -- JSON array
    passi_json  TEXT,           -- JSON array
    url         TEXT,
    url_perizia TEXT,
    url_avviso  TEXT,
    raw_html    TEXT,
    scraping_ts TEXT DEFAULT (datetime('now')),
    aggiornato  TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_aste_citta     ON aste(citta);
  CREATE INDEX IF NOT EXISTS idx_aste_regione   ON aste(regione);
  CREATE INDEX IF NOT EXISTS idx_aste_tipo      ON aste(tipo);
  CREATE INDEX IF NOT EXISTS idx_aste_rischio   ON aste(rischio);
  CREATE INDEX IF NOT EXISTS idx_aste_prezzo    ON aste(prezzo);
  CREATE INDEX IF NOT EXISTS idx_aste_data      ON aste(data_asta);

  CREATE TABLE IF NOT EXISTS scraping_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT DEFAULT (datetime('now')),
    source      TEXT,
    totale      INTEGER,
    nuove       INTEGER,
    aggiornate  INTEGER,
    errori      INTEGER,
    durata_ms   INTEGER,
    note        TEXT
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
const stmtUpsert = db.prepare(`
  INSERT INTO aste (
    id, codice, titolo, indirizzo, citta, provincia, regione, tipo,
    prezzo, mercato, mq, caparra, rischio, stato, asta_n,
    data_asta, scadenza, rialzo, composizione, catastale, procedura,
    tribunale, summary, rischi_json, passi_json, url, url_perizia, url_avviso,
    raw_html, aggiornato
  ) VALUES (
    @id, @codice, @titolo, @indirizzo, @citta, @provincia, @regione, @tipo,
    @prezzo, @mercato, @mq, @caparra, @rischio, @stato, @asta_n,
    @data_asta, @scadenza, @rialzo, @composizione, @catastale, @procedura,
    @tribunale, @summary, @rischi_json, @passi_json, @url, @url_perizia, @url_avviso,
    @raw_html, datetime('now')
  )
  ON CONFLICT(codice) DO UPDATE SET
    titolo      = excluded.titolo,
    prezzo      = excluded.prezzo,
    mercato     = excluded.mercato,
    stato       = excluded.stato,
    asta_n      = excluded.asta_n,
    data_asta   = excluded.data_asta,
    scadenza    = excluded.scadenza,
    rischio     = excluded.rischio,
    summary     = excluded.summary,
    rischi_json = excluded.rischi_json,
    url_perizia = excluded.url_perizia,
    url_avviso  = excluded.url_avviso,
    raw_html    = excluded.raw_html,
    aggiornato  = datetime('now')
`);

const stmtList = db.prepare(`
  SELECT * FROM aste
  WHERE
    (@citta     IS NULL OR citta    LIKE '%' || @citta    || '%') AND
    (@regione   IS NULL OR regione  = @regione)  AND
    (@tipo      IS NULL OR tipo     = @tipo)      AND
    (@rischio   IS NULL OR rischio  = @rischio)   AND
    (@prezzoMin IS NULL OR prezzo  >= @prezzoMin) AND
    (@prezzoMax IS NULL OR prezzo  <= @prezzoMax) AND
    (@q         IS NULL OR titolo  LIKE '%' || @q || '%'
                        OR citta   LIKE '%' || @q || '%'
                        OR indirizzo LIKE '%' || @q || '%')
  ORDER BY
    CASE @sort
      WHEN 'prezzo_asc'  THEN prezzo
      WHEN 'prezzo_desc' THEN -prezzo
      WHEN 'risparmio'   THEN -(1 - prezzo / MAX(mercato, 1))
      ELSE id
    END ASC
  LIMIT @limit OFFSET @offset
`);

const stmtCount = db.prepare(`
  SELECT COUNT(*) AS n FROM aste
  WHERE
    (@citta     IS NULL OR citta    LIKE '%' || @citta    || '%') AND
    (@regione   IS NULL OR regione  = @regione)  AND
    (@tipo      IS NULL OR tipo     = @tipo)      AND
    (@rischio   IS NULL OR rischio  = @rischio)   AND
    (@prezzoMin IS NULL OR prezzo  >= @prezzoMin) AND
    (@prezzoMax IS NULL OR prezzo  <= @prezzoMax) AND
    (@q         IS NULL OR titolo  LIKE '%' || @q || '%'
                        OR citta   LIKE '%' || @q || '%'
                        OR indirizzo LIKE '%' || @q || '%')
`);

const stmtOne = db.prepare(`SELECT * FROM aste WHERE codice = ? OR id = ?`);
const stmtStats = db.prepare(`
  SELECT
    COUNT(*)            AS totale,
    MIN(prezzo)         AS prezzo_min,
    MAX(prezzo)         AS prezzo_max,
    AVG(prezzo)         AS prezzo_medio,
    SUM(CASE rischio WHEN 'low'  THEN 1 ELSE 0 END) AS n_low,
    SUM(CASE rischio WHEN 'med'  THEN 1 ELSE 0 END) AS n_med,
    SUM(CASE rischio WHEN 'high' THEN 1 ELSE 0 END) AS n_high,
    MAX(aggiornato)     AS ultimo_aggiornamento
  FROM aste
`);

module.exports = {
  db,

  upsertAsta(row) {
    return stmtUpsert.run(row);
  },

  listAste({ citta, regione, tipo, rischio, prezzoMin, prezzoMax, q, sort, limit = 48, offset = 0 } = {}) {
    return stmtList.all({
      citta:     citta     || null,
      regione:   regione   || null,
      tipo:      tipo      || null,
      rischio:   rischio   || null,
      prezzoMin: prezzoMin != null ? Number(prezzoMin) : null,
      prezzoMax: prezzoMax != null ? Number(prezzoMax) : null,
      q:         q         || null,
      sort:      sort      || 'data',
      limit:     Number(limit),
      offset:    Number(offset),
    });
  },

  countAste(params) {
    return stmtCount.get({ ...params, citta: params.citta || null, regione: params.regione || null, tipo: params.tipo || null, rischio: params.rischio || null, prezzoMin: params.prezzoMin != null ? Number(params.prezzoMin) : null, prezzoMax: params.prezzoMax != null ? Number(params.prezzoMax) : null, q: params.q || null }).n;
  },

  getAsta(codice) {
    return stmtOne.get(codice, codice);
  },

  getStats() {
    return stmtStats.get();
  },

  logScraping({ source, totale, nuove, aggiornate, errori, durata_ms, note }) {
    db.prepare(`INSERT INTO scraping_log (source,totale,nuove,aggiornate,errori,durata_ms,note) VALUES (?,?,?,?,?,?,?)`).run(source, totale, nuove, aggiornate, errori, durata_ms, note || null);
  },

  getLastLog() {
    return db.prepare(`SELECT * FROM scraping_log ORDER BY id DESC LIMIT 1`).get();
  },

  close() { db.close(); },
};
