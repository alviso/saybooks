'use strict';
/**
 * Shared helpers. db() resolves to the *current workspace's* database — set by execute()
 * for every command, or by workspace.use() for the rare caller outside the registry.
 * Domain read models live in their owning module (src/modules/o2c/views.js), not here.
 */
const wsp = require('./workspace.js');

const db = wsp.db;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const TERMS = { immediate: 0, net15: 15, net30: 30, net60: 60 };
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** Human-legible sequential ids. An operator reading SO-0007 in an email can find it. */
function nextId(prefix, table) {
  const row = db().prepare(`SELECT id FROM "${table}" ORDER BY id DESC LIMIT 1`).get();
  const n = row ? Number(String(row.id).split('-')[1]) + 1 : 1;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

const get = (table, id) => db().prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id);
const need = (table, id, label) => {
  const row = get(table, id);
  if (!row) throw new Error(`${label || table} ${id} does not exist.`);
  return row;
};

/** The registry owns command_log; this is its read side. */
const auditTrail = (limit = 50, subjectId = null) => db().prepare(`
  SELECT * FROM command_log ${subjectId ? 'WHERE subject_id = ?' : ''} ORDER BY id DESC LIMIT ?`)
  .all(...(subjectId ? [subjectId, limit] : [limit]));

module.exports = { db, today, addDays, TERMS, money, nextId, get, need, auditTrail };
