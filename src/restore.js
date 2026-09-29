'use strict';
/**
 * Bring books in from an export: the other half of /api/export, so a space can move between
 * saybooks.io and a Mac (hostel's local books) in either direction.
 *
 * Only into empty books: a merge of two histories would need rules nobody has written, and an
 * import that silently overwrites is exactly what the record exists to prevent. The target
 * gets the schema this build knows; each exported table lands column by column where the
 * names match. An export from a NEWER build (a migration this build has never run) is refused
 * whole, because rows shaped by rules this code does not know would be read by rules it does.
 * The import itself goes on the record, after the history it brought in.
 */
const wsp = require('./workspace.js');

function fail(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function tablesOf(h) {
  return h.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
}

/** Acts on the record. Zero means "empty books": migrations may seed defaults (the job
 *  hunt's config rows), but nothing has been done in them yet. */
function rowCount(h) {
  return h.prepare('SELECT COUNT(*) AS n FROM command_log').get().n;
}

function check(dump) {
  if (!dump || typeof dump !== 'object' || !dump.tables || typeof dump.tables !== 'object' || Array.isArray(dump.tables))
    throw fail('That file is not a Saybooks export: it has no tables. Use the file that "Export these books" gives you.');
  for (const [t, rows] of Object.entries(dump.tables)) {
    if (!Array.isArray(rows)) throw fail(`That file is not a Saybooks export: table ${t} is not a list of rows.`);
  }
}

/** Which modules the export actually uses: a module whose tables hold a row. */
function modulesUsed(dump, modules) {
  return modules.filter(m => m.name !== 'core' && (m.tables || []).some(t => (dump.tables[t] || []).length)).map(m => m.name);
}

/**
 * Restore `dump` into workspace `ws`. Returns { tables, rows, skipped, from, exported_at }.
 * Throws an Error with .status and a sentence a person can act on.
 */
function restoreInto(ws, dump, actor = 'operator') {
  check(dump);
  const h = wsp.dbFor(ws);
  if (rowCount(h) > 0) throw fail('These books already hold entries. An export goes into empty books only, so nothing on the record is overwritten or mixed; start new books for it.', 409);

  const known = new Set(h.prepare("SELECT module || ':' || seq AS k FROM schema_migration").all().map(r => r.k));
  const newer = (dump.tables.schema_migration || []).filter(m => !known.has(`${m.module}:${m.seq}`));
  if (newer.length) {
    const names = [...new Set(newer.map(m => m.module))].join(', ');
    throw fail(`This export comes from a newer Saybooks than this one (it has changes to ${names} this version does not know). Update this copy first, then import again.`, 409);
  }

  const here = new Set(tablesOf(h));
  const skipped = [];
  let rows = 0, tables = 0;
  const run = () => {
    for (const [t, list] of Object.entries(dump.tables)) {
      if (t === 'schema_migration') continue;
      if (!here.has(t)) { if (list.length) skipped.push(`${t} (${list.length} rows): no such table in this version`); continue; }
      // The export mirrors the source exactly: a table it carries replaces whatever defaults
      // this build's migrations seeded. A table it does not carry keeps them.
      h.prepare(`DELETE FROM "${t}"`).run();
      if (!list.length) continue;
      const cols = new Set(h.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name));
      const use = Object.keys(list[0]).filter(c => cols.has(c));
      const dropped = Object.keys(list[0]).filter(c => !cols.has(c));
      if (dropped.length) skipped.push(`${t}: columns ${dropped.join(', ')} are not in this version`);
      const ins = h.prepare(`INSERT INTO "${t}" (${use.map(c => `"${c}"`).join(',')}) VALUES (${use.map(() => '?').join(',')})`);
      for (const r of list) ins.run(...use.map(c => r[c] === undefined ? null : r[c]));
      rows += list.length; tables++;
    }
    h.prepare(`INSERT INTO command_log (at, command, actor_kind, actor, reason, subject_type, subject_id, args_json, ok, result_json)
      VALUES (?, 'core_import_books', 'human', ?, ?, 'workspace', ?, ?, 1, ?)`).run(
      new Date().toISOString(), actor,
      `Brought in from an export of "${dump.workspace || 'unnamed books'}" made ${dump.exported_at || 'at an unknown time'}`,
      ws, JSON.stringify({ from: dump.workspace || null, exported_at: dump.exported_at || null }),
      JSON.stringify({ tables, rows, skipped }));
  };
  h.pragma('foreign_keys = OFF');
  try {
    h.transaction(run)();
    const viol = h.pragma('foreign_key_check');
    if (viol.length) {
      wsp.wipe(ws);
      throw fail(`The export's rows do not hold together (${viol.length} references point at nothing, first in ${viol[0].table}). Nothing was imported.`, 422);
    }
  } finally { h.pragma('foreign_keys = ON'); }
  return { tables, rows, skipped, from: dump.workspace || null, exported_at: dump.exported_at || null };
}

module.exports = { restoreInto, modulesUsed, rowCount };
