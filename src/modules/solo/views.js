'use strict';
/** solo read models — the invoice IS the document (o2c INV-22 family). */
const H = require('../../db.js');
const wsp = require('../../workspace.js');
const { db, money, need, get, today } = H;

const invoiceApplied = (id) => db().prepare(
  'SELECT COALESCE(SUM(amount),0) s FROM solo_payment_application WHERE invoice_id = ?').get(id).s;
const paymentUnapplied = (p) => p.amount - db().prepare(
  'SELECT COALESCE(SUM(amount),0) s FROM solo_payment_application WHERE payment_id = ?').get(p.id).s;

function invoiceView(id) {
  const { seller_json, customer_json, ...inv } = need('solo_invoice', id, 'invoice');
  const live = get('customer', inv.customer_id);
  // The bill-to block freezes at issue like the seller block (S-3); drafts show the live customer.
  const csnap = customer_json ? JSON.parse(customer_json) : null;
  const cust = csnap || { name: live.name, email: live.email, address: live.address, tax_id: live.tax_id };
  const applied = invoiceApplied(id);
  // Issued invoices show the frozen seller (S-3); drafts preview the live profile.
  const snap = seller_json ? JSON.parse(seller_json) : null;
  const seller = snap || db().prepare('SELECT name,address,tax_id,payment_instructions,footer_note,updated_at FROM company_profile WHERE id = 1').get() || null;
  return {
    ...inv,
    lines: db().prepare('SELECT * FROM solo_invoice_line WHERE invoice_id = ? ORDER BY pos').all(id),
    customer: cust, customer_as_issued: !!csnap, customer_name: cust.name, customer_email: cust.email,
    subtotal_display: money(inv.subtotal), tax_display: money(inv.tax_total), total_display: money(inv.total),
    applied, applied_display: money(applied),
    open: inv.total - applied, open_display: money(inv.total - applied),
    seller, seller_name: seller ? seller.name : null, seller_as_issued: !!snap,
    payment_instructions: seller ? seller.payment_instructions : null,
    doc_path: inv.doc_token ? `/doc/${wsp.currentName()}/${inv.doc_token}` : null,
    pdf_path: inv.doc_token && inv.status !== 'draft' ? `/doc/${wsp.currentName()}/${inv.doc_token}.pdf` : null,
  };
}

function outstanding() {
  const t = today();
  const rows = db().prepare(`
    SELECT i.id, i.customer_id, c.name AS customer_name, i.total, i.due_at, i.issued_at,
           i.total - COALESCE((SELECT SUM(amount) FROM solo_payment_application WHERE invoice_id = i.id), 0) AS open
    FROM solo_invoice i JOIN customer c ON c.id = i.customer_id
    WHERE i.status = 'issued' ORDER BY i.due_at`).all().filter(r => r.open > 0);
  const withDays = rows.map(r => ({
    ...r, open_display: money(r.open), total_display: money(r.total),
    days_overdue: r.due_at && r.due_at < t ? Math.floor((Date.parse(t) - Date.parse(r.due_at)) / 864e5) : 0,
  }));
  const totalOpen = withDays.reduce((s, r) => s + r.open, 0);
  return { as_of: t, invoices: withDays, count: withDays.length, total_open: totalOpen, total_open_display: money(totalOpen) };
}

function statement(customerId) {
  const c = need('customer', customerId, 'customer');
  const invs = db().prepare("SELECT id, status, total, issued_at, due_at FROM solo_invoice WHERE customer_id = ? AND status IN ('issued','paid') ORDER BY issued_at").all(customerId);
  const pays = db().prepare('SELECT id, amount, method, reference, received_at FROM solo_payment WHERE customer_id = ? ORDER BY received_at').all(customerId);
  const events = [
    ...invs.map(i => ({ at: i.issued_at, kind: 'invoice', ref: i.id, amount: i.total, amount_display: money(i.total) })),
    ...pays.map(p => ({ at: p.received_at, kind: 'payment', ref: p.id, amount: -p.amount, amount_display: '−' + money(p.amount), method: p.method, reference: p.reference })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));
  let bal = 0;
  for (const e of events) { bal += e.amount; e.balance = bal; e.balance_display = money(bal); }
  return { customer: c.name, customer_id: customerId, events, closing_balance: bal, closing_balance_display: money(bal) };
}

module.exports = { invoiceView, outstanding, statement, invoiceApplied, paymentUnapplied };
