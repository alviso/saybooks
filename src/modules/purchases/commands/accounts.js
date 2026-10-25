'use strict';
/**
 * The accounts a person has (purchases 0.6): a register that statements belong to, values stated
 * for things without statements, balances from what was printed or stated, and net worth.
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const isDate = (k, v) => { if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Rejected(`${k} is a date, YYYY-MM-DD.`); };
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Accounts read', ...def });

defineCommand({
  name: 'purch_add_account',
  permission: 'cash.write',
  title: 'Add account', group: 'Accounts', subject: 'purch_account', scope: 'collection',
  summary: 'Add an account to the register: a bank or savings account, a credit card, a loan, or something with a value (a house, a car).',
  doctrine: `Name it as its statements print it ("Chase Checking ending 4410"), so statements find it.
Importing a statement for an account that is not here yet adds it by itself; add one by hand for
a card or loan before its first statement, or for something that never has statements (a house, a
car): give that its value with purch_record_value, from a source the person names.`,
  effects: ['account added to the register'],
  args: {
    name:        { ...f.text('As statements print it, e.g. "Visa ending 8827".'), required: true },
    kind:        { ...f.pick(V.ACCOUNT_KINDS, 'What it is.'), required: true },
    currency:    { ...f.text('ISO 4217 code.'), required: true },
    institution: f.text('The bank or lender.'),
    last4:       f.text('Last four digits, as printed.'),
    opened_on:   f.date('When it was opened, if known.'),
    notes:       f.note('Anything the person said about it.'),
  },
  handler(a, { db, at }) {
    const name = String(a.name || '').trim(); if (!name) throw new Rejected('An account needs a name.');
    const cur = String(a.currency).toUpperCase(); if (!H.CUR_RE.test(cur)) throw new Rejected('currency is a three-letter ISO 4217 code.');
    isDate('opened_on', a.opened_on);
    if (a.last4 && !/^\d{4}$/.test(String(a.last4))) throw new Rejected('last4 is four digits.');
    const dup = db.prepare('SELECT id FROM purch_account WHERE name = ? COLLATE NOCASE AND currency = ?').get(name, cur);
    if (dup) throw new Rejected(`${dup.id} is already called "${name}" in ${cur}.`);
    const id = H.nextId('ACC', 'purch_account');
    db.prepare('INSERT INTO purch_account (id,name,kind,currency,institution,last4,opened_on,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, a.kind, cur, a.institution || null, a.last4 || null, a.opened_on || null, a.notes || null, at, at);
    return { ...V.accountView(id), note: `Added ${id}: ${name}, ${a.kind.replace('_', ' ')}, ${cur}.` };
  },
});

defineCommand({
  name: 'purch_update_account',
  permission: 'cash.write',
  title: 'Update account', group: 'Accounts', subject: 'purch_account',
  summary: 'Change what the register says about an account: its kind, institution, last four digits, opening date, notes. Its name stays: statements are filed under it.',
  doctrine: 'Corrections from what the person or a statement says. A kind that does not fit the statements already on it is refused.',
  effects: ['account details updated'],
  guardless: true,
  args: {
    account_id:  { ...f.ref('purch_account', 'The account, e.g. ACC-0001.'), required: true },
    kind:        f.pick(V.ACCOUNT_KINDS, ''),
    institution: f.text(''), last4: f.text(''), opened_on: f.date(''), notes: f.note(''),
  },
  handler(a, { db, at }) {
    const acc = H.need('purch_account', a.account_id, 'account');
    isDate('opened_on', a.opened_on);
    if (a.last4 && !/^\d{4}$/.test(String(a.last4))) throw new Rejected('last4 is four digits.');
    if (a.kind && a.kind !== acc.kind) {
      const kinds = [...new Set(V.statementsOf(acc.id).map(s => s.kind))];
      const bad = kinds.filter(k => !V.STATEMENT_KIND[a.kind].includes(k));
      if (bad.length) throw new Rejected(`${acc.id} carries ${bad.join(' and ')} statements; a ${a.kind.replace('_', ' ')} account does not.`);
    }
    for (const k of ['kind', 'institution', 'last4', 'opened_on', 'notes']) if (a[k] !== undefined) db.prepare(`UPDATE purch_account SET ${k} = ?, updated_at = ? WHERE id = ?`).run(a[k] === '' ? null : a[k], at, acc.id);
    return V.accountView(acc.id);
  },
});

defineCommand({
  name: 'purch_close_account',
  permission: 'cash.write',
  title: 'Close account', group: 'Accounts', subject: 'purch_account',
  summary: 'Mark an account closed from a day, with a reason. It stays in the register and its statements stay; it leaves net worth from that day.',
  doctrine: 'Only when the person says it is closed. A closing balance that is not zero is named in the result, not refused: that money went somewhere worth recording.',
  effects: ['account closed from a day'],
  guards: [ (acc) => !acc.closed_on || `${acc.id} is already closed (${acc.closed_on}).` ],
  args: {
    account_id: { ...f.ref('purch_account', 'The account.'), required: true },
    closed_on:  { ...f.date('The day it closed.'), required: true },
    reason:     { ...f.text('Why, for the record.'), required: true },
  },
  handler(a, { db, at }) {
    const acc = H.need('purch_account', a.account_id, 'account');
    if (acc.closed_on) throw new Rejected(`${acc.id} is already closed (${acc.closed_on}).`);
    isDate('closed_on', a.closed_on);
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Closing an account needs a reason.');
    db.prepare('UPDATE purch_account SET closed_on = ?, close_reason = ?, updated_at = ? WHERE id = ?').run(a.closed_on, why, at, acc.id);
    const v = V.accountView(acc.id, a.closed_on);
    return { ...v, note: `${acc.id} closed from ${a.closed_on}.${v.balance ? ` Its last known balance is ${v.balance_display} (${v.balance_from}); if that money moved, record where.` : ''}` };
  },
});

defineCommand({
  name: 'purch_record_value',
  permission: 'cash.write',
  title: 'Record a value', group: 'Accounts', subject: 'purch_account',
  summary: 'State what something without statements is worth, or what is still owed on it, on a day, with where the figure comes from: a house, a car, an outside loan.',
  doctrine: `A value is the person's figure with where it comes from (according_to: "county assessment
2026", "Kelley Blue Book, private party", "lender's payoff letter"). Never estimate one yourself. Bank and card balances come
from their statements, not from here. Give the amount as a positive number: what it is worth for a
thing you own, what is owed for a loan; the sign follows the kind.`,
  effects: ['value recorded with its date and source'],
  guards: [ (acc) => !['checking', 'savings', 'credit_card'].includes(acc.kind) || `${acc.id} is a ${acc.kind.replace('_', ' ')} account: its balance comes from its statements.` ],
  args: {
    account_id: { ...f.ref('purch_account', 'The account.'), required: true },
    as_of:      { ...f.date('The day the figure is for.'), required: true },
    amount:     { ...f.money('What it is worth, or for a loan what is owed, as a positive amount.'), required: true },
    according_to: { ...f.text('Where the figure comes from: "county assessment 2026", "lender\'s payoff letter".'), required: true },
    reason:     f.text('Anything the person said.'),
  },
  handler(a, { db, at, actor }) {
    const acc = H.need('purch_account', a.account_id, 'account');
    isDate('as_of', a.as_of);
    if (a.as_of > H.today()) throw new Rejected(`${a.as_of} is in the future. A value is for a day that has happened.`);
    if (['checking', 'savings', 'credit_card'].includes(acc.kind)) throw new Rejected(`${acc.id} is a ${acc.kind.replace('_', ' ')} account: its balance comes from its statements. Import the statement instead.`);
    if (!Number.isInteger(a.amount) || a.amount < 0) throw new Rejected('amount is whole cents, zero or more; the sign follows the kind.');
    const src = String(a.according_to || '').trim(); if (!src) throw new Rejected('A value needs its source: where the figure comes from.');
    const value = acc.kind === 'loan' ? -a.amount : a.amount;
    db.prepare('INSERT INTO purch_valuation (account_id,as_of,value,source,reason,recorded_by,created_at) VALUES (?,?,?,?,?,?,?)').run(acc.id, a.as_of, value, src, a.reason || null, actor || null, at);
    return { ...V.accountView(acc.id), note: `${acc.name}: ${H.money(Math.abs(value), acc.currency)} ${acc.kind === 'loan' ? 'owed' : 'worth'} as of ${a.as_of}, from ${src}.` };
  },
});

read({ name: 'purch_accounts', title: 'Accounts', summary: 'Every account with its balance (from its latest statement, or a stated value), as of when, and any gap or jump between its statements.',
  args: { as_of: f.date('The day. Defaults to today.') }, handler: (a) => V.accounts(a) });
read({ name: 'purch_account', title: 'Account', summary: 'One account: its statements in order, the values stated for it, its balance, and where its statements do not chain.',
  args: { account_id: { ...f.text('e.g. ACC-0001.'), required: true }, as_of: f.date('') }, handler: (a) => V.accountView(a.account_id, a.as_of || undefined) });
read({ name: 'purch_net_worth', title: 'Net worth', summary: 'What is held less what is owed, per currency, on a day: each account\'s figure with its date and source; old figures named.',
  args: { as_of: f.date('The day. Defaults to today.') }, handler: (a) => V.netWorth(a) });
