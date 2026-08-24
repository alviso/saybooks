'use strict';
/**
 * o2c read models. Reads are deliberately generous — an agent that can see the whole order
 * in one call does not invent the parts it cannot see. Joins into core-owned tables are
 * reads and therefore fine; the ownership rule is about writes.
 */
const H = require('../../db.js');
const { db, money, need, get, today } = H;

/** Open AR for a customer: issued, not void, less what has been applied to it. */
function openBalance(customerId) {
  return db().prepare(`
    SELECT COALESCE(SUM(i.total - COALESCE(a.applied, 0) - COALESCE(ca.applied, 0)), 0) AS bal FROM invoice i
    LEFT JOIN (SELECT invoice_id, SUM(amount) applied FROM payment_application GROUP BY invoice_id) a ON a.invoice_id = i.id
    LEFT JOIN (SELECT invoice_id, SUM(amount) applied FROM credit_application GROUP BY invoice_id) ca ON ca.invoice_id = i.id
    WHERE i.customer_id = ? AND i.status <> 'void'`).get(customerId).bal;
}

/** Value of what is confirmed but not yet invoiced — real exposure, and most naive
 *  credit checks miss it. A credit limit that only counts invoices lets a customer
 *  order forever as long as you are slow to bill. */
function committedValue(customerId) {
  return db().prepare(`
    SELECT COALESCE(SUM((ol.qty - ol.qty_invoiced) * ol.unit_price), 0) AS v
    FROM order_line ol JOIN "order" o ON o.id = ol.order_id
    WHERE o.customer_id = ? AND o.status IN ('confirmed','shipped')`).get(customerId).v;
}

/** Everything settled against an invoice: cash applications plus credit applications. */
const invoiceApplied = (invoiceId) =>
  db().prepare('SELECT COALESCE(SUM(amount),0) AS a FROM payment_application WHERE invoice_id = ?').get(invoiceId).a +
  db().prepare('SELECT COALESCE(SUM(amount),0) AS a FROM credit_application WHERE invoice_id = ?').get(invoiceId).a;
const paymentApplied = (paymentId) =>
  db().prepare('SELECT COALESCE(SUM(amount),0) AS a FROM payment_application WHERE payment_id = ?').get(paymentId).a;
const refunded = (type, id) =>
  db().prepare('SELECT COALESCE(SUM(amount),0) AS a FROM refund WHERE source_type = ? AND source_id = ?').get(type, id).a;
/** What a payment still has to give: amount less applications less refunds. */
const paymentUnapplied = (p) => p.amount - paymentApplied(p.id) - refunded('payment', p.id);
const creditApplied = (creditNoteId) =>
  db().prepare('SELECT COALESCE(SUM(amount),0) AS a FROM credit_application WHERE credit_note_id = ?').get(creditNoteId).a;
const creditUnapplied = (cn) => cn.total - creditApplied(cn.id) - refunded('credit_note', cn.id);
/** Fulfilled units already sent back on a line, so returns can never exceed fulfilment. */
const returnedQty = (orderLineId) =>
  db().prepare('SELECT COALESCE(SUM(rl.qty),0) AS q FROM return_line rl WHERE rl.order_line_id = ?').get(orderLineId).q;

function creditNoteView(id) {
  const cn = need('credit_note', id, 'credit note');
  const applied = creditApplied(id), ref = refunded('credit_note', id);
  return { ...cn, total_display: money(cn.total), applied, applied_display: money(applied),
    refunded: ref, open: cn.total - applied - ref, open_display: money(cn.total - applied - ref),
    applications: db().prepare('SELECT * FROM credit_application WHERE credit_note_id = ?').all(id) };
}

function orderView(id) {
  const o = need('order', id, 'order');
  const customer = get('customer', o.customer_id);
  const lines = db().prepare(`SELECT ol.*, i.name AS item_name FROM order_line ol JOIN item i ON i.id = ol.item_id WHERE ol.order_id = ? ORDER BY ol.id`).all(id);
  const deliveries = db().prepare('SELECT * FROM delivery WHERE order_id = ? ORDER BY id').all(id);
  const invoices = db().prepare('SELECT * FROM invoice WHERE order_id = ? ORDER BY id').all(id);
  const total = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  return {
    ...o, customer_name: customer.name, lines, deliveries, invoices,
    total, total_display: money(total),
    open_qty: lines.reduce((s, l) => s + (l.qty - l.qty_shipped), 0),
    uninvoiced_qty: lines.reduce((s, l) => s + (l.qty_shipped - l.qty_invoiced), 0),
  };
}

