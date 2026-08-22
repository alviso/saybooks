'use strict';
/**
 * Members: who can enter a workspace, as what, with which role.
 *
 * Capability-token identity — the token is the key, deliberately demo-grade: no passwords,
 * link-is-key, revocable, swept with the sandbox. The durable part of access control is the
 * permission field on commands and its enforcement in execute(); this store is the swappable
 * skin over it (real principals can replace it later without touching the grants model).
 *
 * One server-level SQLite (not per-workspace): tokens must resolve to a workspace before any
 * workspace is open, so they cannot live inside one.
 */
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const wsp = require('./workspace.js');

let _db = null;
function db() {
  if (_db) return _db;
  _db = new Database(path.join(wsp.DATA_DIR, 'members.db'));
  _db.pragma('journal_mode = WAL');
  _db.exec(`CREATE TABLE IF NOT EXISTS member (
    token      TEXT PRIMARY KEY,
    workspace  TEXT NOT NULL,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_member_ws ON member(workspace)`);
  return _db;
}

const ROLES = ['owner', 'controller', 'clerk', 'viewer'];

function mint(workspace, name, role) {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!name || !/^[a-z0-9 ._-]{1,40}$/i.test(name)) throw new Error('member name: 1-40 letters, digits, spaces, . _ -');
  if (db().prepare('SELECT 1 FROM member WHERE workspace = ? AND lower(name) = lower(?) AND revoked_at IS NULL').get(workspace, name)) {
    throw new Error(`${name} is already a member here. Revoke first to re-invite.`);
  }
  const token = `m-${crypto.randomBytes(9).toString('hex')}`;
  db().prepare('INSERT INTO member (token, workspace, name, role, created_at) VALUES (?,?,?,?,?)')
    .run(token, workspace, name, role, new Date().toISOString());
  return { token, workspace, name, role };
}

const resolve = (token) => {
  if (!/^m-[a-f0-9]{18}$/.test(token || '')) return null;
  const m = db().prepare('SELECT * FROM member WHERE token = ? AND revoked_at IS NULL').get(token);
  return m || null;
};

const list = (workspace) => db().prepare(
  'SELECT name, role, created_at, revoked_at, substr(token, 1, 6) || "…" AS token_hint FROM member WHERE workspace = ? ORDER BY created_at').all(workspace);

function revoke(workspace, name) {
  const r = db().prepare('UPDATE member SET revoked_at = ? WHERE workspace = ? AND lower(name) = lower(?) AND revoked_at IS NULL')
    .run(new Date().toISOString(), workspace, name);
  return r.changes;
}

/** Sweep hook: a destroyed sandbox takes its keys with it. */
const purge = (workspace) => db().prepare('DELETE FROM member WHERE workspace = ?').run(workspace).changes;

module.exports = { mint, resolve, list, revoke, purge, ROLES };
