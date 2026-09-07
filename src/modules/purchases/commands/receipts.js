'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'purch_add_receipt',
  permission: 'cash.write',
  title: 'Add receipt', group: 'Purchases', subject: 'purch_receipt', scope: 'collection',
  summary: 'Record a receipt you read: vendor, date, total, and the file\'s name and hash. Candidates to match come back; matching is a separate act.',
  doctrine: 'The file stays with the person (P-9); this keeps what it says. Look at the candidates and match with purch_match_receipt, with a reason. An unmatched receipt is a visible state, not an error.',
  effects: ['receipt recorded, unmatched'],
  args: {
    name: { ...f.text('File name as given.'), required: true },
    hash: { ...f.text('Content hash, or a stable id you can repeat.'), required: true },
    vendor: f.text('The shop as printed on the receipt.'),
    date: { ...f.date('Receipt date.'), required: true },
    total: { ...f.money('The total on the receipt, positive.'), required: true },
    currency: { ...f.text('ISO 4217 code.'), required: true },
    note: f.note(''),
  },
  handler(a, { db, at }) {
    const hash = String(a.hash).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{7,79}$/.test(hash)) throw new Rejected('hash: 8–80 characters, letters, digits, . _ : -.');
    if (db.prepare('SELECT id FROM purch_receipt WHERE hash = ?').get(hash)) throw new Rejected(`This receipt is already on record (${db.prepare('SELECT id FROM purch_receipt WHERE hash = ?').get(hash).id}).`);
    if (!Number.isInteger(a.total) || a.total <= 0) throw new Rejected('total is a positive whole number of minor units.');
    const cur = String(a.currency).toUpperCase(); if (!H.CUR_RE.test(cur)) throw new Rejected('currency is a three-letter ISO 4217 code.');
    const id = H.nextId('R', 'purch_receipt');
    db.prepare('INSERT INTO purch_receipt (id,name,hash,vendor,date,total,currency,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, a.name, hash, a.vendor || null, a.date, a.total, cur, a.note || null, at, at);
    const r = V.receiptView(id);
    const candidates = V.receiptCandidates(r);
    return { ...r, candidates, note: candidates.length ? `${candidates.length} candidate row${candidates.length > 1 ? 's' : ''} — match with purch_match_receipt and a reason.` : 'No row on record matches this total within seven days; leave it unmatched or import the statement it belongs to.' };
  },
});

defineCommand({
  name: 'purch_match_receipt',
  permission: 'cash.write',
  title: 'Match receipt', group: 'Purchases', subject: 'purch_receipt',
  summary: 'Tie a receipt to one transaction, with a reason. Refused when the total does not fit.',
  doctrine: 'One receipt, one transaction (P-7). Refused when the receipt total is not the row\'s amount or the dates are more than seven days apart — unless you pass override with a reason that says why (a split payment, a tip added at the till).',
  effects: ['receipt matched to transaction'],
  guards: [ (r) => !r.transaction_id || `${r.id} is already matched to ${r.transaction_id}; unmatch it first, with a reason.` ],
  args: {
    receipt_id: { ...f.text('The receipt, e.g. R-0003.'), required: true },
    transaction_id: { ...f.text('The row it belongs to.'), required: true },
    reason: { ...f.text('Why this row — part of the record.'), required: true },
    override: f.bool('The total or date does not fit and the reason explains why.'),
  },
  handler(a, { db, at }) {
    const r = H.need('purch_receipt', a.receipt_id, 'receipt');
    const t = H.need('purch_transaction', a.transaction_id, 'transaction');
    if (r.transaction_id) throw new Rejected(`${r.id} is already matched to ${r.transaction_id}; unmatch it first, with a reason.`);
    const taken = db.prepare('SELECT id FROM purch_receipt WHERE transaction_id = ?').get(t.id);
    if (taken) throw new Rejected(`${t.id} already has receipt ${taken.id}; a row carries one receipt.`);
    if (t.amount >= 0) throw new Rejected(`${t.id} is money in; a receipt belongs to spending.`);
    if (r.currency !== t.currency) throw new Rejected(`${r.id} is in ${r.currency}, ${t.id} in ${t.currency}.`);
    const diff = Math.abs(-t.amount - r.total), days = Math.abs((Date.parse(r.date) - Date.parse(t.date)) / 864e5);
    if (!a.override && diff > 1) throw new Rejected(`The receipt total ${H.money(r.total, r.currency)} is not the row's ${H.money(-t.amount, t.currency)}. If it truly belongs (split payment, tip), pass override with the reason (P-7).`);
    if (!a.override && days > 7) throw new Rejected(`${r.id} is dated ${r.date}, ${t.id} ${t.date} — ${Math.round(days)} days apart. Pass override with the reason if it truly belongs (P-7).`);
    db.prepare('UPDATE purch_receipt SET transaction_id = ?, updated_at = ? WHERE id = ?').run(t.id, at, r.id);
    return V.receiptView(r.id);
  },
});

defineCommand({
  name: 'purch_unmatch_receipt',
  permission: 'cash.write',
  title: 'Unmatch receipt', group: 'Purchases', subject: 'purch_receipt',
  summary: 'Detach a receipt from its transaction, with a reason.',
  doctrine: 'A match was a reasoned act; undoing it is one too. The receipt goes back to unmatched, a visible state, and the reason stays on the record. Use it when the person says the receipt belongs to a different row or card — then match again.',
  effects: ['receipt unmatched'],
  guards: [ (r) => !!r.transaction_id || `${r.id} is not matched to anything.` ],
  args: { receipt_id: { ...f.text('The receipt.'), required: true }, reason: { ...f.text('Why.'), required: true } },
  handler(a, { db, at }) {
    const r = H.need('purch_receipt', a.receipt_id, 'receipt');
    if (!r.transaction_id) throw new Rejected(`${r.id} is not matched to anything.`);
    db.prepare('UPDATE purch_receipt SET transaction_id = NULL, updated_at = ? WHERE id = ?').run(at, r.id);
    return V.receiptView(r.id);
  },
});