function customerView(id) {
  const c = need('customer', id, 'customer');
  const open = openBalance(id), committed = committedValue(id);
  return {
    ...c, credit_limit_display: money(c.credit_limit),
    open_balance: open, open_balance_display: money(open),
    committed, committed_display: money(committed),
    credit_available: c.credit_limit - open - committed,
    credit_available_display: money(c.credit_limit - open - committed),
    orders: db().prepare('SELECT * FROM "order" WHERE customer_id = ? ORDER BY id DESC').all(id),
  };
}

function quoteView(id) {
  const q = need('quote', id, 'quote');
  const lines = db().prepare('SELECT ql.*, i.name AS item_name FROM quote_line ql JOIN item i ON i.id = ql.item_id WHERE quote_id = ?').all(id);
  const total = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  return { ...q, lines, total, total_display: money(total) };
}

function invoiceView(id) {
  const { seller_json, ...inv } = need('invoice', id, 'invoice');
  const applied = invoiceApplied(id);
  // The invoice read IS the document (INV-22). The seller block is the SNAPSHOT taken at
  // issuance; only invoices issued before a profile existed fall back to the live one.
  const snap = seller_json ? JSON.parse(seller_json) : null;
  const seller = snap || db().prepare('SELECT name,address,tax_id,payment_instructions,footer_note,updated_at FROM company_profile WHERE id = 1').get() || null;
  const cust = get('customer', inv.customer_id);
  const order = db().prepare('SELECT po_ref FROM "order" WHERE id = ?').get(inv.order_id);
  return {
    ...inv,
    seller_as_issued: !!snap,
    lines: db().prepare('SELECT il.*, i.name AS item_name FROM invoice_line il JOIN item i ON i.id = il.item_id WHERE invoice_id = ?').all(id),
    total_display: money(inv.total), applied, applied_display: money(applied),
    open: inv.total - applied, open_display: money(inv.total - applied),
    customer_name: cust.name, customer_email: cust.email, terms: cust.terms,
    po_ref: order ? order.po_ref : null,
    seller, seller_name: seller ? seller.name : null,
    payment_instructions: seller ? seller.payment_instructions : null,
  };
}

/** Standard AR aging. The report every controller opens first, so it is a first-class
 *  read rather than something the agent is expected to assemble from rows. */
function arAging(asOf = today()) {
  const rows = db().prepare(`
    SELECT i.id, i.customer_id, c.name AS customer_name, i.total, i.due_at, i.status,
           i.total - COALESCE(a.applied,0) - COALESCE(ca.applied,0) AS open
    FROM invoice i JOIN customer c ON c.id = i.customer_id
    LEFT JOIN (SELECT invoice_id, SUM(amount) applied FROM payment_application GROUP BY invoice_id) a ON a.invoice_id = i.id
    LEFT JOIN (SELECT invoice_id, SUM(amount) applied FROM credit_application GROUP BY invoice_id) ca ON ca.invoice_id = i.id
    WHERE i.status = 'open' AND i.total - COALESCE(a.applied,0) - COALESCE(ca.applied,0) > 0 ORDER BY i.due_at`).all();
  const bucketOf = (d) => {
    const days = Math.floor((Date.parse(asOf) - Date.parse(d)) / 864e5);
    return days <= 0 ? 'current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
  };
  const buckets = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const detail = rows.map(r => {
    const bucket = bucketOf(r.due_at);
    buckets[bucket] += r.open;
    return { ...r, bucket, open_display: money(r.open), days_overdue: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(r.due_at)) / 864e5)) };
  });
  return { as_of: asOf, buckets, buckets_display: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, money(v)])), total: money(Object.values(buckets).reduce((a, b) => a + b, 0)), detail };
}

/** Unapplied cash — payments and credit notes with remaining balances (spec §6). The most
 *  common way a books-look-wrong question starts, so it is deliberately one view. */
