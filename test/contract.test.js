'use strict';
/**
 * The contributor contract, as assertions. Every module — present and future — is held to:
 *
 *   1. parity        the MCP tool and the UI form derive from one declaration and cannot drift
 *   2. namespace     command names carry their module's prefix; collisions are impossible
 *   3. doctrine      every write command teaches; empty doctrine does not ship
 *   4. guards        every instance write declares its guards (or says `guardless` out loud)
 *   5. ownership     no module writes another module's tables — it uses the owner's api
 *   6. budget        at most 25 tools per module; past that, ask which commands are the same act
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
  assert.ok(m.commands.length <= 25,
    `${m.name}: ${m.commands.length} commands — past 25, ask which of these are really the same business act`);
}
ok(`budget: ${MODULES.map(m => `${m.name}=${m.commands.length}`).join(', ')} — all within the 25-tool cap`);

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

console.log(`\n${n} contract checks passed across ${MODULES.length} modules, ${COMMANDS.length} commands.`);
