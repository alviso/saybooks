'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'bridge_map_account',
  permission: 'workspace.admin',
  title: 'Map an account', group: 'Ledger', subject: 'bridge_account_map', scope: 'collection',
  summary: 'Say what one of our derivation accounts is called in the ledger of record: its code, its name, its tax rate label.',
  doctrine: `The mapping is the accountant's answer, not a guess: ask for the code and the name
exactly as their chart spells them, one account at a time, and write them as they are given.
Xero imports match on the code, QuickBooks on the name, so supply both where you can. The tax
rate label is only needed where their import expects one on that account. Changing a mapping
never rewrites a hand-over that already went out.`,
  effects: ['account mapping written'],
  args: {
    account: { ...f.pick(V.ACCOUNTS.map(a => a.account), 'Which of our accounts.'), required: true },
    code: f.text('Their account code, as their chart spells it (Xero AccountCode).'),
    name: f.text('Their account name, exactly (QuickBooks Account Name).'),
    tax_rate: f.text('The tax rate label their import expects on this account, if any.'),
    note: f.text('Anything the accountant said about it.'),
    reason: f.text('Why — part of the record.'),
  },
  handler(a, { db, at }) {
    if (!V.ACCOUNTS.some(x => x.account === a.account)) throw new Rejected(`${a.account} is not one of our derivation accounts. They are: ${V.ACCOUNTS.map(x => x.account).join(', ')}.`);
    if (!a.code && !a.name) throw new Rejected('A mapping needs at least their code or their account name — Xero matches on the code, QuickBooks on the name.');
    const cur = db.prepare('SELECT * FROM bridge_account_map WHERE account = ?').get(a.account) || {};
    const next = { code: a.code !== undefined ? (a.code || null) : (cur.code || null), name: a.name !== undefined ? (a.name || null) : (cur.name || null),
      tax_rate: a.tax_rate !== undefined ? (a.tax_rate || null) : (cur.tax_rate || null), note: a.note !== undefined ? (a.note || null) : (cur.note || null) };
    db.prepare(`INSERT INTO bridge_account_map (account, code, name, tax_rate, note, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account) DO UPDATE SET code=excluded.code, name=excluded.name, tax_rate=excluded.tax_rate, note=excluded.note, updated_at=excluded.updated_at`)
      .run(a.account, next.code, next.name, next.tax_rate, next.note, at);
    const v = V.accountsView();
    return { account: a.account, ...next, unmapped_in_use: v.unmapped_in_use, ready: v.ready };
  },
});
