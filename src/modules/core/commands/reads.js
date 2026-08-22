'use strict';
const R = require('../../../registry.js');
const { defineCommand, f, MODULES, COMMANDS, nextActions } = R;
const H = require('../../../db.js');
const wsp = require('../../../workspace.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Read', ...def });

read({
  name: 'core_schema',
  title: 'Schema', summary: 'The shape of the system: modules, entities, lifecycles, the encoded rules, and every command.',
  doctrine: 'Call this first in a new session. It is cheaper than guessing and it is generated from the same registry the tools come from, so it cannot go stale.',
  args: {},
  handler: (a, ctx) => ({
    money: 'All amounts are integer cents. 1250 means $12.50. Never send a float.',
    workspace: wsp.currentName(),
    mounted: ctx.modules || MODULES.map(m => m.name),
    modules: MODULES.filter(m => !ctx.modules || ctx.modules.includes(m.name)).map(m => ({ name: m.name, prefix: m.prefix, tables: m.tables, doctrine: m.doctrine.trim(),
      ids: m.ids || {}, lifecycles: m.lifecycles || {}, rules: m.rules || [],
      commands: m.commands.map(n => { const c = R.byName[n]; return { name: c.name, intent: c.intent, subject: c.subject, summary: c.summary }; }) })),
  }),
});

read({
  name: 'core_next_actions',
  title: 'What can I do now', subject: 'order',
  summary: 'The commands available on an entity right now, and for the rest, the business reason they are not.',
  doctrine: 'This is the same evaluation that decides which buttons are live in the UI. Prefer it over guessing at a state machine, and quote the reason back verbatim when something is blocked — it is written to be shown to a person.',
  args: {
    subject_type: { ...f.text('Which kind of entity — see core_schema for the subject types.'), required: true },
    id:           { ...f.text('Its id.'), required: true },
  },
  handler: (a) => nextActions(a.subject_type, a.id),
});

read({ name: 'core_audit', title: 'Audit trail', summary: 'What happened, who did it, and whether it was a person or an agent. Includes refused commands.',
  doctrine: 'Both surfaces write here. actor_kind "agent" means a model called the tool; "human" means somebody clicked. Refusals are kept — a blocked agent action is exactly what you want to be able to review.',
  args: { subject_id: f.text('Narrow to one entity, e.g. SO-0003.'), limit: f.int('How many rows. Default 50.') },
  handler: (a) => H.auditTrail(a.limit || 50, a.subject_id || null) });

read({ name: 'core_search', title: 'Search', summary: 'Find entities by id, name or reference, across every module.',
  doctrine: 'Each module contributes its own results; what you can find here tracks what is mounted.',
  args: { q: { ...f.text('Free text.'), required: true } },
  handler: (a) => {
    const like = `%${a.q}%`;
    const out = {
      customers: H.db().prepare('SELECT id,name,terms FROM customer WHERE id LIKE ? OR name LIKE ? LIMIT 10').all(like, like),
      items:     H.db().prepare('SELECT id,name,unit_price,on_hand FROM item WHERE id LIKE ? OR name LIKE ? LIMIT 10').all(like, like),
    };
    for (const m of MODULES) if (m.search) Object.assign(out, m.search(like));
    return out;
  } });

read({
  name: 'core_spec_status',
  title: 'Spec status', summary: 'Implementation status against the area spec: acts, scenarios with evidence, invariants with what exercises them.',
  doctrine: `The answer to "how far along is the spec, and how do you know". Derived, never
asserted: acts come from the implements map, evidence from the last conformance run. Use it to
teach — each scenario's steps show the act, the doctrine, the arguments, and what came back,
refusals included; refusals are half the curriculum.`,
  args: { area: f.text('Spec area. Defaults to o2c.') },
  handler: (a) => {
    const C = require('../../../conformance.js');
    const area = a.area || 'o2c';
    const report = C.lastReport(area);
    if (!report) return { area, note: 'no conformance run recorded yet — run the contract test or core_replay_scenario' };
    return report;
  },
});

// ---------------------------------------------------------------- membership
// Sharing a sandbox = minting a member: a named capability token with a role. The token is
// the key — demo-grade identity over the durable permission model.
const members = require('../../../members.js');

