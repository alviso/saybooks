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
  },
  handler(a) {
    const db = H.db();
    const money = (c) => '$' + (c / 100).toFixed(2);
    const day = (d) => String(d || '').slice(0, 10);
    const inRange = (d) => (!a.from || day(d) >= a.from) && (!a.to || day(d) <= a.to);
    const entries = [];
    const push = (date, memo, customer, lines) => {
      const dr = lines.reduce((s, l) => s + (l.debit || 0), 0);
      const cr = lines.reduce((s, l) => s + (l.credit || 0), 0);
      if (dr !== cr) throw new Error(`journal derivation bug: unbalanced entry "${memo}" (${dr} vs ${cr})`);
      if (dr === 0) return;
      entries.push({ date: day(date), memo, customer, lines: lines.filter(l => (l.debit || 0) + (l.credit || 0) > 0)
        .map(l => ({ ...l, debit_display: l.debit ? money(l.debit) : '', credit_display: l.credit ? money(l.credit) : '' })) });
    };
    const cname = {}; for (const c of db.prepare('SELECT id, name FROM customer').all()) cname[c.id] = c.name;

    for (const i of db.prepare("SELECT * FROM invoice WHERE status <> 'void' ORDER BY id").all()) {
      if (!inRange(i.issued_at)) continue;
      // Goods and services credit separate revenue accounts (stocked flag decides); if the
      // line math ever disagrees with the invoice net, everything goes to Sales Revenue —
      // balanced beats beautifully classified.
      const net = i.total - i.tax_total;
      const sp = db.prepare(`SELECT COALESCE(SUM(CASE WHEN it.stocked = 1 THEN il.qty * il.unit_price ELSE 0 END), 0) goods,
                                    COALESCE(SUM(CASE WHEN it.stocked = 0 THEN il.qty * il.unit_price ELSE 0 END), 0) service
                             FROM invoice_line il JOIN item it ON it.id = il.item_id WHERE il.invoice_id = ?`).get(i.id);
      const goods = (sp.goods + sp.service === net) ? sp.goods : net;
      const service = (sp.goods + sp.service === net) ? sp.service : 0;
      push(i.issued_at, `Invoice ${i.id}`, cname[i.customer_id], [
        { account: 'Accounts Receivable', debit: i.total },
        { account: 'Sales Revenue', credit: goods },
        { account: 'Service Revenue', credit: service },
        { account: 'Sales Tax Payable', credit: i.tax_total },
      ]);
    }
    for (const p of db.prepare('SELECT * FROM payment ORDER BY id').all()) {
      if (!inRange(p.received_at)) continue;
      push(p.received_at, `Payment ${p.id}${p.reference ? ' · ' + p.reference : ''}`, cname[p.customer_id], [
        { account: 'Cash', debit: p.amount },
        { account: 'Customer Deposits', credit: p.amount },
      ]);
    }
    for (const ap of db.prepare(`SELECT pa.*, p.received_at, p.customer_id FROM payment_application pa
                                 JOIN payment p ON p.id = pa.payment_id ORDER BY pa.id`).all()) {
      const at2 = ap.applied_at || ap.received_at;
      if (!inRange(at2)) continue;
      push(at2, `Apply ${ap.payment_id} → ${ap.invoice_id}`, cname[ap.customer_id], [
        { account: 'Customer Deposits', debit: ap.amount },
        { account: 'Accounts Receivable', credit: ap.amount },
      ]);
    }
    for (const cn of db.prepare('SELECT * FROM credit_note ORDER BY id').all()) {
      if (!inRange(cn.created_at)) continue;
      if (cn.kind === 'write_off') {
        push(cn.created_at, `Write-off ${cn.id}${cn.invoice_id ? ' · ' + cn.invoice_id : ''}`, cname[cn.customer_id], [
          { account: 'Bad Debt Expense', debit: cn.total },
          { account: 'Accounts Receivable', credit: cn.total },
        ]);
      } else {
        push(cn.created_at, `Credit note ${cn.id} (${cn.kind})`, cname[cn.customer_id], [
          { account: 'Sales Returns & Allowances', debit: cn.total },
          { account: 'Customer Credits', credit: cn.total },
        ]);
      }
    }
    for (const ca of db.prepare(`SELECT ca.*, cn.created_at, cn.customer_id, cn.kind FROM credit_application ca
                                 JOIN credit_note cn ON cn.id = ca.credit_note_id WHERE cn.kind <> 'write_off' ORDER BY ca.id`).all()) {
      const at2 = ca.applied_at || ca.created_at;
      if (!inRange(at2)) continue;
      push(at2, `Apply ${ca.credit_note_id} → ${ca.invoice_id}`, cname[ca.customer_id], [
        { account: 'Customer Credits', debit: ca.amount },
        { account: 'Accounts Receivable', credit: ca.amount },
      ]);
    }
    for (const rf of db.prepare('SELECT * FROM refund ORDER BY id').all()) {
      if (!inRange(rf.recorded_at)) continue;
      push(rf.recorded_at, `Refund ${rf.id} (${rf.source_type} ${rf.source_id})`, null, [
        { account: rf.source_type === 'payment' ? 'Customer Deposits' : 'Customer Credits', debit: rf.amount },
        { account: 'Cash', credit: rf.amount },
      ]);
    }

    entries.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    const debits = entries.reduce((s, e) => s + e.lines.reduce((s2, l) => s2 + (l.debit || 0), 0), 0);
    const credits = entries.reduce((s, e) => s + e.lines.reduce((s2, l) => s2 + (l.credit || 0), 0), 0);
    return { from: a.from || null, to: a.to || null, entry_count: entries.length,
      debits, credits, debits_display: money(debits), credits_display: money(credits),
      balanced: debits === credits, entries };
  },
});

read({
  name: 'core_company_profile',
  title: 'Company profile', summary: "The business's own identity as it prints on documents: seller block, tax id, payment instructions.",
  args: {},
  handler: () => H.db().prepare('SELECT * FROM company_profile WHERE id = 1').get() || { name: null, address: null, tax_id: null, payment_instructions: null, footer_note: null, set: false },
});
