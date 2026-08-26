'use strict';
/**
 * Platform telemetry — counts only, never content. The books deliberately do not log reads
 * (INV-21), which makes browse-only visitors invisible to the audit trail; this server-level
 * store answers "did anyone actually touch anything" without putting a single business fact
 * in it. One row per demo sandbox: when, how often, whether anything was written, whether an
 * agent connected. Owned spaces are never recorded here.
 */
const path = require('path');
const Database = require('better-sqlite3');
const wsp = require('./workspace.js');

let _db = null;
function db() {
  if (_db) return _db;
  _db = new Database(path.join(wsp.DATA_DIR, 'telemetry.db'));
  _db.pragma('journal_mode = WAL');
  _db.exec(`CREATE TABLE IF NOT EXISTS ws_activity (
    ws          TEXT PRIMARY KEY,
    first_at    TEXT NOT NULL,
    last_at     TEXT NOT NULL,
    api_calls   INTEGER NOT NULL DEFAULT 0,
    writes      INTEGER NOT NULL DEFAULT 0,
    agent_calls INTEGER NOT NULL DEFAULT 0
  )`);
  return _db;
}

/** kind: 'read' | 'write' | 'agent' */
function record(ws, kind) {
  try {
    const now = new Date().toISOString();
    db().prepare(`INSERT INTO ws_activity (ws, first_at, last_at, api_calls, writes, agent_calls) VALUES (?,?,?,1,?,?)
      ON CONFLICT(ws) DO UPDATE SET last_at = excluded.last_at, api_calls = api_calls + 1,
        writes = writes + excluded.writes, agent_calls = agent_calls + excluded.agent_calls`)
      .run(ws, now, now, kind === 'write' ? 1 : 0, kind === 'agent' ? 1 : 0);
  } catch (e) { console.error('telemetry write failed:', e.message); }
}

const stats = () => db().prepare(`SELECT COUNT(*) touched,
  SUM(api_calls >= 3) engaged, SUM(writes > 0) wrote, SUM(agent_calls > 0) agent
  FROM ws_activity`).get();

module.exports = { record, stats, db };
