'use strict';
/**
 * The contributor contract, as assertions. Every module — present and future — is held to:
 *
 *   1. parity        the MCP tool and the UI form derive from one declaration and cannot drift
 *   2. namespace     command names carry their module's prefix; collisions are impossible
 *   3. doctrine      every write command teaches; empty doctrine does not ship
 *   4. guards        every instance write declares its guards (or says `guardless` out loud)
 *   5. ownership     no module writes another module's tables — it uses the owner's api
 *   6. budget        at most 60 tools per module; past that, ask which commands are the same act
 *   7. mounts        a session that mounts a subset gets exactly that subset
 *   8. one sentence  a guard's tooltip and the thrown refusal are the same string, verbatim
 *   9. audit         reads never log; refused writes always do, with their actor
 *  10. fixtures      the shared fixture replays cleanly through the real registry
 *  11. conformance   every module claiming a spec area implements all its acts and passes
 *                    every scenario — the spec is enforced, not aspirational
 *  12. permissions   every command carries a permission tag; every tag is reachable by a
 *                    role; denials are the same one sentence on every surface
 *  13. human-only    a field declared human_only accepts a person and refuses an agent —
 *                    whatever the role — and the refusal is logged
 *  14. the door       a whole act can be human-only too: an agent stages and judges bought
 *                    rows, only a person promotes them, and the verdict becomes the why_them
 *  15. claim gate     a person says what a campaign may claim; the gate holds on the create
 *                    path and the edit path alike, and a sent draft stops being editable
 *  16. bills         only a person approves paying a bill; an agent records the payment once
 *                    approved, against a statement row that must match it, never twice
 *  17. 3-way match   a bill on a purchase order is approved only when it matches what was
 *                    ordered and received; loosening the match is a person's act; receipts,
 *                    approval and payment post balanced through GRNI and accounts payable
 *  18. stock moves   every change to on hand is a move through core's door, so the moves add
 *                    up to on hand for every item; the stock's value ties to the books
 *  19. the close     a person closes the books; the closed period's figures stop moving, a later
 *                    change lands as a correction on the first open day, and only the latest
 *                    close reopens
 *  20. bank rec      a deposit matched to its payment is in the books once; a payment not on the
 *                    statement yet is named in transit and the account still ties; only a person
 *                    signs off, and a later change shows as changed since
 *  21. sales tax     a month's return is the tax charged less the tax credits give back; only a
 *                    person records the filing, a payment clears the liability and waits in the
 *                    bank reconciliation, and a late change to a filed month is named
 *  22. transfers     a move between two of the person's accounts posts once, from one account
 *                    into the other; both accounts tie to their statements and reconcile; an
 *                    unpaired pair puts both rows back
 *  23. cards         a refund takes back spending in its purchase's category, in spend and in the
 *                    books; interest posts as interest; a payment of only the minimum says so
 *  24. loans         a mortgage payment posts once: principal off what is owed, interest and
 *                    escrow as spending; the books balance, checking ties and reconciles, net worth
 *                    counts what is owed, and the lender's figure is checked
 *  25. autopay       a person puts a vendor on autopay; its next bill is approved by that
 *                    decision and says whose; stopped, the next bill waits for approval again
 *
 * A PR that adds a hand-written form, a prefix-less command, or a cross-module UPDATE
 * fails here, not in review.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../src/registry.js');
const wsp = require('../src/workspace.js');
const H = require('../src/db.js');

R.loadModules();
const { COMMANDS, MODULES, mcpTools, formSpec, execute } = R;
const tools = mcpTools(), forms = formSpec();
let n = 0;
const ok = (msg) => { n++; console.log(`  ok ${msg}`); };

// ---------------------------------------------------------------- 1. parity
assert.strictEqual(tools.length, COMMANDS.length);
assert.strictEqual(forms.length, COMMANDS.length);
for (const c of COMMANDS) {
  const t = tools.find(x => x.name === c.name), f = forms.find(x => x.name === c.name);
  assert.deepStrictEqual(
    Object.keys(t.inputSchema.properties).sort(), f.fields.map(x => x.key).sort(),
    `${c.name}: fields differ between MCP and UI`);
  assert.deepStrictEqual(
    [...t.inputSchema.required].sort(), f.fields.filter(x => x.required).map(x => x.key).sort(),
    `${c.name}: required differs between MCP and UI`);
  assert.ok(t.description.includes(c.summary), `${c.name}: tool description lost its summary`);
  if (c.doctrine) {
    const first = c.doctrine.trim().split('\n')[0];
    assert.ok(t.description.includes(first), `${c.name}: doctrine not reaching the model`);
    assert.ok(f.help.includes(first), `${c.name}: doctrine not reaching the human`);
  }
  for (const fld of f.fields) {
    assert.ok(fld.widget, `${c.name}.${fld.key}: no widget — the UI could not render it`);
    const spec = c.args[fld.key];
    if (spec.enum) assert.deepStrictEqual(fld.options, spec.enum, `${c.name}.${fld.key}: enum drift`);
  }
}
ok(`parity: ${COMMANDS.length} commands → identical fields, required sets, enums and doctrine on both surfaces`);

// ---------------------------------------------------------------- 2. namespace
for (const m of MODULES) {
  assert.ok(/^[a-z][a-z0-9]*$/.test(m.prefix), `${m.name}: prefix must be a bare lowercase word`);
  for (const name of m.commands) {
    assert.ok(name.startsWith(`${m.prefix}_`), `${name}: must be prefixed ${m.prefix}_ (module ${m.name})`);
  }
}
for (const c of COMMANDS) assert.ok(c.module, `${c.name}: not attributed to any module`);
ok(`namespace: every command carries its module prefix (${MODULES.map(m => `${m.prefix}_*`).join(', ')})`);

// ---------------------------------------------------------------- 3. doctrine
for (const c of COMMANDS.filter(c => c.intent === 'write')) {
  assert.ok(c.doctrine && c.doctrine.trim().length >= 40,
    `${c.name}: a write command must teach — doctrine is missing or too thin to mean anything`);
}
ok('doctrine: every write command carries real prose for the model and the human');

// ---------------------------------------------------------------- 4. guards
for (const c of COMMANDS.filter(c => c.intent === 'write' && c.scope === 'instance')) {
  assert.ok(c.guards.length > 0 || c.guardless === true,
    `${c.name}: an instance write must declare guards, or declare guardless: true on purpose`);
}
ok('guards: every instance write declares what blocks it (or says guardless out loud)');

// ---------------------------------------------------------------- 5. ownership
const owner = {};
for (const m of MODULES) for (const t of m.tables) {
  assert.ok(!owner[t], `table ${t} claimed by both ${owner[t]} and ${m.name}`);
  owner[t] = m.name;
}
// Case-sensitive on purpose: SQL keywords in this codebase are uppercase; prose like a
// command title "Update contact" must not read as an UPDATE statement.
const WRITE_RE = /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:\\?["'`])?([a-z_]+)/g;
for (const m of MODULES) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.js')) files.push(path.join(d, e.name));
    }
  })(m.dir);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(WRITE_RE)) {
      const table = match[1].toLowerCase();
      if (!owner[table]) continue;                    // registry-owned or not a table
      assert.strictEqual(owner[table], m.name,
        `${path.relative(m.dir, file)} (module ${m.name}) writes ${table}, owned by ${owner[table]} — use ${owner[table]}'s api instead`);
    }
  }
}
ok('ownership: no module writes a table it does not own (reads and joins stay free)');

// ---------------------------------------------------------------- 6. budget
for (const m of MODULES) {
  // 25 until 14 Sep 2026; raised to 60 when crm hit the ceiling with drafts and events
  // still to come. The cap is ours, not the protocol's. Per-session tool count is what the
  // model actually feels, and that is governed by mounts, not by this number.
  assert.ok(m.commands.length <= 60,
    `${m.name}: ${m.commands.length} commands — past 60, ask which of these are really the same business act`);
}
ok(`budget: ${MODULES.map(m => `${m.name}=${m.commands.length}`).join(', ')} — all within the 60-tool cap`);

// ---------------------------------------------------------------- 7. mounts
for (const m of MODULES) {
  const mounted = mcpTools({ modules: [m.name] });
  assert.deepStrictEqual(mounted.map(t => t.name).sort(), [...m.commands].sort(),
    `mounting only ${m.name} must yield exactly its commands`);
}
ok('mounts: a session that mounts a subset of modules gets exactly that subset of tools');

// ---------------------------------------------------------------- live checks, own workspace
const WS = 'test-contract';
wsp.wipe(WS);
const human = { workspace: WS, actor: 'test', actor_kind: 'human' };
const agent = { workspace: WS, actor: 'test-agent', actor_kind: 'agent' };

// 10 first, because everything below runs against the seeded state.
const replayed = require('../src/fixtures.js').load('acme', WS);
assert.ok(replayed >= 10);
ok(`fixtures: acme replays ${replayed} commands cleanly through the real registry`);

// 8. one sentence
const blocked = wsp.use(WS, () => R.nextActions('order', 'SO-0001')).actions
  .find(a => !a.available && a.command === 'o2c_confirm_order');
let thrown = null;
try { execute('o2c_confirm_order', { order_id: 'SO-0001' }, human); } catch (e) { thrown = e.message; }
assert.strictEqual(blocked.reason, thrown, 'the greyed-out tooltip and the thrown refusal are different sentences');
ok('one sentence: guard reason and thrown refusal are the same string, verbatim');

// 9. audit
const count = () => wsp.use(WS, () => H.db().prepare('SELECT COUNT(*) c FROM command_log').get().c);
const before = count();
execute('o2c_ar_aging', {}, agent);
execute('o2c_backorders', {}, agent);
assert.strictEqual(count(), before, 'reads must not touch the audit trail');
try { execute('core_receive_stock', { item_id: 'INSTALL', qty: 1 }, agent); assert.fail('should have been refused'); }
catch (e) { assert.match(e.message, /service item/); }
const last = wsp.use(WS, () => H.db().prepare('SELECT * FROM command_log ORDER BY id DESC LIMIT 1').get());
assert.strictEqual(last.ok, 0);
assert.strictEqual(last.actor_kind, 'agent');
ok('audit: reads never log; the refused agent write is recorded with its actor and the reason');

// ---------------------------------------------------------------- 11. conformance
const C = require('../src/conformance.js');
for (const m of MODULES.filter(m => m.implements)) {
  const report = C.runArea(m.implements.area, { actor: 'contract-test' });
  const missing = report.acts.filter(a => !a.implemented);
  assert.strictEqual(missing.length, 0,
    `${m.name} claims ${m.implements.area}@${m.implements.spec} but is missing acts: ${missing.map(a => a.act).join(', ')}`);
  for (const s2 of report.scenarios) {
    const failed = s2.steps.filter(st => !st.pass);
    assert.ok(s2.pass, `${m.implements.area} scenario ${s2.file} failed:\n` + failed.map(st => `  ${st.act}: ${st.refusal}`).join('\n'));
  }
  ok(`conformance: ${m.name} implements ${m.implements.area}@${m.implements.spec} — ${report.acts.length} acts mapped, ${report.scenarios.length} scenarios pass; evidence persisted`);
}

// ---------------------------------------------------------------- 12. permissions
for (const c of COMMANDS) {
  assert.ok(c.permission, `${c.name}: no permission tag — unpermissioned commands do not ship`);
  assert.ok(R.PERMISSIONS.includes(c.permission), `${c.name}: unknown permission ${c.permission}`);
}
for (const tag of R.PERMISSIONS) {
  assert.ok(Object.values(R.ROLE_GRANTS).some(g => g.has(tag)), `permission ${tag} is reachable by no role`);
}
// a clerk hitting credit authority: same sentence from availableFor and from execute
{
  const clerkActions = wsp.use(WS, () => R.nextActions('customer', 'C-0001', 'clerk'));
  const blocked = clerkActions.actions.find(a => a.command === 'core_set_credit_limit');
  assert.ok(blocked && !blocked.available, 'clerk should not see set_credit_limit as available');
  let thrown = null;
  try { execute('core_set_credit_limit', { customer_id: 'C-0001', credit_limit: 1, reason: 'x' }, { ...human, role: 'clerk' }); }
  catch (e) { thrown = e.message; }
  assert.strictEqual(blocked.reason, thrown, 'permission denial: tooltip and thrown refusal differ');
  const lastRow = wsp.use(WS, () => H.db().prepare('SELECT * FROM command_log ORDER BY id DESC LIMIT 1').get());
  assert.strictEqual(lastRow.ok, 0, 'the denial must be logged');
  assert.ok(lastRow.error.includes('credit.authority'), 'logged denial names the permission');
  // and a viewer cannot write at all, but can read
  let vDenied = false;
  try { execute('o2c_create_order', { customer_id: 'C-0001', lines: [{ item_id: 'WIDGET-A', qty: 1 }] }, { ...human, role: 'viewer' }); }
  catch (e) { vDenied = e.message.includes('sales.write'); }
  assert.ok(vDenied, 'viewer write must be denied naming the permission');
  execute('o2c_ar_aging', {}, { ...human, role: 'viewer' });
  ok('permissions: every command tagged, every tag reachable; denial is one sentence on both surfaces, logged; viewer reads but cannot write');

// ---------------------------------------------------------------- ui scripts parse
// Not a module gate — a build guard. The workbench is one HTML file whose only </body> lives
// inside a JavaScript string; a careless insertion once split the script and served the
// A module's declared spec version and its area's acts.json must agree, or the Spec tab
// reports a run against a version nobody is implementing. (Bit once: purchases went to 0.2 in
// the spec while the module still said 0.1, and the evidence never rebuilt.)
{
  for (const m of R.MODULES.filter(m => m.implements)) {
    const acts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'specs', m.implements.area, 'acts.json'), 'utf8'));
    assert.equal(m.implements.spec, acts.spec, `${m.name}: module declares ${m.implements.area}@${m.implements.spec} but specs/${m.implements.area}/acts.json says ${acts.spec}`);
    for (const act of Object.keys(acts.acts)) {
      assert.ok(m.implements.acts[act], `${m.name}: spec act "${act}" is not mapped to a command in the implements map`);
    }
  }
  ok('spec version: every module implements the version its acts.json declares, and every act it lists');
}

// source as text. Every inline script in every page must compile.
{
  const vm = require('vm');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'ui')).filter(n => n.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');
    // JSON-LD blocks (type="application/ld+json") are data for search engines, not scripts: they must parse as JSON instead.
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({ attrs: m[1], src: m[2] }));
    blocks.forEach(({ attrs, src }, i) => {
      if (/type=["']application\/ld\+json["']/.test(attrs)) { try { JSON.parse(src); } catch (e) { assert.fail(`${f}: JSON-LD block ${i} is not valid JSON — ${e.message}`); } return; }
      try { new vm.Script(src, { filename: `${f}#${i}` }); } catch (e) { assert.fail(`${f}: inline script ${i} does not parse — ${e.message}`); }
    });
  }
  ok('ui scripts: every inline script in ui/*.html parses');
}
}

// ---------------------------------------------------------------- 13. human-only fields
{
  execute('crm_create_campaign', { name: 'Gate13 campaign', goal: 'exercise the human-only gate' }, human);
  const g13camp = wsp.use(WS, () => H.db().prepare("SELECT id FROM campaign WHERE name = 'Gate13 campaign'").get().id);
  execute('crm_add_account', { campaign_id: g13camp, name: 'Gate13 Co', why_them: 'test', source_url: 'https://example.com' }, human);
  const g13acc = wsp.use(WS, () => H.db().prepare("SELECT id FROM account WHERE name = 'Gate13 Co'").get().id);
  const g13c = execute('crm_add_contact', { account_id: g13acc, role_type: 'OPERATIONS OWNER', name: 'Pat Test', source: 'https://example.com/team' }, human);
  execute('crm_update_contact', { contact_id: g13c.id, mutual_via: 'a real person typed this' }, human);
  const asHuman = wsp.use(WS, () => H.db().prepare('SELECT mutual_via FROM contact WHERE id = ?').get(g13c.id).mutual_via);
  assert.strictEqual(asHuman, 'a real person typed this', 'a human write to a human_only field must land');
  let denied = null;
  try { execute('crm_update_contact', { contact_id: g13c.id, mutual_via: 'agent tries' }, { ...human, actor_kind: 'agent', role: 'owner' }); }
  catch (e) { denied = e.message; }
  assert.ok(denied && denied.includes('human-only'), 'agent write to human_only must be refused naming human-only');
  const row = wsp.use(WS, () => H.db().prepare('SELECT * FROM command_log ORDER BY id DESC LIMIT 1').get());
  assert.strictEqual(row.ok, 0, 'the human-only denial must be logged');
  const still = wsp.use(WS, () => H.db().prepare('SELECT mutual_via FROM contact WHERE id = ?').get(g13c.id).mutual_via);
  assert.strictEqual(still, 'a real person typed this', 'the refused agent write must not have touched the field');
  ok('human-only: person accepted, agent refused (even as owner), denial logged, field untouched');
}

// ------------------------------------------------- 14. the door between staged and curated
// The scenarios prove what an AGENT can reach, and conformance runs everything as an agent,
// so the person's half of PRO-5 has no home there. It lives here: the same act that the
// scenario watched get refused must work for a person, and must carry the verdict's reason
// into the account as its why_them (PRO-10).
{
  execute('crm_create_campaign', { name: 'Gate14 campaign', goal: 'exercise the promotion door' }, human);
  const camp = wsp.use(WS, () => H.db().prepare("SELECT id FROM campaign WHERE name = 'Gate14 campaign'").get().id);
  const REASON = 'Third-party administrator: claims adjudication is exactly the desk-based work the brief asks for.';
  execute('pros_import_rows', {
    label: 'Gate14 pull', hash: 'sha256:gate14pull01', campaign_id: camp,
    criteria: 'Phoenix metro, 200-1000 employees, desk-based transaction work.',
    row_count: 2,
    rows: [{ company: 'Gate14 Administrators', website: 'https://gate14.example', employees: 600 },
           { company: 'Gate14 Restaurants', employees: 800 }],
  }, human);
  const rows = wsp.use(WS, () => H.db().prepare('SELECT id, company FROM pros_row ORDER BY id').all());
  const keep = rows.find(r => r.company === 'Gate14 Administrators').id;
  const drop = rows.find(r => r.company === 'Gate14 Restaurants').id;

  // PRO-7: staged rows are in no statistic. The campaign has no accounts yet.
  const before = execute('crm_pipeline', { campaign_id: camp }, human);
  assert.strictEqual(JSON.stringify(before).includes('Gate14 Administrators'), false,
    'a staged row must not appear in the pipeline');

  // An agent may judge.
  execute('pros_qualify', { verdicts: [
    { row_id: keep, verdict: 'qualified', reason: REASON, source_url: 'https://gate14.example/about' },
    { row_id: drop, verdict: 'rejected', reason: 'Restaurants: front-of-house headcount with no back office to measure.' },
  ] }, { ...human, actor_kind: 'agent', role: 'owner' });

  // PRO-5: an agent may not promote, even as owner.
  let denied = null;
  try { execute('pros_promote', { campaign_id: camp, row_ids: [{ row_id: keep }] }, { ...human, actor_kind: 'agent', role: 'owner' }); }
  catch (e) { denied = e.message; }
  assert.ok(denied && /person's act, never an agent's/.test(denied), 'an agent promoting must be refused naming whose act it is');
  const log = wsp.use(WS, () => H.db().prepare('SELECT * FROM command_log ORDER BY id DESC LIMIT 1').get());
  assert.strictEqual(log.ok, 0, 'the promotion denial must be logged');
  assert.strictEqual(wsp.use(WS, () => H.db().prepare('SELECT account_id FROM pros_row WHERE id = ?').get(keep).account_id), null,
    'the refused promotion must not have touched the row');

  // PRO-5 the other way: the same act, by a person, lands.
  const made = execute('pros_promote', { campaign_id: camp, row_ids: [{ row_id: keep }, { row_id: drop }] }, human);
  assert.strictEqual(made.promoted, 1, 'exactly the qualified row promotes');
  assert.strictEqual(made.failed, 1, 'the rejected row is refused on its own, and the batch survives it');
  const acc = wsp.use(WS, () => H.db().prepare('SELECT * FROM account WHERE name = ?').get('Gate14 Administrators'));
  assert.ok(acc, 'the promoted row became an account');
  // PRO-10: the account arrives at the curated list's own gate, carrying the verdict.
  assert.strictEqual(acc.why_them, REASON, "the account's why_them is the verdict's reason, not an invented one");
  assert.ok(acc.source_url, 'the account carries a source_url (CRM-3)');
  // PRO-6: what the row became is on the row, and it does not promote twice.
  assert.strictEqual(wsp.use(WS, () => H.db().prepare('SELECT account_id FROM pros_row WHERE id = ?').get(keep).account_id), acc.id);
  const again = execute('pros_promote', { campaign_id: camp, row_ids: [{ row_id: keep }] }, human);
  assert.strictEqual(again.promoted, 0, 'a promoted row never promotes twice');
  ok('staged rows: agent judges, only a person promotes; the verdict becomes the why_them, once');
}

// ----------------------------------------------------------- 15. the claim gate on drafts
// The scenario proves an AGENT cannot write the claim list. The other half needs a person to
// have written one, so it lives here: a phrase a person refused must stop a draft, and must
// stop an edit too — otherwise the gate is a speed bump on the create path only.
{
  execute('crm_create_campaign', { name: 'Gate15 campaign', goal: 'exercise the claim gate on outreach drafts' }, human);
  const camp = wsp.use(WS, () => H.db().prepare("SELECT id FROM campaign WHERE name = 'Gate15 campaign'").get().id);
  execute('crm_update_campaign', { campaign_id: camp, claims_refused: [
    { text: 'SOC 2', note: 'Not held, and claiming it is a compliance problem rather than a marketing one.' },
  ] }, human);
  execute('crm_add_account', { campaign_id: camp, name: 'Gate15 Co', why_them: 'exercises the gate', source_url: 'https://example.com/g15' }, human);
  const acc = wsp.use(WS, () => H.db().prepare("SELECT id FROM account WHERE name = 'Gate15 Co'").get().id);
  const c = execute('crm_add_contact', { account_id: acc, role_type: 'OPERATIONS OWNER', name: 'Sam Gate', source: 'https://example.com/g15/team' }, human);

  // An agent reads the list back before drafting; that is the whole point of it being a read.
  const camView = execute('crm_get_campaign', { campaign_id: camp }, agent);
  assert.strictEqual(camView.claims_refused[0].text, 'SOC 2', "the campaign's refused claims must come back with the campaign");

  let refused = null;
  try {
    execute('crm_draft_message', { contact_id: c.id, body: 'We are SOC 2 certified and would love to talk.',
      rationale: 'tries a claim the business has not cleared' }, { ...human, actor_kind: 'agent', role: 'owner' });
  } catch (e) { refused = e.message; }
  assert.ok(refused && refused.includes('SOC 2') && /cannot appear/.test(refused),
    'a refused claim must stop the draft, naming the phrase');

  const d = execute('crm_draft_message', { contact_id: c.id, body: 'You mentioned a claims review. Worth twenty minutes?',
    rationale: 'opens on what they said' }, { ...human, actor_kind: 'agent', role: 'owner' });
  let onEdit = null;
  try { execute('crm_update_draft', { draft_id: d.draft, body: 'Also, we are SOC 2 certified.' }, { ...human, actor_kind: 'agent', role: 'owner' }); }
  catch (e) { onEdit = e.message; }
  assert.ok(onEdit && onEdit.includes('SOC 2'), 'an edit must not smuggle in what the create path would have stopped');
  const body = wsp.use(WS, () => H.db().prepare('SELECT body FROM crm_draft WHERE id = ?').get(d.draft).body);
  assert.ok(!body.includes('SOC 2'), 'the refused edit must not have landed');

  // CRM-15: once a person says it went, the words are the record and stop being editable.
  execute('crm_draft_outcome', { draft_id: d.draft, outcome: 'sent', sent_at: '2026-09-01' }, human);
  let frozen = null;
  try { execute('crm_update_draft', { draft_id: d.draft, body: 'On reflection, thirty minutes.' }, human); }
  catch (e) { frozen = e.message; }
  assert.ok(frozen && /does not get rewritten/.test(frozen), 'a sent draft must be immutable, for a person too');
  const trail = wsp.use(WS, () => H.db().prepare('SELECT summary FROM activity WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(acc));
  assert.ok(trail.summary.includes('Worth twenty minutes?'), "the sent draft's exact words must be on the activity trail");
  const state = execute('crm_get_account', { account_id: acc }, agent);
  assert.strictEqual(state.status, 'approaching', 'a first send moves the account to approaching');
  assert.strictEqual(state.state.contacts_written_to.length, 1, 'derived state must know who has been written to');
  ok('drafts: a person sets what may be said, the gate holds on create and on edit, a sent draft is the record');
}

// ------------------------------------------------- 16. bills: a person approves, the bank pays
// The scenarios watch an agent get refused approval (P-12); the person's half lives here.
{
  const asAgent = { ...human, actor_kind: 'agent', role: 'owner' };
  execute('purch_import_statement', { name: 'g16.csv', hash: 'sha256:gate16checking', kind: 'bank', account: 'Gate16 Checking', currency: 'USD',
    period_start: '2026-09-01', period_end: '2026-09-30', opening_balance: 500000, closing_balance: 374000, row_count: 2,
    rows: [{ date: '2026-09-20', amount: -125000, description: 'ACH GATE16 SUPPLY', row_index: 1 }, { date: '2026-09-25', amount: -1000, description: 'SOMETHING ELSE', row_index: 2 }] }, human);
  const txs = wsp.use(WS, () => H.db().prepare("SELECT id, amount FROM purch_transaction WHERE description = 'ACH GATE16 SUPPLY'").get());
  const b = execute('purch_add_bill', { vendor: 'Gate16 Supply', number: 'G16-1', bill_date: '2026-09-01', due_date: '2026-09-30', amount: 125000, currency: 'USD', category: 'supplies' }, asAgent);
  let denied = null;
  try { execute('purch_approve_bill', { bill_id: b.id }, asAgent); } catch (e) { denied = e.message; }
  assert.ok(denied && /person's act/.test(denied), 'an agent must not approve paying a bill, even as owner');
  assert.strictEqual(wsp.use(WS, () => H.db().prepare('SELECT status FROM purch_bill WHERE id = ?').get(b.id).status), 'open', 'the refused approval must not land');
  execute('purch_approve_bill', { bill_id: b.id, note: 'pay it' }, human);
  let wrong = null;
  try { execute('purch_record_bill_payment', { bill_id: b.id, paid_at: '2026-09-20', transaction_id: wsp.use(WS, () => H.db().prepare("SELECT id FROM purch_transaction WHERE description = 'SOMETHING ELSE'").get().id) }, asAgent); } catch (e) { wrong = e.message; }
  assert.ok(wrong, 'a statement row that does not match the bill must be refused');
  const paid = execute('purch_record_bill_payment', { bill_id: b.id, paid_at: '2026-09-20', method: 'bank_transfer', transaction_id: txs.id }, asAgent);
  assert.strictEqual(paid.status, 'paid', 'an agent records the payment of an approved bill');
  const row = wsp.use(WS, () => H.db().prepare('SELECT status, category FROM purch_transaction WHERE id = ?').get(txs.id));
  assert.deepStrictEqual([row.status, row.category], ['purchase', 'supplies'], 'the unreviewed row that paid the bill is reviewed as the bill says');
  const b2 = execute('purch_add_bill', { vendor: 'Gate16 Supply', number: 'G16-2', bill_date: '2026-09-02', due_date: '2026-09-30', amount: 125000, currency: 'USD' }, asAgent);
  let twice = null;
  try { execute('purch_record_bill_payment', { bill_id: b2.id, paid_at: '2026-09-20', transaction_id: txs.id }, human); } catch (e) { twice = e.message; }
  assert.ok(twice && /already pays/.test(twice), 'one statement row pays one bill');
  const direct = execute('purch_record_bill_payment', { bill_id: b2.id, paid_at: '2026-09-21', method: 'card' }, human);
  assert.ok(direct.status === 'paid' && direct.approved_by === 'test', 'a person recording a payment approves it in the same act');
  ok('bills: only a person approves paying, a payment needs approval and a matching row, one row pays one bill');
}

// ------------------------------------------ 17. 3-way match: the person's approval is held to it
// The scenarios run as an agent, which is refused approval before the match is even asked; here a
// person is refused by the match itself, with its numbers, and allowed once the bill matches.
{
  const asAgent = { ...human, actor_kind: 'agent', role: 'owner' };
  execute('core_create_item', { sku: 'G17-SH', name: 'Gate17 shelving', unit_price: 18900, on_hand: 0 }, human);
  execute('core_create_item', { sku: 'G17-FRT', name: 'Gate17 freight', unit_price: 0, stocked: false }, human);
  const po = execute('p2p_create_po', { vendor: 'Gate17 Steel', lines: [{ item_id: 'G17-SH', qty: 10, unit_price: 8500 }, { item_id: 'G17-FRT', qty: 1, unit_price: 5000 }] }, asAgent);
  execute('p2p_issue_po', { po_id: po.id }, asAgent);
  const before = wsp.use(WS, () => H.db().prepare("SELECT on_hand FROM item WHERE id = 'G17-SH'").get().on_hand);
  execute('p2p_receive_goods', { po_id: po.id, lines: [{ item_id: 'G17-SH', qty: 10 }], received_at: '2026-09-10' }, asAgent);
  assert.strictEqual(wsp.use(WS, () => H.db().prepare("SELECT on_hand FROM item WHERE id = 'G17-SH'").get().on_hand), before + 10, 'a receipt raises stock through core');
  const high = execute('p2p_record_vendor_bill', { po_id: po.id, number: 'G17-1', bill_date: '2026-09-11', terms_days: 30,
    lines: [{ item_id: 'G17-SH', qty: 10, unit_price: 9000 }, { item_id: 'G17-FRT', qty: 1, unit_price: 5000 }] }, asAgent);
  let held = null;
  try { execute('purch_approve_bill', { bill_id: high.id }, human); } catch (e) { held = e.message; }
  assert.ok(held && /does not match/.test(held) && /\$90\.00/.test(held) && /\$85\.00/.test(held), 'a person approving a bill over the order is refused with the numbers');
  const tip = wsp.use(WS, () => R.nextActions('purch_bill', high.id, 'owner')).actions.find(a => a.command === 'purch_approve_bill');
  assert.ok(tip && !tip.available && tip.reason === wsp.use(WS, () => require('../src/modules/purchases/views.js').approvalHold(high.id)), 'the greyed button says the same sentence the refusal does');
  let loosen = null;
  try { execute('p2p_set_match_tolerance', { price_pct: 10, reason: 'agent tries' }, asAgent); } catch (e) { loosen = e.message; }
  assert.ok(loosen && /person's act/.test(loosen), 'an agent never loosens the match');
  execute('p2p_set_match_tolerance', { price_pct: 6, reason: 'Gate17 Steel adds a fuel surcharge; agreed by phone' }, human);
  const approved = execute('purch_approve_bill', { bill_id: high.id }, human);
  assert.strictEqual(approved.status, 'approved', 'within a tolerance a person set, the bill is approved');
  execute('p2p_set_match_tolerance', { price_pct: 0, reason: 'back to exact prices' }, human);
  const j = execute('core_journal', { from: '2026-09-10', to: '2026-09-11' }, human);
  assert.ok(j.balanced, 'the journal balances with receipts and an approved bill on an order');
  const acct = (name) => j.entries.flatMap(e => e.lines).filter(l => l.account === name).reduce((n, l) => n + (l.debit || 0) - (l.credit || 0), 0);
  assert.strictEqual(acct('Goods Received Not Invoiced'), 0, 'approving the bill clears what the receipt put into GRNI');
  assert.strictEqual(acct('Purchase Price Variance'), 5000, 'the price difference posts to its own account, never averaged into stock');
  assert.strictEqual(acct('Accounts Payable'), -90000 - 5000, 'the approved bill is owed in accounts payable');
  execute('purch_import_statement', { name: 'g17.csv', hash: 'sha256:gate17checking', kind: 'bank', account: 'Gate17 Checking', currency: 'USD',
    period_start: '2026-09-01', period_end: '2026-09-30', opening_balance: 500000, closing_balance: 405000, row_count: 1,
    rows: [{ date: '2026-09-25', amount: -95000, description: 'ACH GATE17 STEEL', row_index: 1 }] }, human);
  const tx = wsp.use(WS, () => H.db().prepare("SELECT id FROM purch_transaction WHERE description = 'ACH GATE17 STEEL'").get().id);
  execute('purch_record_bill_payment', { bill_id: high.id, paid_at: '2026-09-25', transaction_id: tx }, asAgent);
  const j2 = execute('core_journal', { from: '2026-09-25', to: '2026-09-25' }, human);
  const pay = j2.entries.find(e => e.lines.some(l => l.account === 'Gate17 Checking'));
  assert.ok(pay && pay.lines.some(l => l.account === 'Accounts Payable' && l.debit === 95000), 'the statement row that paid a bill on an order clears accounts payable, not spending again');
  ok('3-way match: a person is held to it, an agent cannot loosen it, and receipt, approval and payment post balanced');
}

// ------------------------------------------ 18. stock moves: the record adds up to the shelf
// Every gate above moved stock (fixtures, shipments, returns, receipts); if any path changed
// on_hand without a move, the sums below would not match.
{
  const off = wsp.use(WS, () => H.db().prepare(`SELECT i.id, i.on_hand, COALESCE((SELECT SUM(qty) FROM stock_move m WHERE m.item_id = i.id), 0) moved
    FROM item i WHERE i.stocked = 1`).all().filter(r => r.on_hand !== r.moved));
  assert.deepStrictEqual(off, [], 'every stocked item\'s moves must add up to its quantity on hand');
  const writers = COMMANDS.filter(c => c.module !== 'core' && /stock_move/.test(String(c.handler))).map(c => c.name);
  assert.deepStrictEqual(writers, [], 'no area writes stock moves except through core\'s stock door');
  execute('core_create_item', { sku: 'G18-W', name: 'Gate18 widget', unit_price: 8000, on_hand: 4 }, human);
  execute('inv_set_opening_cost', { item_id: 'G18-W', unit_cost: 4000, reason: 'gate 18 opening' }, human);
  execute('inv_count_stock', { item_id: 'G18-W', counted: 3, reason: 'one broken' }, human);
  const v = execute('inv_valuation', {}, human);
  assert.ok(v.items.find(i => i.item_id === 'G18-W' && i.value === 12000), 'three left at the $40 opening cost are worth $120');
  const j = execute('core_journal', {}, human);
  assert.ok(j.balanced, 'the journal balances with stock postings');
  ok('stock moves: every move goes through core and adds up to on hand; counts value at the average; the books balance');
}

// ------------------------------------------- 19. the close: frozen periods, corrections forward
// Scenarios run as an agent and cannot close; the person's close and what it freezes live here.
{
  const G = 'gate19-close'; wsp.wipe(G);
  const p19 = { workspace: G, actor: 'test', actor_kind: 'human', role: 'owner' }, a19 = { ...p19, actor_kind: 'agent' };
  H.withClock('2026-05-10', () => {
    execute('purch_import_statement', { name: 'g19.csv', hash: 'sha256:gate19april', kind: 'bank', account: 'G19 Checking', currency: 'USD',
      period_start: '2026-04-01', period_end: '2026-04-30', opening_balance: 500000, closing_balance: 470000, row_count: 2,
      rows: [{ date: '2026-04-10', amount: -20000, description: 'OFFICE DEPOT', row_index: 1 }, { date: '2026-04-20', amount: -10000, description: 'CITY POWER', row_index: 2 }] }, p19);
    let blocked = null; try { execute('gl_close_period', { through: '2026-04-30', reason: 'April' }, p19); } catch (e) { blocked = e.message; }
    assert.ok(blocked && /not reviewed/.test(blocked), 'unreviewed rows block the close (GL-7)');
    execute('purch_review_transaction', { transaction_id: 'T-0001', status: 'purchase', category: 'supplies', reason: 'paper' }, p19);
    execute('purch_review_transaction', { transaction_id: 'T-0002', status: 'purchase', category: 'utilities', reason: 'power' }, p19);
    execute('gl_record_entry', { date: '2026-04-30', memo: 'April internet accrual', reverse: true, reason: 'billed late', lines: [{ account: 'utilities', kind: 'expense', debit: 5000 }, { account: 'Accrued expenses', kind: 'liability', credit: 5000 }] }, a19);
    let agentClose = null; try { execute('gl_close_period', { through: '2026-04-30', reason: 'April' }, a19); } catch (e) { agentClose = e.message; }
    assert.ok(agentClose && /person's act/.test(agentClose), 'an agent never closes the books (GL-2)');
    const before = execute('bridge_financials', { from: '2026-04-01', to: '2026-04-30' }, p19);
    const cl = execute('gl_close_period', { through: '2026-04-30', reason: 'April close' }, p19);
    assert.ok(cl.hash && cl.entry_count > 0, 'a close keeps the period with its totals and hash');
    execute('purch_review_transaction', { transaction_id: 'T-0002', status: 'purchase', category: 'rent', reason: 'that was the landlord, not power' }, p19);
    const after = execute('bridge_financials', { from: '2026-04-01', to: '2026-04-30' }, p19);
    assert.deepStrictEqual(after.profit_and_loss, before.profit_and_loss, 'a closed period stays as it was kept (GL-3)');
    const ch = execute('gl_changes', {}, p19);
    assert.ok(ch.lines.some(l => l.date === '2026-05-01' && l.account === 'rent' && l.debit === 10000) && ch.lines.some(l => l.account === 'utilities' && l.credit === 10000), 'the late change lands on the first open day, per account (GL-4)');
    const j = execute('core_journal', {}, p19);
    assert.ok(j.balanced && j.entries.some(e => e.date === '2026-05-01' && /^Reversal of JE-0001/.test(e.memo)), 'the accrual reverses on the 1st of the next month (GL-6), and the books balance');
    let closedEntry = null; try { execute('gl_record_entry', { date: '2026-04-15', memo: 'late', reason: 'x', lines: [{ account: 'a', kind: 'expense', debit: 1 }, { account: 'b', kind: 'liability', credit: 1 }] }, p19); } catch (e) { closedEntry = e.message; }
    assert.ok(closedEntry && /closed through/.test(closedEntry), 'a closed period takes no entries (GL-5)');
    execute('gl_reopen_period', { reason: 'found a mistake' }, p19);
    assert.strictEqual(execute('gl_changes', {}, p19).count, 0, 'reopened, the period moves with the record again and no correction is needed');
  });
  ok('the close: a person closes, the period stops moving, a later change lands as a correction, accruals reverse, the latest close reopens');
}

// ------------------------------------- 20. bank reconciliation: matched once, signed by a person
// Scenarios run as an agent and cannot sign off; the person's sign-off and changed-since live here.
{
  const G = 'gate20-bankrec'; wsp.wipe(G);
  const p20 = { workspace: G, actor: 'test', actor_kind: 'human', role: 'owner' }, a20 = { ...p20, actor_kind: 'agent' };
  H.withClock('2026-05-10', () => {
    execute('core_create_customer', { name: 'Acme Corp', terms: 'net30', credit_limit: 1000000 }, p20);
    execute('o2c_record_payment', { customer_id: 'C-0001', amount: 100000, method: 'ach', reference: 'ACME-1', received_at: '2026-04-08' }, p20);
    execute('o2c_record_payment', { customer_id: 'C-0001', amount: 50000, method: 'check', reference: 'CHK-77', received_at: '2026-04-28' }, p20);
    execute('purch_import_statement', { name: 'g20.csv', hash: 'sha256:gate20april', kind: 'bank', account: 'G20 Checking', currency: 'USD',
      period_start: '2026-04-01', period_end: '2026-04-30', opening_balance: 500000, closing_balance: 598500, row_count: 2,
      rows: [{ date: '2026-04-09', amount: 100000, description: 'DEPOSIT ACME CORP ACH', row_index: 1 }, { date: '2026-04-30', amount: -1500, description: 'SERVICE CHARGE', row_index: 2 }] }, p20);
    const r0 = execute('rec_reconciliation', { account: 'G20 Checking' }, a20);
    assert.ok(!r0.ready && r0.not_in_books.count === 2, 'unreviewed rows are on the statement and not in the books, and block a sign-off');
    const c = execute('rec_candidates', {}, a20);
    const fit = c.rows.find(r => r.transaction_id === 'T-0001').candidates[0];
    assert.ok(fit && fit.items[0].key === 'o2c:payment:P-0001' && /Acme/.test(fit.why), 'the deposit is suggested as the payment, by amount, date and name (REC-7)');
    let off = null; try { execute('rec_match', { transaction_id: 'T-0001', items: [{ item: 'o2c:payment:P-0002' }], reason: 'x' }, a20); } catch (e) { off = e.message; }
    assert.ok(off && /add up to \$500\.00/.test(off), 'a match that does not add up is refused, naming the gap (REC-1)');
    execute('rec_match', { transaction_id: 'T-0001', items: [{ item: 'o2c:payment:P-0001' }], reason: 'the Acme ACH is their payment ACME-1' }, a20);
    execute('purch_review_transaction', { transaction_id: 'T-0002', status: 'fee', reason: 'monthly service charge' }, a20);
    let again = null; try { execute('purch_review_transaction', { transaction_id: 'T-0001', status: 'income', category: 'sales', reason: 'x' }, a20); } catch (e) { again = e.message; }
    assert.ok(again && /matched to/.test(again), 'a matched row cannot be reviewed again (REC-3)');
    const r = execute('rec_reconciliation', { account: 'G20 Checking' }, a20);
    assert.ok(r.ready && r.difference === 0 && r.in_transit.total === 50000 && r.books === 648500, 'the check not on the statement yet is in transit and the rest ties to the cent (REC-2)');
    assert.strictEqual(r.printed, r.books - r.in_transit.total + r.not_in_books.total + r.timing.total, 'statement = books - in transit + not in books + timing');
    const fin = execute('bridge_financials', { from: '2026-04-01', to: '2026-04-30' }, p20);
    assert.ok(fin.ties.every(t => t.ties), 'the account ties in the financials once the reconciliation explains it');
    let agentOff = null; try { execute('rec_sign_off', { account: 'G20 Checking', through: '2026-04-30', reason: 'April' }, a20); } catch (e) { agentOff = e.message; }
    assert.ok(agentOff && /person's act/.test(agentOff), 'an agent never signs off (REC-5)');
    const so = execute('rec_sign_off', { account: 'G20 Checking', through: '2026-04-30', reason: 'April statement, checked' }, p20);
    assert.ok(so.hash && execute('rec_signoffs', {}, p20).items[0].changed_since === false, 'the sign-off keeps the reconciliation as it stood');
    execute('rec_unmatch', { match_id: 'BM-0001', reason: 'wrong customer after all' }, a20);
    assert.ok(execute('rec_signoffs', {}, p20).items[0].changed_since, 'a later change shows as changed since (REC-6)');
    assert.strictEqual(execute('purch_get_transaction', { transaction_id: 'T-0001' }, p20).status, 'unreviewed', 'unmatched, the row is back to how it was reviewed');
  });
  ok('bank reconciliation: a deposit is matched to its payment once, a check in transit is named, the account ties, a person signs off, a later change shows');
}

// ----------------------------------------- 21. sales tax: a return, a person's filing, a payment
// Scenarios run as an agent and cannot record a filing; the person's half and the o2c credits live here.
{
  const G = 'gate21-salestax'; wsp.wipe(G);
  const p21 = { workspace: G, actor: 'test', actor_kind: 'human', role: 'owner' }, a21 = { ...p21, actor_kind: 'agent' };
  H.withClock('2026-05-04', () => {
    execute('core_create_item', { sku: 'G21-SH', name: 'Shelf', unit_price: 10000, on_hand: 50, tax_rate_bp: 875 }, p21);
    execute('core_create_item', { sku: 'G21-IN', name: 'Install', unit_price: 20000, stocked: false }, p21);
    execute('core_create_customer', { name: 'Gate Corp', terms: 'net30', credit_limit: 5000000, address: '1 Gate St' }, p21);
    execute('o2c_create_order', { customer_id: 'C-0001', lines: [{ item_id: 'G21-SH', qty: 10 }, { item_id: 'G21-IN', qty: 1 }] }, p21);
    execute('o2c_confirm_order', { order_id: 'SO-0001' }, p21);
    execute('o2c_ship_order', { order_id: 'SO-0001', lines: [{ order_line_id: 1, qty: 10 }, { order_line_id: 2, qty: 1 }] }, p21);
    execute('o2c_invoice_shipped', { order_id: 'SO-0001' }, p21);
  });
  H.withClock('2026-05-20', () => execute('o2c_record_return', { order_id: 'SO-0001', reason: 'two shelves bent', lines: [{ order_line_id: 1, qty: 2, restock: false }] }, p21));
  H.withClock('2026-06-10', () => {
    const r = execute('tax_return', { period: '2026-05' }, a21);
    assert.ok(r.taxable === 100000 && r.nontaxable === 20000 && r.tax_collected === 8750 && r.credits_tax === 1750 && r.due === 7000, 'May: 8.75% on the shelves, the return gives back its own tax, installation untaxed (TAX-2)');
    const cn = execute('o2c_get_order', { order_id: 'SO-0001' }, p21);
    assert.ok(cn, 'order readable');
    const j = execute('core_journal', { to: '2026-05-31' }, p21);
    const stp = j.entries.flatMap(e => e.lines).filter(l => l.account === 'Sales Tax Payable').reduce((n, l) => n + (l.credit || 0) - (l.debit || 0), 0);
    assert.strictEqual(stp, 7000, 'the credit note takes its tax off Sales Tax Payable, not off sales');
    let agent = null; try { execute('tax_record_filing', { period: '2026-05', filed_amount: 7000, filed_on: '2026-06-08', reason: 'May' }, a21); } catch (e) { agent = e.message; }
    assert.ok(agent && /person's act/.test(agent), 'an agent never records a filing (TAX-3)');
    let off = null; try { execute('tax_record_filing', { period: '2026-05', filed_amount: 6900, filed_on: '2026-06-08', reason: 'May' }, p21); } catch (e) { off = e.message; }
    assert.ok(off && /Say why they differ/.test(off), 'a filed amount that differs needs a reason (TAX-5)');
    let early = null; try { execute('tax_record_filing', { period: '2026-06', filed_amount: 0, filed_on: '2026-06-08', reason: 'June' }, p21); } catch (e) { early = e.message; }
    assert.ok(early && /not ended yet/.test(early), 'a period not yet over cannot be filed (TAX-5)');
    const fl = execute('tax_record_filing', { period: '2026-05', filed_amount: 7000, filed_on: '2026-06-08', agency: 'CDTFA', reference: 'CONF-1', reason: 'May return, filed online' }, p21);
    assert.ok(fl.id === 'TF-0001' && fl.hash, 'the filing keeps the return as it stood');
    let over = null; try { execute('tax_record_payment', { filing_id: 'TF-0001', amount: 7001, paid_on: '2026-06-09' }, a21); } catch (e) { over = e.message; }
    assert.ok(over && /more than that/.test(over), 'a payment never exceeds what is owed (TAX-6)');
    execute('tax_record_payment', { filing_id: 'TF-0001', amount: 7000, paid_on: '2026-06-09', method: 'ach', reference: 'PAY-1' }, a21);
    const li = execute('tax_liability', {}, p21);
    assert.ok(li.owed === 0 && li.books === 0 && li.ties, 'paid, nothing is owed and the books agree (TAX-7)');
    const rec = MODULES.find(m => m.name === 'bankrec');
    assert.ok(wsp.use(G, () => rec.api.views.cashItems()).some(c => c.key === 'salestax:payment:TP-0001' && c.amount === -7000), 'the payment waits in the bank reconciliation like any recorded payment (TAX-6)');
  });
  // A goodwill credit on a mixed invoice gives back the invoice's own share of tax: 10,875 x 8,750 / 128,750 = 739.
  H.withClock('2026-05-25', () => execute('o2c_create_credit_note', { customer_id: 'C-0001', amount: 10875, kind: 'goodwill', invoice_id: 'INV-0001', reason: 'late goodwill for the delay' }, p21));
  H.withClock('2026-07-05', () => {
    const f = execute('tax_filings', {}, p21).items[0];
    assert.ok(f.changed_since && f.change === -739, 'a late change to a filed month shows as changed since, with its amount (TAX-4)');
    const jr = execute('tax_return', { period: '2026-06' }, p21);
    assert.ok(jr.prior_changes.length === 1 && jr.prior_changes_total === -739, 'and the next return names it');
  });
  ok('sales tax: a return gives credits their tax back, a person records the filing, a payment clears it and waits in the bank, a late change is named');
}

// ----------------------------------------- 22. transfers: one move between two accounts, once
{
  const G = 'gate22-transfers'; wsp.wipe(G);
  const p22 = { workspace: G, actor: 'test', actor_kind: 'human', role: 'owner' }, a22 = { ...p22, actor_kind: 'agent' };
  H.withClock('2026-12-10', () => {
    const imp = (name, account, kind, o, c, rows, hash) => execute('purch_import_statement', { name, hash, kind, account, currency: 'USD', period_start: '2026-11-01', period_end: '2026-11-30', opening_balance: o, closing_balance: c,
      rows: rows.map(([date, amount, description], i) => ({ date, amount, description, row_index: i + 1 })) }, a22);
    imp('chk.csv', 'G22 Checking', 'bank', 500000, 430000, [['2026-11-03', -20000, 'GROCER'], ['2026-11-20', -50000, 'ONLINE PMT TO VISA']], 'sha256:g22chk');
    imp('visa.csv', 'G22 Visa', 'card', -80000, -40000, [['2026-11-10', -10000, 'CAFE'], ['2026-11-22', 50000, 'PAYMENT THANK YOU']], 'sha256:g22visa');
    execute('purch_review_transaction', { transaction_id: 'T-0001', status: 'purchase', category: 'groceries', reason: 'food' }, a22);
    execute('purch_review_transaction', { transaction_id: 'T-0003', status: 'purchase', category: 'meals', reason: 'coffee' }, a22);
    const c = execute('purch_transfers', {}, a22);
    assert.ok(c.suggestions === 1 && c.suggested[0].out.id === 'T-0002' && c.suggested[0].in.id === 'T-0004', 'the two sides are suggested as one move (P-17)');
    execute('purch_pair_transfer', { out_transaction_id: 'T-0002', in_transaction_id: 'T-0004', reason: 'the Visa payment from checking' }, a22);
    const j = execute('core_journal', {}, p22);
    const tr = j.entries.filter(e => /Transfer TR-0001/.test(e.memo));
    assert.ok(tr.length === 1 && tr[0].lines.some(l => l.account === 'G22 Visa' && l.debit === 50000) && tr[0].lines.some(l => l.account === 'G22 Checking' && l.credit === 50000), 'the move posts once, from checking into the card (P-16)');
    assert.ok(!j.entries.some(e => /PAYMENT THANK YOU/.test(e.memo)), 'the card side posts nothing of its own');
    const fin = execute('bridge_financials', { from: '2026-11-01', to: '2026-11-30' }, p22);
    assert.ok(fin.ties.length === 2 && fin.ties.every(t => t.ties), 'both accounts tie to their statements');
    assert.ok(!fin.profit_and_loss.income.length && fin.profit_and_loss.expenses.reduce((n, x) => n + x.amount, 0) === 30000, 'the transfer is neither income nor spending');
    const rec = execute('rec_reconciliation', { account: 'G22 Checking' }, p22);
    assert.ok(rec.ready && rec.difference === 0, 'checking reconciles with the paired row counted');
    execute('purch_unpair_transfer', { transfer_id: 'TR-0001', reason: 'test' }, a22);
    assert.ok(['T-0002', 'T-0004'].every(id => execute('purch_get_transaction', { transaction_id: id }, p22).status === 'unreviewed'), 'unpaired, both rows are back as they were');
  });
  ok('transfers: a move between two of your accounts posts once, both accounts tie and reconcile, unpairing puts both rows back');
}

// ------------------------------------------- 23. cards: refunds, interest, the minimum payment
{
  const G = 'gate23-cards'; wsp.wipe(G);
  const p23 = { workspace: G, actor: 'test', actor_kind: 'human', role: 'owner' }, a23 = { ...p23, actor_kind: 'agent' };
  H.withClock('2026-12-10', () => {
    const imp = (name, account, kind, o, c, rows, hash, ps, pe, extra = {}) => execute('purch_import_statement', { name, hash, kind, account, currency: 'USD', period_start: ps, period_end: pe, opening_balance: o, closing_balance: c,
      rows: rows.map(([date, amount, description], i) => ({ date, amount, description, row_index: i + 1 })), ...extra }, a23);
    imp('visa-oct.csv', 'G23 Visa', 'card', 0, -14000, [['2026-10-02', -12000, 'CRATE AND BARREL'], ['2026-10-09', 4000, 'CRATE AND BARREL CREDIT'], ['2026-10-20', -6000, 'CAFE']], 'sha256:g23visaoct', '2026-10-01', '2026-10-31',
      { minimum_due: 2500, payment_due_date: '2026-11-25', credit_limit: 300000, apr_bp: 2499 });
    imp('chk-nov.csv', 'G23 Checking', 'bank', 100000, 97500, [['2026-11-20', -2500, 'ONLINE PMT TO VISA']], 'sha256:g23chknov', '2026-11-01', '2026-11-30');
    imp('visa-nov.csv', 'G23 Visa', 'card', -14000, -13340, [['2026-11-21', 2500, 'PAYMENT THANK YOU'], ['2026-11-30', -1840, 'INTEREST CHARGE ON PURCHASES']], 'sha256:g23visanov', '2026-11-01', '2026-11-30');
    execute('purch_review_transaction', { transaction_id: 'T-0001', status: 'purchase', category: 'furniture', reason: 'chairs' }, a23);
    execute('purch_review_transaction', { transaction_id: 'T-0003', status: 'purchase', category: 'meals', reason: 'coffee' }, a23);
    execute('purch_review_transaction', { transaction_id: 'T-0006', status: 'fee', category: 'interest', reason: 'interest on the balance carried' }, a23);
    execute('purch_link_refund', { refund_transaction_id: 'T-0002', purchase_transaction_id: 'T-0001', reason: 'returned a chair' }, a23);
    execute('purch_pair_transfer', { out_transaction_id: 'T-0004', in_transaction_id: 'T-0005', reason: 'the card payment' }, a23);
    const sp = execute('purch_purchases', {}, p23);
    assert.strictEqual(sp.by_category.find(c => c.category === 'furniture').amount, 8000, 'the refund takes back spending in the purchase\'s category (P-21)');
    const fin = execute('bridge_financials', { from: '2026-10-01', to: '2026-11-30' }, p23);
    assert.ok(!fin.profit_and_loss.income.length, 'a refund is not income (P-21)');
    assert.ok(fin.profit_and_loss.expenses.some(x => x.account === 'furniture' && x.amount === 8000) && fin.profit_and_loss.expenses.some(x => x.account === 'interest' && x.amount === 1840), 'interest posts as interest; furniture net of the refund');
    assert.ok(fin.balanced && fin.ties.every(t => t.ties), 'the books balance and every account ties');
    const due = execute('purch_card_dues', { as_of: '2026-11-29' }, p23).items[0];
    assert.ok(due.paid === 2500 && /minimum paid, the rest carries interest/.test(due.state), 'paying only the minimum says so (P-20)');
    const costs = execute('purch_card_costs', { year: '2026' }, p23).items[0];
    assert.ok(costs.interest === 1840 && costs.fees === 0, 'the year\'s interest from the fee row (P-22)');
  });
  ok('cards: a refund takes back spending in its category, interest posts as interest, a minimum-only payment is named');
}

// --------------------------------------------- 24. loans: one payment, split, in the books once
{
  const G = 'gate24-loans'; wsp.wipe(G);
  const p24 = { workspace: G, actor: 'test', actor_kind: 'human', role: 'owner' }, a24 = { ...p24, actor_kind: 'agent' };
  H.withClock('2026-12-10', () => {
    execute('loan_add', { name: 'G24 mortgage ending 7731', kind: 'mortgage', lender: 'Chase Home Lending', currency: 'USD', balance: 30000000, balance_date: '2026-10-15', rate_bp: 650, payment: 205000, escrow: 45000, due_day: 1, source: 'lender statement, October 2026' }, a24);
    execute('purch_import_statement', { name: 'chk.csv', hash: 'sha256:g24chk', kind: 'bank', account: 'G24 Checking', currency: 'USD', period_start: '2026-11-01', period_end: '2026-11-30', opening_balance: 1000000, closing_balance: 750000,
      rows: [{ date: '2026-11-01', amount: -250000, description: 'CHASE MTG PMT 7731', row_index: 1 }] }, a24);
    const lk = execute('loan_link_payment', { loan_id: 'LN-0001', transaction_id: 'T-0001', reason: 'the November payment' }, a24);
    assert.ok(lk.principal === 42500 && lk.interest === 162500 && lk.escrow === 45000, 'split by the schedule: a month\'s interest on what was owed, the escrow, the rest to principal (L-4)');
    let again = null; try { execute('purch_review_transaction', { transaction_id: 'T-0001', status: 'purchase', category: 'housing', reason: 'x' }, a24); } catch (e) { again = e.message; }
    assert.ok(again && /loan payment LP-0001/.test(again), 'a linked row cannot be reviewed again (L-3)');
    const j = execute('core_journal', {}, p24);
    const pay = j.entries.filter(e => /Loan payment LP-0001/.test(e.memo));
    assert.ok(pay.length === 1 && !j.entries.some(e => /CHASE MTG PMT/.test(e.memo)), 'the row posts once, through the loan (L-3)');
    const L = (acct) => pay[0].lines.find(l => l.account === acct) || {};
    assert.ok(L('G24 mortgage ending 7731').debit === 42500 && L('mortgage interest').debit === 162500 && L('escrow').debit === 45000 && L('G24 Checking').credit === 250000, 'principal off the loan, interest and escrow as spending, paid from checking');
    const fin = execute('bridge_financials', { from: '2026-10-01', to: '2026-11-30' }, p24);
    assert.ok(fin.balanced && fin.ties.every(t => t.ties), 'the books balance and checking ties');
    assert.ok(fin.balance_sheet.liabilities.some(x => x.account === 'G24 mortgage ending 7731' && x.amount === 29957500), 'what is owed sits as a liability, less the principal paid');
    assert.ok(execute('rec_reconciliation', { account: 'G24 Checking' }, p24).ready, 'checking reconciles with the linked row counted');
    const nw = execute('purch_net_worth', { as_of: '2026-12-01' }, p24);
    assert.ok(nw.owed_total === 29957500, 'net worth counts what the loan still owes');
    execute('purch_record_value', { account_id: H.withClock('2026-12-10', () => wsp.use(G, () => H.db().prepare("SELECT account_id FROM loan_loan WHERE id = 'LN-0001'").get().account_id)), as_of: '2026-11-15', amount: 29957400, according_to: 'November lender statement' }, p24);
    const tie = execute('loan_get', { loan_id: 'LN-0001' }, p24).lender_tie;
    assert.ok(tie && !tie.ties && tie.difference === -100, 'the lender\'s figure, a dollar apart, is named, never absorbed (L-5)');
  });
  ok('loans: a payment posts once, split; the books balance, checking ties and reconciles, net worth counts what is owed, the lender\'s figure is checked');
}

// ------------------------------------------------- 25. autopay: a person's standing approval
{
  const G = 'gate25-autopay'; wsp.wipe(G);
  const p25 = { workspace: G, actor: 'test', actor_kind: 'human', role: 'owner' }, a25 = { ...p25, actor_kind: 'agent' };
  H.withClock('2026-12-10', () => {
    execute('purch_add_account', { name: 'G25 Checking', kind: 'checking', currency: 'USD' }, p25);
    execute('purch_declare_bill_series', { vendor: 'Comcast', cadence: 'monthly', category: 'internet' }, a25);
    execute('purch_set_autopay', { series_id: 'BS-0001', account_id: 'ACC-0001', reason: 'Comcast takes it from checking each month' }, p25);
    const b = execute('purch_add_bill', { vendor: 'Comcast', number: 'C-12', bill_date: '2026-11-25', due_date: '2026-12-08', amount: 8999, currency: 'USD', category: 'internet' }, a25);
    assert.ok(b.status === 'approved' && /Autopay from G25 Checking .*set by test/.test(b.approval_note || ''), 'a bill under autopay is approved by the person\'s standing decision, and says whose (P-24)');
    execute('purch_set_autopay', { series_id: 'BS-0001', off: true, reason: 'switching to paying by hand' }, p25);
    const b2 = execute('purch_add_bill', { vendor: 'Comcast', number: 'C-13', bill_date: '2026-12-01', due_date: '2026-12-15', amount: 8999, currency: 'USD', category: 'internet' }, a25);
    assert.strictEqual(b2.status, 'open', 'autopay stopped, the next bill waits for approval');
  });
  ok('autopay: a person\'s standing approval approves a vendor\'s bills and says so; stopped, bills wait again');
}

console.log(`\n${n} contract checks passed across ${MODULES.length} modules, ${COMMANDS.length} commands.`);
