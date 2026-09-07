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

const REVIEW_ROW = {
  transaction_id: { ...f.text('The row, e.g. T-0012.'), required: true },
  status: { ...f.pick(STATUSES, 'What it is.'), required: true },
  category: f.text('The person\'s word for it. Empty beats guessed.'),
  vendor: f.text('The vendor\'s proper name; the row\'s description becomes its alias.'),
  note: f.text('Anything the person said about it.'),
};

defineCommand({
  name: 'purch_review_batch',
  permission: 'cash.write',
  title: 'Review many', group: 'Purchases', subject: 'purch_transaction', scope: 'collection',
  summary: 'Review a whole statement in one act: status, category and vendor per row, one reason. Checked whole; refused whole.',
  doctrine: `The same rules as purch_review_transaction, once for many rows: the person has
looked at your proposal and said which words to use — write it all in one act with their
confirmation as the reason. Every row is validated before any is written; a row you cannot
name stays out of the batch and unreviewed, never guessed. Up to 200 rows.`,
  effects: ['status, category, vendor recorded on every row listed'],
  args: {
    rows: { ...f.lines(REVIEW_ROW, 'The rows and what they are.'), required: true },
    reason: f.text('Why — typically "confirmed by the person" plus anything they said.'),
  },
  handler(a, { db, at }) {
    const rows = a.rows || [];
    if (!rows.length) throw new Rejected('Nothing to review.');
    if (rows.length > 200) throw new Rejected('Up to 200 rows per batch.');
    const seen = new Set();
    const plan = rows.map((r, i) => {
      if (seen.has(r.transaction_id)) throw new Rejected(`Row ${i + 1}: ${r.transaction_id} appears twice in the batch.`);
      seen.add(r.transaction_id);
      const t = H.get('purch_transaction', r.transaction_id);
      if (!t) throw new Rejected(`Row ${i + 1}: transaction ${r.transaction_id} does not exist.`);
      if (r.status === 'purchase' && t.amount > 0) throw new Rejected(`${t.id} is money in (${H.money(t.amount, t.currency)}); a purchase is spending.`);
      if (r.status === 'income' && t.amount < 0) throw new Rejected(`${t.id} is spending (${H.money(t.amount, t.currency)}); income is money in.`);
      return { t, r };
    });
    const vendorId = (name) => {
      let v = db.prepare('SELECT * FROM purch_vendor WHERE name = ? COLLATE NOCASE').get(name);
      if (!v) { const id = H.nextId('V', 'purch_vendor'); db.prepare('INSERT INTO purch_vendor (id,name,created_at) VALUES (?,?,?)').run(id, name, at); v = { id, name }; }
      return v.id;
    };
    let vendorsNamed = 0, aliased = 0;
    for (const { t, r } of plan) {
      db.prepare('UPDATE purch_transaction SET status = ?, category = COALESCE(?, category), note = COALESCE(?, note), reviewed_at = ? WHERE id = ?')
        .run(r.status, r.category ? r.category.trim() : null, r.note || null, at, t.id);
      if (r.vendor && r.vendor.trim()) {
        const vid = vendorId(r.vendor.trim());
        db.prepare('INSERT OR REPLACE INTO purch_vendor_alias (alias, vendor_id) VALUES (?,?)').run(t.description, vid);
        aliased += db.prepare('UPDATE purch_transaction SET vendor_id = ? WHERE vendor_id IS NULL AND lower(description) = lower(?)').run(vid, t.description).changes;
        db.prepare('UPDATE purch_transaction SET vendor_id = ? WHERE id = ?').run(vid, t.id);
        vendorsNamed++;
      }
    }
    const by = {};
    for (const { r } of plan) by[r.status] = (by[r.status] || 0) + 1;
    const left = db.prepare("SELECT COUNT(*) n FROM purch_transaction WHERE status = 'unreviewed'").get().n;
    return { reviewed: plan.length, by_status: by, vendors_named: vendorsNamed, rows_aliased: aliased, still_unreviewed: left,
      note: `${plan.length} rows reviewed in one act.${left ? ` ${left} still unreviewed — ask for their words.` : ' Nothing left unreviewed.'}` };
  },
});
