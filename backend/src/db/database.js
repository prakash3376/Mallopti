'use strict';
/**
 * database.js — Database initialisation and connection singleton.
 * SQLite WAL mode, synchronous NORMAL.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'data', 'mall.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price_paise INTEGER NOT NULL,
      initial_shelf_qty INTEGER NOT NULL,
      refill_cost_per_unit_paise INTEGER NOT NULL,
      online_pull_cost_per_unit_paise INTEGER NOT NULL,
      day_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS days (
      day_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      event_count INTEGER NOT NULL DEFAULT 0,
      total_cost INTEGER NOT NULL DEFAULT 0,
      lost_revenue INTEGER NOT NULL DEFAULT 0,
      savings_vs_baseline INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT,
      series_json TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      day_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      order_id TEXT NOT NULL,
      lines_json TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      PRIMARY KEY (day_id, seq)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_events_day_seq ON events(day_id, seq);
  `);
}

module.exports = { getDb };
