/**
 * Does the workbench actually RUN?
 *
 * The contract suite's "ui scripts" gate proves every inline script PARSES. It cannot prove
 * that a view calls a function that exists: a helper declared inside another function is
 * perfectly valid JavaScript right up to the moment a render reaches it, and then the view
 * paints nothing and the tab looks broken for no visible reason. That happened, twice.
 *
 * So: start a server on a scratch database, seed one of everything, drive a real headless
 * Chrome through every view in NAV, and fail on any thrown exception, console error, or view
 * that renders nothing at all.
 *
 *   npm run smoke
 *
 * Chrome is not a dependency of this project and this is not part of `npm test`. With no
 * Chrome on the machine it says so and exits 0 — a check you cannot run is not a failure,
 * but it must say which it was.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8197, CDP = 9335;
const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const chrome = CHROMES.find(p => fs.existsSync(p));
if (!chrome) {
  console.log('SKIPPED: no Chrome or Chromium on this machine, so the workbench was not rendered.');
  console.log('The contract suite still proves the scripts parse; it cannot prove they run.');
  process.exit(0);
}

const SEED = String.raw`
const R = require(ROOT + '/src/registry.js'); R.loadModules();
const WS = 'main';
const h = { workspace: WS, actor: 'smoke', actor_kind: 'human' };
const a = { workspace: WS, actor: 'smoke-agent', actor_kind: 'agent', role: 'owner' };
R.execute('core_set_company_profile', { name: 'Smoke Co', country: 'US', currency: 'USD' }, h);
const cu = R.execute('core_create_customer', { name: 'Northwind', terms: 'net30' }, h);
R.execute('core_create_item', { sku: 'W-1', name: 'Widget', unit_price: 4500, stocked: true, on_hand: 50 }, h);
const o = R.execute('o2c_create_order', { customer_id: cu.id, lines: [{ item_id: 'W-1', qty: 2 }] }, h);
R.execute('solo_draft_invoice', { customer_id: cu.id, due_in_days: 30, lines: [{ description: 'Consulting', qty: 1, rate: 120000 }] }, h);
R.execute('crm_create_campaign', { name: 'Smoke campaign', goal: 'Exercise every crm view with real rows.' }, h);
const acc = R.execute('crm_add_account', { campaign_id: 'CAM-0001', name: 'Harborline Freight', why_them: 'Announced a claims review and runs it in-house.', source_url: 'https://example.com/h' }, h);
const c = R.execute('crm_add_contact', { account_id: acc.id, role_type: 'OPERATIONS OWNER', name: 'Dana Reeve', title: 'VP Operations', source: 'https://example.com/h/team', confidence_note: 'Leadership page.' }, h);
R.execute('crm_add_contact', { account_id: acc.id, role_type: 'ECONOMIC SPONSOR', gap_note: 'No CFO named publicly.' }, h);
R.execute('crm_update_contact', { contact_id: c.id, mutual_via: 'Alex M.', linkedin_path: '2nd' }, h);
R.execute('crm_log_activity', { account_id: acc.id, summary: 'Intro call.', occurred_at: '2026-09-01', direction: 'outbound', medium: 'call' }, h);
const d1 = R.execute('crm_draft_message', { contact_id: c.id, subject: 'The claims review', body: 'Dana, worth twenty minutes?', rationale: 'Opens on the trigger.' }, a);
R.execute('crm_draft_outcome', { draft_id: d1.draft, outcome: 'sent', sent_at: '2026-09-02' }, h);
const d2 = R.execute('crm_draft_message', { contact_id: c.id, body: 'Following up on the note.', rationale: 'A nudge, one week on.' }, a);
const d3 = R.execute('crm_draft_message', { contact_id: c.id, body: 'Third angle on the review.', rationale: 'Different opening.' }, a);
R.execute('crm_draft_outcome', { draft_id: d3.draft, outcome: 'discarded', rejected_because: 'Too long, and it opened on us.' }, h);
R.execute('pros_import_rows', { label: 'Phoenix metro', hash: 'sha256:smoketest0001', campaign_id: 'CAM-0001', criteria: 'Phoenix metro, 200-1000 staff, desk-based transaction work.', row_count: 2, rows: [
  { company: 'Saguaro Claims', industry: 'insurance', employees: 640, city: 'Phoenix', state: 'AZ', website: 'https://saguaro.example', description: 'Third-party administrator handling claims adjudication.' },
  { company: 'Copper State Hospitality', industry: 'hospitality', employees: 910, city: 'Scottsdale', state: 'AZ', description: 'Restaurants and resorts.' }] }, a);
R.execute('pros_qualify', { verdicts: [
  { row_id: 1, verdict: 'qualified', reason: 'TPA: adjudication is the desk-based work the brief asks for.' },
  { row_id: 2, verdict: 'rejected', reason: 'Hospitality: front-of-house headcount, nothing to measure.' }] }, a);
R.execute('pros_promote', { campaign_id: 'CAM-0001', row_ids: [{ row_id: 1 }] }, h);
R.execute('purch_import_statement', { name: 'aug.csv', hash: 'sha256:smokestmt0001', kind: 'card', currency: 'USD', period_start: '2026-08-01', period_end: '2026-08-31', opening_balance: 0, closing_balance: -5000, row_count: 2,
  rows: [{ date: '2026-08-03', amount: -3000, description: 'COFFEE CO' }, { date: '2026-08-10', amount: -2000, description: 'RENT' }] }, a);
R.execute('hunt_add_posting', { company: 'Vega', title: 'Staff Engineer', source: 'direct', url: 'https://example.com/j' }, h);
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saybooks-smoke-'));
const kids = [];
const cleanup = () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch {} } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));

// ---- seed: one of everything a view might show, through the real registry ----
// Written to a file rather than passed with -e: the seed is a page of real commands, and
// shell-escaping a page of JavaScript is how a test starts failing for reasons of its own.
const seed = path.join(tmp, 'seed.cjs');
fs.writeFileSync(seed, `const ROOT = ${JSON.stringify(ROOT)};
` + SEED);
execSync(`node ${JSON.stringify(seed)}`, { cwd: ROOT, env: { ...process.env, SAYBOOKS_DATA: tmp }, stdio: ['ignore', 'inherit', 'inherit'] });

// ---- the two processes ----
kids.push(spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, SAYBOOKS_DATA: tmp, SAYBOOKS_PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] }));
kids.push(spawn(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' }));

const until = async (fn, ms = 20000) => {
  const stop = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() > stop) throw new Error('timed out'); await new Promise(r => setTimeout(r, 250)); }
};
await until(async () => (await fetch(`http://127.0.0.1:${PORT}/api/registry`)).ok);
const target = await until(async () => (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json());

// ---- drive it ----
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); let errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push('threw: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(x => x.description || x.value).join(' ').split('\n')[0]);
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
// An awaited promise that REJECTS comes back as exceptionDetails on this response; it does
// not fire Runtime.exceptionThrown. Listening only for the event misses every failure inside
// an async render, which is every failure worth catching here.
const evalJS = async (expression) => {
  const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result;
  const x = r?.exceptionDetails;
  if (x) errors.push('threw: ' + (x.exception?.description || x.text || 'unknown').split('\n')[0]);
  return r?.result?.value;
};
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/app` });
await new Promise(r => setTimeout(r, 2500));

const views = JSON.parse(await evalJS('JSON.stringify(NAV.filter(e => e.tabs).flatMap(e => e.tabs.map(t => t[0])))') || '[]');
if (!views.length) { console.error('FAILED: the workbench did not boot at all.'); process.exit(1); }
let bad = 0;
for (const v of views) {
  errors = [];
  await evalJS(`(async () => { selected = null; view = ${JSON.stringify(v)}; await render(); })()`);
  await new Promise(r => setTimeout(r, 250));
  const chars = await evalJS('document.getElementById("main") ? document.getElementById("main").innerText.trim().length : -1');
  const why = errors.length ? errors[0] : chars <= 0 ? 'rendered nothing at all' : null;
  if (why) { bad++; console.log(`  FAIL ${v} — ${why}`); } else { console.log(`  ok   ${v} (${chars} chars)`); }
}
console.log(`\n${views.length - bad}/${views.length} workbench views render without error.`);
ws.close();
process.exit(bad ? 1 : 0);
