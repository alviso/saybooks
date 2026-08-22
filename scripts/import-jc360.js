#!/usr/bin/env node
'use strict';
/**
 * One-off importer: jc360-crm (Python/Flask CRM, crm.db) -> a Saybooks workspace.
 *
 * Everything goes through execute() — the same registry, guards and audit trail as a hand
 * entry — so the imported workspace is indistinguishable from one built live, and a source
 * row that violates the spec fails loudly instead of planting quiet exceptions.
 *
 * Deliberately NOT imported (they are empty in the source, and deferred in specs/crm §9):
 * introduction, blocker, my_connection, connection_import, opportunity. Reported, not dropped.
 *
 *   node scripts/import-jc360.js /path/to/crm.db [workspace=jc360] [--force]
 */
const Database = require('better-sqlite3');
const R = require('../src/registry.js');
const wsp = require('../src/workspace.js');

const [, , srcPath, wsArg, forceArg] = process.argv;
if (!srcPath) { console.error('usage: node scripts/import-jc360.js /path/to/crm.db [workspace] [--force]'); process.exit(1); }
const WS = (wsArg && !wsArg.startsWith('--')) ? wsArg : 'jc360';
const FORCE = process.argv.includes('--force');

R.loadModules();
const src = new Database(srcPath, { readonly: true });
const ctx = (reason) => ({ workspace: WS, actor: 'peter', actor_kind: 'human', session: 'import:jc360-crm', reason });

const existing = wsp.use(WS, () => require('../src/db.js').db().prepare('SELECT COUNT(*) c FROM account').get().c);
if (existing > 0 && !FORCE) {
  console.error(`workspace "${WS}" already has ${existing} accounts — pass --force to wipe and re-import`);
  process.exit(1);
}
if (FORCE) wsp.wipe(WS);

const clean = (s) => (s && String(s).trim()) || null;
const idMap = { account: new Map(), contact: new Map() };
const report = { accounts: 0, path_in: 0, named: 0, gaps: 0, do_not_contact: 0, missing_source: [], skipped: [] };

// ---- accounts (all not_started in source; status moves would go here if there were any) ----
for (const a of src.prepare('SELECT * FROM account WHERE deleted_at IS NULL ORDER BY id').all()) {
  const noteBits = [clean(a.owner_note), clean(a.scale) && `scale: ${a.scale}`,
    clean(a.delivery_footprint) && `delivery: ${a.delivery_footprint}`,
    clean(a.priority_note) && `priority: ${a.priority_note}`].filter(Boolean);
  const acc = R.execute('crm_add_account', {
    name: a.name, tier: a.tier, vertical: clean(a.vertical),
    why_them: a.why_them, source_url: a.source_url,
    trigger_event: clean(a.trigger_event), hook: clean(a.hook),
    owner_note: noteBits.join(' · ') || undefined,
  }, ctx(`imported from jc360-crm (${a.slug})`));
  idMap.account.set(a.id, acc.id);
  report.accounts++;

  const rows = src.prepare('SELECT note AS bullet FROM account_path_in WHERE account_id = ? ORDER BY sort').all(a.id)
    .filter(b => clean(b.bullet));
  if (rows.length) {
    R.execute('crm_set_path_in', { account_id: acc.id, bullets: rows.map(b => ({ bullet: b.bullet })) }, ctx('imported path-in plan'));
    report.path_in += rows.length;
  }
}

// ---- contacts: named with provenance, or gaps; do_not_contact preserved in notes ----
for (const c of src.prepare('SELECT * FROM contact WHERE deleted_at IS NULL ORDER BY id').all()) {
  const account_id = idMap.account.get(c.account_id);
  if (!account_id) { report.skipped.push(`contact ${c.id} (${c.name || 'gap'}): account ${c.account_id} not imported`); continue; }
  const confBits = [clean(c.confidence), clean(c.confidence_note), clean(c.source_date) && `source dated ${c.source_date}`].filter(Boolean);
  const noteBits = [
    c.status === 'do_not_contact' && 'DO NOT CONTACT (carried from jc360-crm — the status said so)',
    clean(c.email) && `email: ${c.email}`,
    clean(c.linkedin_url) && `linkedin: ${c.linkedin_url}`,
    clean(c.notes),
  ].filter(Boolean);

  let contact;
  if (c.status === 'gap') {
    contact = R.execute('crm_add_contact', {
      account_id, role_type: c.role_type, gap_note: c.gap_note, notes: noteBits.join(' · ') || undefined,
    }, ctx('imported gap — what we verifiably did not know, preserved as exactly that'));
    report.gaps++;
  } else {
    let source = clean(c.source_url);
    if (!source) {
      // CRM-1 would refuse a bare name, rightly. State the provenance truthfully instead
      // of inventing a URL: the source is missing and must be fixed before a first approach.
      source = 'MISSING — imported from jc360-crm without a source; verify before first approach';
      report.missing_source.push(`${c.name} (${c.role_type})`);
    }
    contact = R.execute('crm_add_contact', {
      account_id, role_type: c.role_type, name: c.name, title: clean(c.title),
      source, confidence_note: confBits.join(' — ') || undefined, notes: noteBits.join(' · ') || undefined,
    }, ctx('imported from jc360-crm'));
    report.named++;
    if (c.status === 'do_not_contact') report.do_not_contact++;
  }
  idMap.contact.set(c.id, contact.id);
}

// ---- activities (0 in source today; mapped for completeness) ----
let activities = 0;
for (const x of src.prepare('SELECT * FROM activity WHERE deleted_at IS NULL ORDER BY occurred_at').all()) {
  const account_id = idMap.account.get(x.account_id);
  if (!account_id) continue;
  R.execute('crm_log_activity', {
    account_id, contact_id: idMap.contact.get(x.contact_id) || undefined,
    summary: [x.summary, clean(x.detail)].filter(Boolean).join(' — '),
    occurred_at: (x.occurred_at || '').slice(0, 10), medium: clean(x.type) || 'other',
  }, ctx('imported activity'));
  activities++;
}

const untouched = ['introduction', 'blocker', 'my_connection', 'connection_import', 'opportunity']
  .map(t => { try { return `${t}: ${src.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`; } catch { return null; } }).filter(Boolean);

console.log(`\nimported into workspace "${WS}":`);
console.log(`  accounts: ${report.accounts}   path-in bullets: ${report.path_in}`);
console.log(`  contacts: ${report.named} named (${report.do_not_contact} do-not-contact), ${report.gaps} gaps   activities: ${activities}`);
if (report.missing_source.length) console.log(`  ⚠ named without source (marked MISSING, fix before approaching): ${report.missing_source.join('; ')}`);
if (report.skipped.length) console.log(`  skipped: ${report.skipped.join('; ')}`);
console.log(`  left in jc360-crm (deferred per spec §9, all counts): ${untouched.join(', ')}`);
console.log(`\nbrowse it:  npm start  →  http://127.0.0.1:8140/?ws=${WS}`);
console.log(`agent:      claude mcp add jc360 -e SAYBOOKS_WORKSPACE=${WS} -- node ${__dirname}/../mcp-server.js`);
