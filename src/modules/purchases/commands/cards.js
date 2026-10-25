'use strict';
/**
 * Credit cards (purchases 0.8): what a card statement prints besides its rows (P-19), what is due
 * and whether it was met (P-20), interest and fees (P-22), and refunds tied to the purchase they
 * reverse (P-21).
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Cards read', ...def });
const isDate = (k, v) => { if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Rejected(`${k} is a date, YYYY-MM-DD.`); };

/** Shared with the import: the facts a card statement prints, checked and kept as printed. */
function saveCardFacts(db, src, a, { at, actor, reason }) {
  if (src.kind !== 'card') throw new Rejected(`${src.id} is a ${src.kind} statement; minimum payment, due date, limit and rate are a card statement's.`);
  isDate('payment_due_date', a.payment_due_date);
  if (a.payment_due_date && a.payment_due_date < src.period_end) throw new Rejected(`The payment is due ${a.payment_due_date}, before the statement closes (${src.period_end}). Re-read the statement.`);
  for (const k of ['minimum_due', 'credit_limit']) if (a[k] != null && (!Number.isInteger(a[k]) || a[k] < 0)) throw new Rejected(`${k} is whole cents, zero or more.`);
  if (a.apr_bp != null && (!Number.isInteger(a.apr_bp) || a.apr_bp < 0 || a.apr_bp > 10000)) throw new Rejected('apr_bp is a rate in basis points, 0 to 10000 (2499 = 24.99%).');
  const owed = src.closing_balance < 0 ? -src.closing_balance : 0;
  if (a.minimum_due != null && a.minimum_due > owed) throw new Rejected(`The minimum (${H.money(a.minimum_due, src.currency)}) is more than the statement balance (${H.money(owed, src.currency)}). Re-read the statement.`);
  const have = V.cardFacts(src.id);
  if (have && !String(reason || '').trim()) throw new Rejected(`${src.id} already has its card facts recorded. Changing them is a correction: say why (reason).`);
  if (have) {
    for (const k of ['minimum_due', 'credit_limit', 'apr_bp']) if (a[k] !== undefined) db.prepare(`UPDATE purch_card_statement SET ${k} = ? WHERE source_id = ?`).run(a[k], src.id);
    if (a.payment_due_date !== undefined) db.prepare('UPDATE purch_card_statement SET due_date = ? WHERE source_id = ?').run(a.payment_due_date, src.id);
    db.prepare('UPDATE purch_card_statement SET correction_reason = ?, updated_at = ? WHERE source_id = ?').run(String(reason).trim(), at, src.id);
  } else {
    db.prepare('INSERT INTO purch_card_statement (source_id,minimum_due,due_date,credit_limit,apr_bp,recorded_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(src.id, a.minimum_due ?? null, a.payment_due_date ?? null, a.credit_limit ?? null, a.apr_bp ?? null, actor || null, at, at);
  }
  return V.cardFacts(src.id);
}

defineCommand({
  name: 'purch_set_card_facts',
  permission: 'cash.write',
  title: 'Card statement facts', group: 'Cards', subject: 'purch_source',
  summary: 'Record what a card statement prints besides its rows: the minimum payment, the payment due date, the credit limit and the purchase rate. Kept as printed; changing them later needs a reason.',
  doctrine: `Pass them with the import when you have the statement (purch_import_statement takes the
same fields). Use this for a statement imported without them, or to correct a misread, with a reason.
Copy the figures as printed; never work a minimum out from the balance.`,
  effects: ['card statement facts recorded'],
  guards: [ (s) => s.kind === 'card' || `${s.id} is a ${s.kind} statement; minimum payment, due date, limit and rate are a card statement's.` ],
  args: {
    source_id:        { ...f.ref('purch_source', 'The card statement, e.g. SRC-0003.'), required: true },
    minimum_due:      f.money('Minimum payment due, as printed.'),
    payment_due_date: f.date('Payment due date, as printed.'),
    credit_limit:     f.money('Credit limit, as printed.'),
    apr_bp:           f.int('Purchase rate in basis points, as printed: 2499 means 24.99%.'),
    reason:           f.text('Only when correcting facts already recorded: why.'),
  },
  handler(a, { db, at, actor }) {
    const src = H.need('purch_source', a.source_id, 'statement');
    const facts = saveCardFacts(db, src, a, { at, actor, reason: a.reason });
    return { source_id: src.id, ...facts, note: `${src.id}: card facts recorded${a.reason ? ' (corrected)' : ''}.` };
  },
});

defineCommand({
  name: 'purch_link_refund',
  permission: 'cash.write',
  title: 'Link a refund', group: 'Cards', subject: 'purch_refund', scope: 'collection',
  summary: 'Tie money back to the purchase it reverses. It takes back that much of the purchase\'s spending, in its category; it is not income.',
  doctrine: `Read purch_refunds: money in that looks like money back from the same shop.
Show the person and link with a reason. A refund is never more than what is left of the purchase
after earlier refunds. Money back for something not on record stays income.`,
  effects: ['refund row tied to its purchase', 'the purchase\'s spending reduced by it'],
  args: {
    refund_transaction_id:   { ...f.ref('purch_transaction', 'The money-in row.'), required: true },
    purchase_transaction_id: { ...f.ref('purch_transaction', 'The purchase it reverses.'), required: true },
    reason:                  { ...f.text('Why they belong together: "returned the chair".'), required: true },
  },
  handler(a, { db, at, actor }) {
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Linking a refund needs a reason.');
    const r = V.rowWithAccount(a.refund_transaction_id), p = V.rowWithAccount(a.purchase_transaction_id);
    if (!r) throw new Rejected(`${a.refund_transaction_id} is not a statement row here.`);
    if (!p) throw new Rejected(`${a.purchase_transaction_id} is not a statement row here.`);
    if (!(r.amount > 0)) throw new Rejected(`${r.id} is money out; a refund is money in.`);
    if (!['purchase', 'recurring'].includes(p.status) || !(p.amount < 0)) throw new Rejected(`${p.id} (${p.description}) is ${p.status}; a refund reverses a purchase.`);
    if (r.currency !== p.currency) throw new Rejected(`${r.id} is in ${r.currency}, ${p.id} in ${p.currency}.`);
    if (r.date < p.date) throw new Rejected(`${r.id} (${r.date}) is before the purchase (${p.date}).`);
    if (V.activeRefunds().some(x => x.refund_tx === r.id)) throw new Rejected(`${r.id} is already linked as a refund.`);
    if (V.pairIndex().has(r.id)) throw new Rejected(`${r.id} is one side of a transfer between your accounts.`);
    if (V.matchedRows().has(r.id)) throw new Rejected(`${r.id} is matched to ${V.matchedRows().get(r.id)}; it is not a refund.`);
    if (!['unreviewed', 'income'].includes(r.status)) throw new Rejected(`${r.id} is reviewed as ${r.status}. If it really is money back for ${p.id}, review it as income or leave it unreviewed first.`);
    const left = -p.amount - V.refundedOf(p.id);
    if (r.amount > left) throw new Rejected(`${H.money(r.amount, r.currency)} is more than is left of ${p.id} (${H.money(-p.amount, p.currency)} paid, ${H.money(left, p.currency)} not yet refunded).`);
    const id = H.nextId('RFD', 'purch_refund');
    db.prepare('INSERT INTO purch_refund (id,refund_tx,purchase_tx,refund_was,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, r.id, p.id, JSON.stringify({ status: r.status, category: r.category, vendor_id: r.vendor_id, note: r.note, reviewed_at: r.reviewed_at }), why, actor || null, at);
    db.prepare("UPDATE purch_transaction SET status = 'refund', category = ?, vendor_id = COALESCE(?, vendor_id), note = ?, reviewed_at = ? WHERE id = ?").run(p.category, p.vendor_id, `Refund of ${p.id} (${id})`, at, r.id);
    return { ...V.refundView(id), note: `Linked ${r.id} (${H.money(r.amount, r.currency)}) as a refund of ${p.id} (${p.description}, ${H.money(-p.amount, p.currency)}), as ${id}. It takes back that much of ${p.category || 'its'} spending.` };
  },
});

defineCommand({
  name: 'purch_unlink_refund',
  permission: 'cash.write',
  title: 'Unlink refund', group: 'Cards', subject: 'purch_refund',
  summary: 'Undo a refund link, with a reason. The money-in row goes back to how it was reviewed before.',
  doctrine: 'For a link that was wrong: the money in goes back to how it was reviewed, and the purchase counts in full again. Say so to the person.',
  effects: ['refund unlinked; the row back to its earlier review'],
  guards: [ (r) => !r.unlinked_at || `${r.id} was already unlinked.` ],
  args: { refund_id: { ...f.ref('purch_refund', 'e.g. RFD-0001.'), required: true }, reason: { ...f.text('Why it was wrong.'), required: true } },
  handler(a, { db, at }) {
    const r = H.need('purch_refund', a.refund_id, 'refund');
    if (r.unlinked_at) throw new Rejected(`${r.id} was already unlinked.`);
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Unlinking needs a reason.');
    const was = JSON.parse(r.refund_was || '{}');
    db.prepare('UPDATE purch_transaction SET status = ?, category = ?, vendor_id = ?, note = ?, reviewed_at = ? WHERE id = ?').run(was.status || 'unreviewed', was.category ?? null, was.vendor_id ?? null, was.note ?? null, was.reviewed_at ?? null, r.refund_tx);
    db.prepare('UPDATE purch_refund SET unlinked_at = ?, unlink_reason = ? WHERE id = ?').run(at, why, r.id);
    return { ...V.refundView(r.id), note: `${r.id} unlinked: ${r.refund_tx} is back to how it was reviewed before.` };
  },
});

read({ name: 'purch_card_dues', title: 'Card payments due', summary: 'Each card: its latest statement balance, minimum and due date, the payments seen toward it, and whether it is paid in full, minimum paid, due, or missed.',
  args: { as_of: f.date('The day. Defaults to today.') }, handler: (a) => V.cardDues(a) });
read({ name: 'purch_card_costs', title: 'Interest and fees', summary: 'Interest and fees per card for a year, from the rows reviewed as fees.',
  args: { year: f.text('e.g. 2026. Defaults to this year.') }, handler: (a) => V.cardCosts(a) });
read({ name: 'purch_refunds', title: 'Refunds', summary: 'Money back linked to the purchase it reverses, and money in that looks like money back from the same shop (suggested, with why). With refund_id: that link whole.',
  args: { refund_id: f.text('One link, e.g. RFD-0001.') }, handler: (a) => a.refund_id ? V.refundView(a.refund_id) : V.refunds() });

module.exports = { saveCardFacts };
