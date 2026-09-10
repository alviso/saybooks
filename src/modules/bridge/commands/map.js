'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'bridge_map_account',
  permission: 'workspace.admin',
  title: 'Map an account', group: 'Ledger', subject: 'bridge_map', scope: 'collection',
  summary: "Say what something is called in the ledger of record: one of our accounts, or one of the person's own spending categories or statement accounts.",
  doctrine: `The mapping is the accountant's answer, not a guess: ask for the code and the name
exactly as their chart spells them, one at a time, and write them as they are given. Xero
imports match on the code, QuickBooks on the name, so supply both where you can.

Three kinds. "derivation" is one of our fixed accounts (receivables, revenue, cash, bank fees).
"category" is a word the person used when reviewing their spending — groceries, software, rent —
and it needs their expense or income account. "source" is the account a statement came from,
their bank or card, and it needs that account in the chart. bridge_accounts lists all three and
says which are in use. The tax rate label is only needed where their import expects one.
Changing a mapping never rewrites a hand-over that already went out.`,
  effects: ['account mapping written'],
  args: {
    account: { ...f.text('Which one: an account name for "derivation", the person\'s word for "category", the statement account label for "source".'), required: true },
    kind: f.pick(V.KINDS, 'What is being mapped. Defaults to one of our derivation accounts.'),
    code: f.text('Their account code, as their chart spells it (Xero AccountCode).'),
    name: f.text('Their account name, exactly (QuickBooks Account Name).'),
    tax_rate: f.text('The tax rate label their import expects on this account, if any.'),
    note: f.text('Anything the accountant said about it.'),
    reason: f.text('Why — part of the record.'),
  },
  handler(a, { db, at }) {
    const kind = a.kind || 'derivation';
    if (!V.KINDS.includes(kind)) throw new Rejected(`kind must be one of ${V.KINDS.join(', ')}.`);
    if (kind === 'derivation' && !V.ACCOUNTS.some(x => x.account === a.account)) throw new Rejected(`${a.account} is not one of our derivation accounts. They are: ${V.ACCOUNTS.map(x => x.account).join(', ')}. A spending category or a statement account is mapped with kind "category" or "source".`);
    if (kind !== 'derivation') {
      const known = V.mappable()[kind].map(x => x.key);
      if (!known.includes(a.account)) throw new Rejected(`There is no ${kind} "${a.account}" in these books. ${known.length ? `The ones on record are: ${known.join(', ')}.` : 'Nothing has been reviewed under one yet.'}`);
    }
    if (!a.code && !a.name) throw new Rejected('A mapping needs at least their code or their account name — Xero matches on the code, QuickBooks on the name.');
    const cur = db.prepare('SELECT * FROM bridge_map WHERE kind = ? AND key = ?').get(kind, a.account) || {};
    const next = { code: a.code !== undefined ? (a.code || null) : (cur.code || null), name: a.name !== undefined ? (a.name || null) : (cur.name || null),
      tax_rate: a.tax_rate !== undefined ? (a.tax_rate || null) : (cur.tax_rate || null), note: a.note !== undefined ? (a.note || null) : (cur.note || null) };
    db.prepare(`INSERT INTO bridge_map (kind, key, code, name, tax_rate, note, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(kind, key) DO UPDATE SET code=excluded.code, name=excluded.name, tax_rate=excluded.tax_rate, note=excluded.note, updated_at=excluded.updated_at`)
      .run(kind, a.account, next.code, next.name, next.tax_rate, next.note, at);
    const v = V.accountsView();
    return { kind, account: a.account, ...next, unmapped_in_use: v.unmapped_in_use, ready: v.ready };
  },
});
