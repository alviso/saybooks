'use strict';
/**
 * Users, sessions, and owned spaces — the Google-auth layer over the capability system.
 *
 * A SPACE is a workspace with a human face: named, persistent (never swept), owned by a
 * signed-in user, shareable by email. Capability tokens (members.js) remain the mechanism
 * for agent keys and quick link-shares; this store holds who people are and what they own.
 * Passwords never exist here: Google vouches for the email, we record it.
 */
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const wsp = require('./workspace.js');

let _db = null;
function db() {
  if (_db) return _db;
  _db = new Database(path.join(wsp.DATA_DIR, 'users.db'));
  _db.pragma('journal_mode = WAL');
  _db.exec(`
  CREATE TABLE IF NOT EXISTS user (
    id         TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email      TEXT NOT NULL UNIQUE,
    name       TEXT,
    picture    TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS space (
    ws            TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES user(id),
    display_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS space_member (
    ws         TEXT NOT NULL,
    email      TEXT NOT NULL,
    user_id    TEXT,
    role       TEXT NOT NULL,
    invited_by TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY (ws, email)
  )`);
  // kind: what a space mounts — null = full books, 'hunt' = the free job-hunt offering.
  const cols = _db.prepare('PRAGMA table_info(space)').all().map(c => c.name);
  if (!cols.includes('kind')) _db.exec('ALTER TABLE space ADD COLUMN kind TEXT');
  // Where a workspace came from: the first-touch cookie the public pages set (referrer host,
  // landing path, utm tags). One row per workspace; the only way to know which channel pays.
  _db.exec(`CREATE TABLE IF NOT EXISTS acquisition (
    ws TEXT PRIMARY KEY, kind TEXT NOT NULL, referrer TEXT, landing TEXT, source TEXT, medium TEXT, campaign TEXT, first_seen TEXT, at TEXT NOT NULL)`);
  return _db;
}
const now = () => new Date().toISOString();
const rid = (p, n = 9) => `${p}-${crypto.randomBytes(n).toString('hex')}`;

