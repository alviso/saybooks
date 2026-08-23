#!/usr/bin/env node
'use strict';
/**
 * One-off importer: huntctrl (huntctrl.db) -> a Saybooks jobhunt workspace.
 * Everything through execute() — same guards, same audit trail. Interactions replay in
 * chronological order so the supersede chain rebuilds itself; historical non-open next
 * actions are folded into the summary honestly rather than faked into the state machine.
 *
 *   node scripts/import-huntctrl.js /path/to/huntctrl.db [workspace=hunt] [--force]
 */
const Database = require('better-sqlite3');
const R = require('../src/registry.js');
const wsp = require('../src/workspace.js');

const [, , srcPath, wsArg] = process.argv;
if (!srcPath) { console.error('usage: node scripts/import-huntctrl.js /path/to/huntctrl.db [workspace] [--force]'); process.exit(1); }
const WS = (wsArg && !wsArg.startsWith('--')) ? wsArg : 'hunt';
const FORCE = process.argv.includes('--force');

R.loadModules();
const src = new Database(srcPath, { readonly: true });
const H = require('../src/db.js');
const ctx = (reason) => ({ workspace: WS, actor: 'peter', actor_kind: 'human', session: 'import:huntctrl', reason });
const clean = (v) => (v && String(v).trim()) || undefined;

const existing = wsp.use(WS, () => H.db().prepare('SELECT COUNT(*) c FROM hunt_posting').get().c);
if (existing > 0 && !FORCE) { console.error(`workspace "${WS}" has ${existing} postings — pass --force to wipe and re-import`); process.exit(1); }
if (FORCE) wsp.wipe(WS);

const co = new Map(), ct = new Map(), rv = new Map(), po = new Map(), ap = new Map(), iv = new Map();
const srcCo = (id) => id && src.prepare('SELECT * FROM company WHERE id = ?').get(id);
const report = { companies: 0, contacts: 0, resumes: 0, postings: 0, warnings: 0, applications: 0, interviews: 0, interactions: 0, skipped: [] };

