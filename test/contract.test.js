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
// source as text. Every inline script in every page must compile.
{
  const vm = require('vm');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'ui')).filter(n => n.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'ui', f), 'utf8');
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    blocks.forEach((src, i) => { try { new vm.Script(src, { filename: `${f}#${i}` }); } catch (e) { assert.fail(`${f}: inline script ${i} does not parse — ${e.message}`); } });
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

console.log(`\n${n} contract checks passed across ${MODULES.length} modules, ${COMMANDS.length} commands.`);