function unappliedCash() {
  const pays = db().prepare(`
    SELECT p.*, 'payment' AS instrument, p.amount - COALESCE(a.applied,0) - COALESCE(r.refunded,0) AS unapplied, c.name AS customer_name
    FROM payment p JOIN customer c ON c.id = p.customer_id
    LEFT JOIN (SELECT payment_id, SUM(amount) applied FROM payment_application GROUP BY payment_id) a ON a.payment_id = p.id
    LEFT JOIN (SELECT source_id, SUM(amount) refunded FROM refund WHERE source_type='payment' GROUP BY source_id) r ON r.source_id = p.id
    WHERE p.amount - COALESCE(a.applied,0) - COALESCE(r.refunded,0) > 0 ORDER BY p.received_at`).all();
  const credits = db().prepare(`
    SELECT cn.*, 'credit_note' AS instrument, cn.total - COALESCE(a.applied,0) - COALESCE(r.refunded,0) AS unapplied, c.name AS customer_name
    FROM credit_note cn JOIN customer c ON c.id = cn.customer_id
    LEFT JOIN (SELECT credit_note_id, SUM(amount) applied FROM credit_application GROUP BY credit_note_id) a ON a.credit_note_id = cn.id
    LEFT JOIN (SELECT source_id, SUM(amount) refunded FROM refund WHERE source_type='credit_note' GROUP BY source_id) r ON r.source_id = cn.id
    WHERE cn.total - COALESCE(a.applied,0) - COALESCE(r.refunded,0) > 0 ORDER BY cn.created_at`).all();
  return [...pays, ...credits];
}

/** Backorders — every open confirmed quantity: the "what do we owe whom" view (spec §6). */
const backorders = () => db().prepare(`
  SELECT o.id AS order_id, o.customer_id, c.name AS customer_name, ol.id AS order_line_id,
         ol.item_id, i.name AS item_name, ol.qty - ol.qty_shipped AS open_qty, ol.unit_price,
         i.on_hand, o.created_at
  FROM order_line ol
  JOIN "order" o ON o.id = ol.order_id JOIN customer c ON c.id = o.customer_id JOIN item i ON i.id = ol.item_id
  WHERE o.status IN ('confirmed') AND ol.qty - ol.qty_shipped > 0
  ORDER BY o.created_at, o.id`).all();

/** Customer statement, balance-forward style (spec §6): opening balance, the period's
 *  invoices, credits and payments in order, closing balance. Rendering is someone else's job. */
function customerStatement(customerId, from, to) {
  const c = need('customer', customerId, 'customer');
  const rows = [
    ...db().prepare(`SELECT id, issued_at AS at, 'invoice' AS kind, total AS amount FROM invoice WHERE customer_id = ? AND status <> 'void'`).all(customerId),
    ...db().prepare(`SELECT id, substr(created_at,1,10) AS at, 'credit_note' AS kind, -total AS amount FROM credit_note WHERE customer_id = ?`).all(customerId),
    ...db().prepare(`SELECT id, received_at AS at, 'payment' AS kind, -amount AS amount FROM payment WHERE customer_id = ?`).all(customerId),
    ...db().prepare(`SELECT r.id, substr(r.recorded_at,1,10) AS at, 'refund' AS kind, r.amount FROM refund r
                     JOIN payment p ON r.source_type='payment' AND p.id = r.source_id WHERE p.customer_id = ?`).all(customerId),
    ...db().prepare(`SELECT r.id, substr(r.recorded_at,1,10) AS at, 'refund' AS kind, r.amount FROM refund r
                     JOIN credit_note cn ON r.source_type='credit_note' AND cn.id = r.source_id WHERE cn.customer_id = ?`).all(customerId),
  ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const opening = rows.filter(r => r.at < from).reduce((s2, r) => s2 + r.amount, 0);
  const period = rows.filter(r => r.at >= from && r.at <= to);
  let bal = opening;
  const lines = period.map(r => ({ ...r, amount_display: money(r.amount), balance: (bal += r.amount), balance_display: money(bal) }));
  return { customer_id: customerId, customer_name: c.name, from, to,
    opening, opening_display: money(opening), lines, closing: bal, closing_display: money(bal) };
}

module.exports = { openBalance, committedValue, invoiceApplied, paymentApplied, paymentUnapplied,
  creditApplied, creditUnapplied, creditNoteView, refunded, returnedQty,
  orderView, customerView, quoteView, invoiceView, arAging, unappliedCash, backorders, customerStatement };