defineCommand({
  name: 'core_invite',
  title: 'Invite member', group: 'Workspace', subject: 'workspace', scope: 'collection',
  permission: 'workspace.admin',
  summary: 'Mint a member token for this workspace: a name, a role, and the links that carry them.',
  doctrine: `The link is the key: whoever opens it works here under that name and role, and every
act they (or their agent) take is attributed to that name. Roles: owner (everything), controller
(everything but workspace admin), clerk (day-to-day, no credit authority), viewer (read only).
Denials are one-sentence refusals, logged — attempted overreach is reviewable, like everything else.`,
  effects: ['member token minted'],
  args: {
    name: { ...f.text('Who this is for — becomes the actor on every act they take.'), required: true },
    role: { ...f.pick(members.ROLES.filter(r => r !== 'owner'), 'What they may do here.'), required: true },
  },
  handler(a) {
    const ws = wsp.currentName();
    const m = members.mint(ws, a.name, a.role);
    return { name: m.name, role: m.role, token: m.token,
      join_path: `/app?join=${m.token}`, mcp_path: `/mcp/${m.token}`,
      note: 'The link is the key. Share it with exactly one person.' };
  },
});

read({ name: 'core_members', title: 'Members', summary: 'Who holds a key to this workspace, with role and status. Tokens are shown as hints only.',
  args: {}, handler: () => ({ workspace: wsp.currentName(), members: members.list(wsp.currentName()) }) });

defineCommand({
  name: 'core_revoke_member',
  title: 'Revoke member', group: 'Workspace', subject: 'workspace', scope: 'collection',
  permission: 'workspace.admin',
  summary: 'Revoke a member\'s token. Their link stops working immediately.',
  doctrine: 'Revocation is a logged act like any other; the member\'s past entries in the trail keep their name. Nothing is deleted.',
  effects: ['member token revoked'],
  args: { name: { ...f.text('The member to revoke.'), required: true } },
  handler(a) {
    const n = members.revoke(wsp.currentName(), a.name);
    if (!n) throw new (require('../../../registry.js').Rejected)(`No active member named ${a.name} here.`);
    return { revoked: a.name };
  },
});

// Workspace plumbing — never mounted in production.
if (process.env.OTC_ENV !== 'production') {
  read({ name: 'core_workspaces', title: 'Workspaces', summary: 'List the workspaces on this deployment and which one this session is in.',
    doctrine: 'On a hosted demo this answers with your sandbox only: a sandbox name is the key to that sandbox, so other visitors\' names are never listed.',
    args: {}, handler: () => process.env.OTC_DEMO === '1'
      ? ({ current: wsp.currentName(), workspaces: [wsp.currentName()] })
      : ({ current: wsp.currentName(), workspaces: wsp.list() }) });

  defineCommand({
    name: 'core_replay_scenario',
  permission: 'read',
    title: 'Replay scenario', group: 'Workspace', subject: 'workspace', scope: 'collection',
    summary: 'Replay one spec scenario live in its scratch workspace and return the step-by-step evidence.',
    doctrine: `A replay is not a simulation: the scenario runs through the real registry — same
guards, same audit trail — in a throwaway workspace, and the response walks every step: act,
command, arguments, expectation, and what actually came back. Show it to someone learning the
area; the refusal steps teach more than the happy path. Refreshes the persisted evidence.`,
    effects: ['scratch workspace wiped and scenario replayed', 'conformance evidence refreshed'],
    args: {
      file: { ...f.text('Scenario file name, e.g. 02_credit_gate.json. See core_spec_status for the list.'), required: true },
      area: f.text('Spec area. Defaults to o2c.'),
    },
    handler(a, ctx) {
      const C = require('../../../conformance.js');
      const area = a.area || 'o2c';
      const result = C.runScenario(area, a.file, { actor: ctx.actor });
      C.runArea(area, { actor: ctx.actor });
      return result;
    },
  });

  defineCommand({
    name: 'core_reset_workspace',
  permission: 'workspace.admin',
    title: 'Reset workspace', group: 'Workspace', subject: 'workspace', scope: 'collection',
    summary: 'Wipe THIS workspace and optionally reseed it from a named fixture.',
    doctrine: `Destroys every row in the current workspace — yours, nobody else's. Available only
outside production. Fixtures are command scripts (fixtures/<name>.json), so a reseeded workspace
has a real audit trail: every seed row shows as a logged command by actor "fixture".`,
    effects: ['all rows in this workspace deleted', 'fixture commands replayed if given'],
    args: { fixture: f.text('Fixture name under fixtures/, e.g. "acme". Omit to reset to empty.') },
    handler(a) {
      const ws = wsp.currentName();
      wsp.wipe(ws);
      let replayed = 0;
      if (a.fixture) replayed = require('../../../fixtures.js').load(a.fixture, ws);
      return { workspace: ws, reset: true, fixture: a.fixture || null, commands_replayed: replayed };
    },
  });
}
