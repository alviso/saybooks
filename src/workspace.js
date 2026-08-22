'use strict';
/**
 * Workspaces: one deployment, one registry, one set of rules — a database per contributor.
 *
 * Code is shared; data is not. Two people testing conversationally against the same rows
 * corrupt each other's runs, so every session names a workspace and gets its own SQLite
 * file under data/. The registry's execute() enters a workspace before touching a handler;
 * everything downstream just calls db() and gets the right file.
 *
 * better-sqlite3 is synchronous and execute() is a single synchronous choke point, so a
 * module-level "current" pointer is safe: nothing can interleave mid-command.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.SAYBOOKS_DATA || process.env.OTC_DATA || path.join(__dirname, '..', 'data');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

const open = new Map();          // workspace name -> Database
let current = null;              // the workspace the running command executes in
let migrations = [];             // [{module, seq, name, sql}] — registered before first open

function registerMigrations(module, dir) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).sort()) {
    const m = /^(\d{3})_(.+)\.sql$/.exec(file);
    if (!m) throw new Error(`${module}: migration ${file} must be named NNN_name.sql`);
    migrations.push({ module, seq: Number(m[1]), name: m[2], sql: fs.readFileSync(path.join(dir, file), 'utf8') });
  }
}

function migrate(handle) {
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    module TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL,
    PRIMARY KEY (module, seq))`);
  const done = new Set(handle.prepare("SELECT module || ':' || seq AS k FROM schema_migration").all().map(r => r.k));
  for (const m of migrations) {
    if (done.has(`${m.module}:${m.seq}`)) continue;
    handle.transaction(() => {
      handle.exec(m.sql);
      handle.prepare('INSERT INTO schema_migration (module,seq,name,applied_at) VALUES (?,?,?,?)')
        .run(m.module, m.seq, m.name, new Date().toISOString());
    })();
  }
}

function dbFor(workspace) {
  if (!NAME_RE.test(workspace)) throw new Error(`invalid workspace name "${workspace}" — lowercase letters, digits, - and _`);
  if (!open.has(workspace)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const handle = new Database(path.join(DATA_DIR, `ws_${workspace}.db`));
    migrate(handle);
    open.set(workspace, handle);
  }
  return open.get(workspace);
}

/** Run fn with `workspace` current. Synchronous by design — a handler that awaits would break
 *  this, and handlers are synchronous by the same registry contract that logs them atomically. */
function use(workspace, fn) {
  const prev = current;
  current = workspace;
  try { return fn(); } finally { current = prev; }
}

function db() {
  if (!current) throw new Error('no current workspace — reads and writes go through execute() or workspace.use()');
  return dbFor(current);
}

const currentName = () => current;

function list() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return fs.readdirSync(DATA_DIR).filter(f => /^ws_.+\.db$/.test(f)).map(f => f.slice(3, -3)).sort();
}

/** Wipe a workspace back to empty schema. The caller (core_reset_workspace) is env-gated;
 *  this function stays dumb on purpose. */
function wipe(workspace) {
  const handle = dbFor(workspace);
  const tables = handle.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migration') AND name NOT LIKE 'sqlite_%'`).all();
  handle.pragma('foreign_keys = OFF');
  handle.transaction(() => { for (const t of tables) handle.prepare(`DELETE FROM "${t.name}"`).run(); })();
  handle.pragma('foreign_keys = ON');
}

/** Close an open handle and delete the workspace's files. Demo cleanup only. */
function destroy(workspace) {
  if (!NAME_RE.test(workspace)) return;
  const h = open.get(workspace);
  if (h) { try { h.close(); } catch {} open.delete(workspace); }
  for (const ext of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(path.join(DATA_DIR, `ws_${workspace}.db${ext}`)); } catch {}
  }
}

/** mtime of a workspace's db file, 0 if missing. */
function ageOf(workspace) {
  try { return fs.statSync(path.join(DATA_DIR, `ws_${workspace}.db`)).mtimeMs; } catch { return 0; }
}

module.exports = { registerMigrations, dbFor, use, db, currentName, list, wipe, destroy, ageOf, DATA_DIR };
