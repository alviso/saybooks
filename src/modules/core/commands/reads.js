'use strict';
const R = require('../../../registry.js');
const { defineCommand, f, MODULES, COMMANDS, nextActions } = R;
const H = require('../../../db.js');
const wsp = require('../../../workspace.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Read', ...def });

read({
  name: 'core_schema',
  title: 'Schema', summary: 'The shape of the system: modules, entities, lifecycles, the encoded rules, and every command.',
  doctrine: `Call this first in a new session. It is cheaper than guessing, and it is generated from the
same registry the tools come from — so the SERVER cannot serve a stale one. Your client can: connector
tool lists are cached by the app when the connector is added. If a command listed here is missing from
your tools, or a tool has fewer arguments than this schema says, remove and re-add the connector and
start a new chat. This schema is the truth; the tool list is a cache of it.`,
  args: {},
  handler: (a, ctx) => ({
    you_are: (() => {
      const ws2 = wsp.currentName();
      let idn = null;
      try { idn = require('../../../users.js').spaceIdentity(ws2); } catch { /* no users store locally */ }
      return idn
        ? `You are ${ctx.actor} (${ctx.actor_kind}) in the space "${idn.space}" (workspace ${ws2}), owned by ${idn.owner}. Every write through this connection lands in this book and no other.`
        : `You are ${ctx.actor} (${ctx.actor_kind}) in workspace "${ws2}".`;
    })(),
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
      customers: H.db().prepare('SELECT id,name,terms FROM customer WHERE id LIKE ? OR name LIKE ? OR email LIKE ? LIMIT 10').all(like, like, like),
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
  summary: 'Share this workspace: by email (they sign in with Google) or as a member token (a link that is the key).',
  doctrine: `The link is the key: whoever opens it works here under that name and role, and every
act they (or their agent) take is attributed to that name. Roles: owner (everything), controller
(everything but workspace admin), clerk (day-to-day, no credit authority), viewer (read only).
Denials are one-sentence refusals, logged — attempted overreach is reviewable, like everything else.`,
  effects: ['member token minted'],
  args: {
    name: { ...f.text('Who this is for — becomes the actor on every act they take. For an email invite, the email works as the name.'), required: true },
    role: { ...f.pick(members.ROLES.filter(r => r !== 'owner'), 'What they may do here.'), required: true },
    email: f.text('Invite by email instead of minting a link: they sign in with Google and land here with this role.'),
  },
  handler(a, ctx) {
    const ws = wsp.currentName();
    if (a.email) {
      const usr = require('../../../users.js');
      let inv;
      try { inv = usr.inviteEmail(ws, a.email, a.role, ctx.actor); }
      catch (e) { throw new (require('../../../registry.js').Rejected)(e.message); }
      return { email: inv.email, role: inv.role,
        note: inv.active
          ? `${inv.email} already has a Saybooks account — this space appears in their switcher now.`
          : `${inv.email} gets access the first time they sign in with Google at saybooks.io. No invitation email goes out — this system sends nothing, by design; tell them yourself.` };
    }
    const m = members.mint(ws, a.name, a.role);
    return { name: m.name, role: m.role, token: m.token,
      join_path: `/app?join=${m.token}`, mcp_path: `/mcp/${m.token}`,
      note: 'The link is the key. Share it with exactly one person.' };
  },
});

read({ name: 'core_members', title: 'Members', summary: 'Who has access: email members (Google sign-in) and token keys (agents, link shares).',
  args: {}, handler: () => ({ workspace: wsp.currentName(), members: members.list(wsp.currentName()),
    email_members: require('../../../users.js').emailMembers(wsp.currentName()) }) });

defineCommand({
  name: 'core_revoke_member',
  title: 'Revoke member', group: 'Workspace', subject: 'workspace', scope: 'collection',
  permission: 'workspace.admin',
  summary: 'Revoke a member\'s token. Their link stops working immediately.',
  doctrine: 'Revocation is a logged act like any other; the member\'s past entries in the trail keep their name. Nothing is deleted.',
  effects: ['member token revoked'],
  args: { name: { ...f.text('The member to revoke.'), required: true } },
  handler(a) {
    const ws = wsp.currentName();
    const n = members.revoke(ws, a.name) + require('../../../users.js').revokeEmail(ws, a.name);
    if (!n) throw new (require('../../../registry.js').Rejected)(`No active member named ${a.name} here (names and emails both count).`);
    return { revoked: a.name };
  },
});

// Workspace plumbing — never mounted in production.
if ((process.env.SAYBOOKS_ENV || process.env.OTC_ENV) !== 'production') {
  read({ name: 'core_workspaces', title: 'Workspaces', summary: 'List the workspaces on this deployment and which one this session is in.',
    doctrine: 'On a hosted demo this answers with your sandbox only: a sandbox name is the key to that sandbox, so other visitors\' names are never listed.',
    args: {}, handler: () => (process.env.SAYBOOKS_DEMO || process.env.OTC_DEMO) === '1'
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

/* The journal: double-entry lines DERIVED from the books over a date range — a projection
 * for the ledger of record (QuickBooks/Xero import, an accountant's CSV), never a posting.
 * Every entry balances by construction (INV-23); a voided invoice contributes nothing. */
read({
  name: 'core_journal',
  title: 'Journal', summary: 'Double-entry journal lines derived from the books, for export to the ledger of record.',
  doctrine: `Nothing here is posted or stored — re-derivation is the truth. Fixed accounts; a
voided invoice contributes nothing (INV-23). Revenue side only: items carry no cost, so there
are no COGS or inventory entries — the ledger of record owns inventory and margin. The ledger
of record stays wherever it is.`,
  args: {
    from: f.date('Include events on/after this date. Omit for all.'),
    to: f.date('Include events on/before this date. Omit for all.'),
    currency: f.text('Only entries in this currency (ISO 4217). Omit for all — but sums only mean something within one currency.'),
  },
  handler: (a) => require('../index.js').journal(a),
});

read({
  name: 'core_get_customer', title: 'Customer', subject: 'customer',
  summary: 'One customer as master data: contact facts, billing address, tax id, terms, hold state. (o2c adds the live credit position in o2c_get_customer.)',
  args: { customer_id: { ...f.ref('customer', 'The customer.'), required: true } },
  handler: (a) => { const c = H.need('customer', a.customer_id, 'customer'); return { ...c, credit_limit_display: H.money(c.credit_limit), on_hold: !!c.on_hold }; },
});

read({
  name: 'core_setup_status',
  title: 'Setup checklist', summary: 'Is this space ready to invoice, and if not, the next question to ask — in order.',
  doctrine: `Call this FIRST in a space you have not seen before, before core_schema's details
matter. It lists what the company profile still needs, in the order to ask: name, country,
currency, tax scheme, address, payment instructions; then the optional numbering format and
logo; then a first client. Ask ONE question at a time, in that order, as a person would —
"What's the business called, as it should print on invoices?" — and write each answer with
core_set_company_profile as you get it. 'next' is the key to ask about now; 'ask' is a
question you may use verbatim. Country comes first because it decides how dates and amounts
print; tax must be ANSWERED (registered yes or no) — the default is not an answer. Nothing here
is needed for a job-hunt space.`,
  args: {},
  handler: () => {
    const has = (n) => MODULES.some(m => m.name === n);
    const billing = has('solo') || has('o2c');
    const p = H.db().prepare('SELECT * FROM company_profile WHERE id = 1').get() || {};
    const loc = H.locale();
    const customers = H.db().prepare('SELECT COUNT(*) n FROM customer').get().n;
    const steps = [
      { key: 'name', done: !!p.name, ask: "What is the business called, as it should print on an invoice? (A personal trading name is fine.)", set_with: 'core_set_company_profile { name }' },
      { key: 'country', done: !!p.country, ask: 'Which country is the business in? Two letters is enough (NZ, US, CZ). It decides how dates and amounts print.', set_with: 'core_set_company_profile { country }' },
      { key: 'currency', done: !!p.currency, ask: 'Which currency do you bill in most? And are there others you sometimes invoice in?', set_with: 'core_set_company_profile { currency, currencies }' },
      { key: 'tax', done: !!p.tax_decided, ask: loc.country === 'NZ' ? 'Are you registered for GST? If yes, the rate is 15% unless you tell me otherwise.' : 'Are you registered for a sales tax or VAT (GST, VAT, ÁFA, DPH)? If yes: what is it called and what is the default rate?', set_with: 'core_set_company_profile { tax_registered, tax_label, tax_rate_bp, tax_id_label }' },
      { key: 'address', done: !!p.address, ask: 'What is the address as it should print under the business name?', set_with: 'core_set_company_profile { address }' },
      { key: 'payment_instructions', done: !!p.payment_instructions, ask: 'How do clients pay you? Bank name, account number, and any reference they should quote — this prints on every invoice.', set_with: 'core_set_company_profile { payment_instructions }' },
      { key: 'tax_id', done: !!p.tax_id, optional: true, ask: 'Do you want a tax id printed (IRD number, VAT ID, EIN)? If so, what is it and how should it be captioned?', set_with: 'core_set_company_profile { tax_id, tax_id_label }' },
      { key: 'number_format', done: !!p.number_format, optional: true, ask: `Invoice numbers are ${loc.number_format || 'INV-0001, INV-0002'} by default. Keep that, or restart each year as INV-2026-001?`, set_with: 'core_set_company_profile { number_format }' },
      { key: 'logo', done: !!p.logo, optional: true, ask: 'Do you have a logo at a public URL? I can put it on the documents. Skip is fine.', set_with: 'core_set_company_logo { logo_url }' },
      { key: 'first_client', done: customers > 0, optional: true, ask: 'Who is the first client to invoice? Name, billing address, and the payment terms you agreed.', set_with: 'core_create_customer' },
    ];
    const required = steps.filter(s => !s.optional);
    const next = steps.find(s => !s.done) || null;
    return {
      applies: billing, ready_to_invoice: billing ? required.every(s => s.done) : null,
      next: next ? next.key : null, ask: next ? next.ask : null, set_with: next ? next.set_with : null,
      missing: required.filter(s => !s.done).map(s => s.key), optional_open: steps.filter(s => s.optional && !s.done).map(s => s.key),
      steps: steps.map(s => ({ key: s.key, done: s.done, optional: !!s.optional })),
      note: !billing ? 'This space has no invoicing or order-to-cash module mounted; no company profile is needed.'
          : next && !next.optional ? `Not ready to invoice yet: ask about ${next.key}.` : next ? `Ready to invoice. Optional: ${next.key}.` : 'Ready to invoice; nothing left to set up.',
    };
  },
});

read({
  name: 'core_company_profile',
  title: 'Company profile', summary: "The business's own identity as it prints on documents: seller block, tax id, payment instructions.",
  args: {},
  args: { with_logo: f.bool('Include the logo itself as a data URL — large. Otherwise only its type and size come back.') },
  handler: (a) => {
    const p = H.db().prepare('SELECT * FROM company_profile WHERE id = 1').get();
    const loc = H.locale();
    if (!p) return { name: null, address: null, tax_id: null, payment_instructions: null, footer_note: null, country: null, currency: loc.currency, currencies: loc.currencies, tax_label: null, tax_rate_bp: 0, tax_registered: false, tax_id_label: null, number_format: null, has_logo: false, set: false };
    const { logo, ...p2 } = p;
    const rest = { ...p2, currency: loc.currency, currencies: loc.currencies, tax_registered: !!p2.tax_registered, tax_decided: !!p2.tax_decided };
    const m = logo ? /^data:([^;]+);base64,([\s\S]*)$/.exec(logo) : null;
    return { ...rest, has_logo: !!logo, logo_type: m ? m[1] : null, logo_bytes: m ? Math.floor(m[2].length * 3 / 4) : 0, ...(a.with_logo && logo ? { logo } : {}) };
  },
});