// resume versions
for (const r of src.prepare('SELECT * FROM resume_version ORDER BY id').all()) {
  const out = R.execute('hunt_add_resume_version', { label: r.label, platform: clean(r.platform), external_id: clean(r.external_id),
    headline: clean(r.headline), focus: clean(r.focus), file_path: clean(r.file_path), notes: clean(r.notes) }, ctx('imported from huntctrl'));
  rv.set(r.id, out.id); report.resumes++;
}
// contacts (companies created implicitly by name)
for (const c of src.prepare('SELECT * FROM contact ORDER BY id').all()) {
  const comp = srcCo(c.company_id);
  const out = R.execute('hunt_add_contact', { name: c.name, source: c.source || 'imported from huntctrl (source column empty — verify)',
    company: comp && comp.name, company_kind: comp && clean(comp.kind), role: clean(c.role), email: clean(c.email), phone: clean(c.phone),
    linkedin_url: clean(c.linkedin_url), relationship: clean(c.relationship), notes: clean(c.notes) }, ctx('imported from huntctrl'));
  ct.set(c.id, out.id); report.contacts++;
}
// postings — the guard runs on every add; its warnings are counted, not suppressed (JH-3)
for (const p of src.prepare('SELECT * FROM posting ORDER BY id').all()) {
  const comp = srcCo(p.company_id), ec = srcCo(p.end_client_id);
  const cents = (v) => (v == null ? undefined : Math.round(v * 100));   // huntctrl stored dollars
  const out = R.execute('hunt_add_posting', { title: p.title, company: comp.name, company_kind: clean(comp.kind),
    end_client: ec && ec.name, req_id: clean(p.req_id), source: clean(p.source), url: clean(p.url), jd_text: clean(p.jd_text),
    location: clean(p.location), work_mode: clean(p.work_mode), comp_min: cents(p.comp_min), comp_max: cents(p.comp_max),
    comp_notes: clean(p.comp_notes), employment_type: clean(p.employment_type), red_flags: clean(p.red_flags) }, ctx('imported from huntctrl'));
  po.set(p.id, out.id); report.postings++; report.warnings += out.warning_count;
  if (p.status === 'skipped') {
    R.execute('hunt_evaluate_posting', { posting_id: out.id, fit_score: p.fit_score ?? undefined, fit_notes: clean(p.fit_notes),
      skip_reason: p.skip_reason || 'skipped in huntctrl without a recorded reason (pre-spec row)' }, ctx('imported skip'));
  } else if (p.status === 'evaluated' || p.fit_score != null || p.fit_notes) {
    R.execute('hunt_evaluate_posting', { posting_id: out.id, fit_score: p.fit_score ?? undefined, fit_notes: clean(p.fit_notes),
      resume_version: p.resume_version_id ? rv.get(p.resume_version_id) : undefined, red_flags: clean(p.red_flags) }, ctx('imported evaluation'));
  }
}
// applications
for (const a of src.prepare('SELECT * FROM application ORDER BY id').all()) {
  const out = R.execute('hunt_apply', { posting_id: po.get(a.posting_id), resume_version: a.resume_version_id ? rv.get(a.resume_version_id) : undefined,
    channel: clean(a.channel), via_contact: a.submitted_via_contact_id ? ct.get(a.submitted_via_contact_id) : undefined,
    applied_at: clean(a.applied_at) || 'unknown' }, ctx('imported application'));
  ap.set(a.id, out.application.id); report.applications++;
  if (a.status !== 'submitted') {
    R.execute('hunt_set_application_status', { application_id: out.application.id, status: a.status, note: `status carried from huntctrl` }, ctx('imported status'));
  }
}
// interviews
for (const i of src.prepare('SELECT * FROM interview ORDER BY id').all()) {
  const appId = ap.get(i.application_id);
  if (!appId) { report.skipped.push(`interview ${i.id}`); continue; }
  const out = R.execute('hunt_add_interview', { application_id: appId, round: i.round ?? undefined, kind: clean(i.kind),
    scheduled_at: clean(i.scheduled_at), interviewer: clean(i.interviewer), notes: clean(i.notes) }, ctx('imported interview'));
  iv.set(i.id, out.id); report.interviews++;
  if (i.outcome && i.outcome !== 'pending') R.execute('hunt_interview_outcome', { interview_id: out.id, outcome: i.outcome }, ctx('imported outcome'));
}
// interactions, chronological — supersede chain rebuilds; only still-open next actions carry over as state
for (const x of src.prepare('SELECT * FROM interaction ORDER BY at, id').all()) {
  const open = x.next_action && x.next_action_state === 'open';
  const summary = x.next_action && !open
    ? `${x.summary} [next action (${x.next_action_state}): ${x.next_action}]`
    : x.summary;
  R.execute('hunt_log_interaction', { direction: x.direction, summary, posting_id: x.posting_id ? po.get(x.posting_id) : undefined,
    contact_id: x.contact_id ? ct.get(x.contact_id) : undefined, medium: clean(x.medium), at: clean(x.at),
    next_action: open ? x.next_action : undefined, next_action_due: open ? clean(x.next_action_due) : undefined }, ctx('imported touch'));
  report.interactions++;
}

console.log(`\nimported into workspace "${WS}":`);
console.log(`  companies (implicit): ${wsp.use(WS, () => H.db().prepare('SELECT COUNT(*) c FROM hunt_company').get().c)}  contacts: ${report.contacts}  resumes: ${report.resumes}`);
console.log(`  postings: ${report.postings} (guard raised ${report.warnings} warnings during replay — same reqs via multiple agencies, as expected)`);
console.log(`  applications: ${report.applications}  interviews: ${report.interviews}  interactions: ${report.interactions}`);
if (report.skipped.length) console.log('  skipped:', report.skipped.join('; '));
console.log(`\nbrowse:  npm start  →  http://127.0.0.1:8140/?ws=${WS}`);
console.log(`agent:   claude mcp add hunt -e SAYBOOKS_WORKSPACE=${WS} -- node ${__dirname}/../mcp-server.js`);