function upsertUser({ sub, email, name, picture }) {
  const hit = db().prepare('SELECT * FROM user WHERE google_sub = ?').get(sub);
  if (hit) {
    db().prepare('UPDATE user SET email = ?, name = ?, picture = ? WHERE id = ?').run(email, name || hit.name, picture || hit.picture, hit.id);
    return db().prepare('SELECT * FROM user WHERE id = ?').get(hit.id);
  }
  const id = rid('u', 6);
  db().prepare('INSERT INTO user (id, google_sub, email, name, picture, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, sub, email, name || null, picture || null, now());
  // pending email invites become live memberships the moment the email proves itself
  db().prepare('UPDATE space_member SET user_id = ? WHERE lower(email) = lower(?) AND user_id IS NULL').run(id, email);
  return db().prepare('SELECT * FROM user WHERE id = ?').get(id);
}

function createSession(userId, days = 30) {
  const token = rid('s', 18);
  db().prepare('INSERT INTO session (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now(), new Date(Date.now() + days * 864e5).toISOString());
  return token;
}
function userForSession(token) {
  if (!/^s-[a-f0-9]{36}$/.test(token || '')) return null;
  const row = db().prepare(`SELECT u.* FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`).get(token, now());
  return row || null;
}
const dropSession = (token) => db().prepare('DELETE FROM session WHERE token = ?').run(token);

function createSpace(userId, displayName, ws, kind) {
  ws = ws || rid('sp', 5).replace(/-/g, '').slice(0, 20);
  db().prepare('INSERT INTO space (ws, owner_user_id, display_name, created_at, kind) VALUES (?,?,?,?,?)').run(ws, userId, displayName, now(), kind || null);
  return db().prepare('SELECT * FROM space WHERE ws = ?').get(ws);
}
const claimSpace = (userId, ws, displayName, kind) => createSpace(userId, displayName, ws, kind);

/** Permanent, owner-only. The caller destroys the workspace database and purges tokens;
 *  this removes the rows that make it a space. */
function deleteSpace(ws, userId) {
  const sp = spaceOf(ws);
  if (!sp || sp.owner_user_id !== userId) return false;
  db().prepare('DELETE FROM space_member WHERE ws = ?').run(ws);
  db().prepare('DELETE FROM space WHERE ws = ?').run(ws);
  return true;
}

function spacesFor(userId) {
  const u = db().prepare('SELECT * FROM user WHERE id = ?').get(userId);
  const owned = db().prepare('SELECT ws, display_name, ? AS role FROM space WHERE owner_user_id = ?').all('owner', userId);
  const member = db().prepare(`SELECT sm.ws, sp.display_name, sm.role FROM space_member sm JOIN space sp ON sp.ws = sm.ws
    WHERE sm.user_id = ? AND sm.revoked_at IS NULL AND (? IS NULL OR lower(sm.email) = lower(?))`).all(userId, u && u.email, u && u.email);
  return [...owned, ...member];
}
function roleFor(userId, ws) {
  if (db().prepare('SELECT 1 FROM space WHERE ws = ? AND owner_user_id = ?').get(ws, userId)) return 'owner';
  const m = db().prepare('SELECT role FROM space_member WHERE ws = ? AND user_id = ? AND revoked_at IS NULL').get(ws, userId);
  return m ? m.role : null;
}
const spaceOf = (ws) => db().prepare('SELECT * FROM space WHERE ws = ?').get(ws);
const isOwnedSpace = (ws) => !!spaceOf(ws);
function spaceIdentity(ws) {
  const sp = spaceOf(ws);
  if (!sp) return null;
  const u = db().prepare('SELECT name, email FROM user WHERE id = ?').get(sp.owner_user_id);
  return { space: sp.display_name, owner: (u && (u.name || u.email)) || 'its owner' };
}

function inviteEmail(ws, email, role, invitedBy) {
  const existing = db().prepare('SELECT * FROM space_member WHERE ws = ? AND lower(email) = lower(?)').get(ws, email);
  if (existing && !existing.revoked_at) throw new Error(`${email} is already invited to this space.`);
  const u = db().prepare('SELECT id FROM user WHERE lower(email) = lower(?)').get(email);
  if (existing) db().prepare('UPDATE space_member SET role = ?, user_id = ?, revoked_at = NULL, created_at = ? WHERE ws = ? AND lower(email) = lower(?)')
    .run(role, u ? u.id : null, now(), ws, email);
  else db().prepare('INSERT INTO space_member (ws, email, user_id, role, invited_by, created_at) VALUES (?,?,?,?,?,?)')
    .run(ws, email, u ? u.id : null, role, invitedBy || null, now());
  return { email, role, active: !!u };
}
const emailMembers = (ws) => db().prepare('SELECT email, role, user_id IS NOT NULL AS joined, revoked_at, created_at FROM space_member WHERE ws = ? ORDER BY created_at').all(ws);
const revokeEmail = (ws, email) => db().prepare('UPDATE space_member SET revoked_at = ? WHERE ws = ? AND lower(email) = lower(?) AND revoked_at IS NULL').run(now(), ws, email).changes;

/** The first-touch cookie, as the public pages set it: sb_src=<urlencoded JSON {r,p,s,m,c,t}>. */
function parseSrcCookie(cookieHeader) {
  const m = /(?:^|;\s*)sb_src=([^;]+)/.exec(cookieHeader || '');
  if (!m) return null;
  try { const v = JSON.parse(decodeURIComponent(m[1])); return typeof v === 'object' && v ? v : null; } catch { return null; }
}
function recordAcquisition(ws, kind, src) {
  const v = src || {};
  db().prepare(`INSERT OR IGNORE INTO acquisition (ws, kind, referrer, landing, source, medium, campaign, first_seen, at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(ws, kind, v.r || null, v.p || null, v.s || null, v.m || null, v.c || null, v.t || null, now());
}
const acquisitionOf = (ws) => db().prepare('SELECT * FROM acquisition WHERE ws = ?').get(ws) || null;
/** Channel label for a row: utm_source first, else the referrer host, else 'direct / unknown'. */
const channelOf = (a) => !a ? 'unknown' : (a.source ? `${a.source}${a.medium ? '/' + a.medium : ''}` : (a.referrer || 'direct'));
function acquisitionSummary() {
  const rows = db().prepare('SELECT * FROM acquisition').all();
  const by = {};
  for (const a of rows) { const k = channelOf(a); by[k] = by[k] || { channel: k, sandboxes: 0, spaces: 0 }; by[k][a.kind === 'space' ? 'spaces' : 'sandboxes']++; }
  return Object.values(by).sort((x, y) => (y.spaces * 10 + y.sandboxes) - (x.spaces * 10 + x.sandboxes));
}

module.exports = { db, upsertUser, createSession, userForSession, dropSession, createSpace, claimSpace, deleteSpace,
  parseSrcCookie, recordAcquisition, acquisitionOf, channelOf, acquisitionSummary,
  spacesFor, roleFor, spaceOf, isOwnedSpace, spaceIdentity, inviteEmail, emailMembers, revokeEmail };
