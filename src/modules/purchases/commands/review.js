'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const STATUSES = ['purchase', 'transfer', 'income', 'fee', 'ignored'];

defineCommand({
  name: 'purch_review_transaction',
  permission: 'cash.write',
  title: 'Review', group: 'Purchases', subject: 'purch_transaction',
  summary: 'Say what a row is — purchase, transfer, income, fee, ignored — with a category and a reason. Amount and date never change.',
  doctrine: `A reasoned act (P-5). Categories are the person's words; ask rather than guess. A transfer
is money moving between the person's own accounts; a fee is the bank's charge; ignored is a
row that is not theirs to track. Never alter the amount or the date — a wrong row means a
wrong source, re-read and re-imported.`,
  effects: ['status, category, note recorded'],
  guardless: true,   // any row may be re-reviewed; the sign checks live in the handler with their reasons
  args: {
    transaction_id: { ...f.text('The row, e.g. T-0012.'), required: true },
    status: { ...f.pick(STATUSES, 'What it is.'), required: true },
    category: f.text('The person\'s own word for it (groceries, software, travel). Empty beats guessed.'),
    note: f.note('Anything the person said about it.'),
    reason: f.text('Why — part of the record.'),
  },
  handler(a, { db, at }) {
    const t = H.need('purch_transaction', a.transaction_id, 'transaction');
    if (a.status === 'purchase' && t.amount > 0) throw new Rejected(`${t.id} is money in (${H.money(t.amount, t.currency)}); a purchase is spending. Income, transfer or ignored?`);
    if (a.status === 'income' && t.amount < 0) throw new Rejected(`${t.id} is spending (${H.money(t.amount, t.currency)}); income is money in.`);
    db.prepare('UPDATE purch_transaction SET status = ?, category = COALESCE(?, category), note = COALESCE(?, note), reviewed_at = ? WHERE id = ?')
      .run(a.status, a.category ? a.category.trim() : null, a.note || null, at, t.id);
    return V.transactionView(t.id);
  },
});

defineCommand({
  name: 'purch_set_vendor',
  permission: 'cash.write',
  title: 'Name the vendor', group: 'Purchases', subject: 'purch_transaction',
  summary: 'Name the shop behind a row once; its statement spelling becomes an alias for every later row.',
  doctrine: 'One vendor, many spellings. The alias is the description as printed; pass it (or let it default to the row\'s description) so the next statement names the shop by itself.',
  effects: ['vendor created if new', 'alias recorded', 'vendor set on every unassigned row with that description'],
  guardless: true,   // naming a shop is always allowed
  args: {
    transaction_id: { ...f.text('The row.'), required: true },
    vendor: { ...f.text('The vendor\'s proper name (Netflix, Countdown).'), required: true },
    alias: f.text('The statement spelling to remember. Defaults to the row\'s description.'),
    reason: f.text('Why — optional.'),
  },
  handler(a, { db, at }) {
    const t = H.need('purch_transaction', a.transaction_id, 'transaction');
    const name = a.vendor.trim(); if (!name) throw new Rejected('A vendor needs a name.');
    let v = db.prepare('SELECT * FROM purch_vendor WHERE name = ? COLLATE NOCASE').get(name);
    if (!v) { const id = H.nextId('V', 'purch_vendor'); db.prepare('INSERT INTO purch_vendor (id,name,created_at) VALUES (?,?,?)').run(id, name, at); v = { id, name }; }
    const alias = (a.alias || t.description).trim();
    db.prepare('INSERT OR REPLACE INTO purch_vendor_alias (alias, vendor_id) VALUES (?,?)').run(alias, v.id);
    const applied = db.prepare('UPDATE purch_transaction SET vendor_id = ? WHERE vendor_id IS NULL AND lower(description) = lower(?)').run(v.id, alias).changes;
    db.prepare('UPDATE purch_transaction SET vendor_id = ? WHERE id = ?').run(v.id, t.id);
    return { ...V.transactionView(t.id), vendor_id: v.id, alias, applied_to: applied };
  },
});
