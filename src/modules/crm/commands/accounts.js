'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const NARRATIVE = {
  tier:          f.int('1–3. Tier semantics are yours; 1 usually means "worth a hand-written approach".'),
  vertical:      f.text('Industry vertical, your taxonomy.'),
  trigger_event: f.text('What changed that makes now the moment. A fact, with the source in source_url.'),
  hook:          f.text('The one-sentence opener you would actually use.'),
  owner_note:    f.note('Working notes.'),
};

defineCommand({
  name: 'crm_add_account',
  title: 'New account', group: 'CRM', subject: 'account', scope: 'collection',
  permission: 'sales.write',
  summary: 'Add a researched account to the list.',
  doctrine: `The gate to the list (CRM-3): why_them and source_url are mandatory, because this is
a curated list, not a funnel — its value is that every row can say why it belongs and where
that knowledge came from. If you cannot say why them and what changed, it is not a target yet.`,
  effects: ['account created in not_started'],
  args: {
    name:       { ...f.text('The company, as it calls itself.'), required: true },
    why_them:   { ...f.note('Why this account belongs on a short list. The researched answer, not a vibe.'), required: true },
    source_url: { ...f.text('Where why_them can be verified.'), required: true },
    ...NARRATIVE,
  },
  handler(a, { db, at }) {
    if (db.prepare('SELECT id FROM account WHERE lower(name) = lower(?)').get(a.name)) {
      throw new Rejected(`${a.name} is already on the list. Update it rather than adding a twin.`);
    }
    const id = H.nextId('A', 'account');
    db.prepare(`INSERT INTO account (id,name,tier,vertical,why_them,trigger_event,hook,source_url,status,owner_note,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,'not_started',?,?,?)`)
      .run(id, a.name, a.tier || null, a.vertical || null, a.why_them, a.trigger_event || null, a.hook || null, a.source_url, a.owner_note || null, at, at);
    return V.accountView(id);
  },
});

defineCommand({
  name: 'crm_update_account',
  title: 'Update account', group: 'CRM', subject: 'account',
  permission: 'sales.write', guardless: true,
  summary: 'Correct or deepen the account narrative. Only the fields you pass change.',
  doctrine: 'Provenance survives updates (CRM-9): why_them and source_url can be corrected, never blanked. Status moves have their own command, with its own rules.',
  effects: ['account narrative updated'],
  args: {
    account_id: { ...f.ref('account', 'The account.'), required: true },
    name: f.text('Rename, if the company did.'),
    why_them: f.note('Correcting, not blanking (CRM-9).'),
    source_url: f.text('Correcting, not blanking (CRM-9).'),
    ...NARRATIVE,
  },
  handler(a, { db, at }) {
    H.need('account', a.account_id, 'account');
    for (const k of ['why_them', 'source_url']) {
      if (a[k] === '') throw new Rejected(`${k} can be corrected, never removed (CRM-9).`);
    }
    if (a.name === '') throw new Rejected('An account keeps its name.');
    const fields = ['name', 'why_them', 'source_url', 'tier', 'vertical', 'trigger_event', 'hook', 'owner_note'];
    // An explicit empty string means CLEAR (stored as NULL); absent means untouched.
    // why_them and source_url already refused above when blanked (CRM-9).
    for (const k of fields) if (a[k] !== undefined) db.prepare(`UPDATE account SET ${k} = ?, updated_at = ? WHERE id = ?`).run(a[k] === '' ? null : a[k], at, a.account_id);
    return V.accountView(a.account_id);
  },
});

const TERMINAL = ['won', 'closed', 'excluded'];
const NEEDS_REASON = ['on_hold', 'closed', 'excluded'];

defineCommand({
  name: 'crm_set_account_status',
  title: 'Move status', group: 'CRM', subject: 'account',
  permission: 'sales.write',
  summary: 'Move an account along the pursuit lifecycle.',
  doctrine: `Parking or killing a researched account requires a reason (CRM-7) — on_hold, closed
and excluded all carry prose that will be read back. won, closed and excluded are terminal:
nothing is deleted, and nothing quietly comes back either (CRM-6). Re-pursuing a closed
account is a new decision — say so in a fresh why_them via update, then reopen deliberately
is not offered: add it again the day it genuinely earns a new place.`,
  effects: ['account.status moved, reason kept'],
  guards: [ (acc) => !TERMINAL.includes(acc.status) || `${acc.status} is final for this account — nothing is deleted, and nothing quietly comes back (CRM-6).` ],
  args: {
    account_id: { ...f.ref('account', 'The account.'), required: true },
    status: { ...f.pick(['not_started', 'researching', 'approaching', 'active', 'won', 'on_hold', 'closed', 'excluded'], 'Where it moves.'), required: true },
    reason: f.note('Required for on_hold, closed and excluded. Recommended for won.'),
  },
  handler(a, { db, at }) {
    const acc = H.need('account', a.account_id, 'account');
    if (TERMINAL.includes(acc.status)) throw new Rejected(`${acc.status} is final for this account — nothing is deleted, and nothing quietly comes back (CRM-6).`);
    if (NEEDS_REASON.includes(a.status) && !a.reason) throw new Rejected(`Moving to ${a.status} requires a reason — parking or killing a researched account is a decision someone later asks about (CRM-7).`);
    db.prepare('UPDATE account SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
      .run(a.status, a.reason || null, at, a.account_id);
    return V.accountView(a.account_id);
  },
});

defineCommand({
  name: 'crm_set_path_in',
  title: 'Set path in', group: 'CRM', subject: 'account',
  permission: 'sales.write', guardless: true,
  summary: 'Replace the ordered "how we get in" plan for an account.',
  doctrine: 'The bullets replace the previous set whole — a plan is one coherent thing, not a pile of appended thoughts. The old plan stays in the audit trail.',
  effects: ['path-in bullets replaced'],
  args: {
    account_id: { ...f.ref('account', 'The account.'), required: true },
    bullets: { ...f.lines({ bullet: { ...f.text('One step of the plan.'), required: true } }, 'The plan, in order.'), required: true },
  },
  handler(a, { db }) {
    H.need('account', a.account_id, 'account');
    if (!a.bullets.length) throw new Rejected('An empty plan is not a plan — pass the bullets, or leave the old ones standing.');
    db.prepare('DELETE FROM account_path_in WHERE account_id = ?').run(a.account_id);
    a.bullets.forEach((b, i) => db.prepare('INSERT INTO account_path_in (account_id, sort, bullet) VALUES (?,?,?)').run(a.account_id, i + 1, b.bullet));
    return V.accountView(a.account_id);
  },
});
