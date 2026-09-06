'use strict';
/** solo read models — the invoice IS the document (o2c INV-22 family). */
const H = require('../../db.js');
const wsp = require('../../workspace.js');
const CFG = require('../../config.js');
const { db, money, need, get, today } = H;

const invoiceApplied = (id) => db().prepare(
  'SELECT COALESCE(SUM(amount),0) s FROM solo_payment_application WHERE invoice_id = ?').get(id).s;
const paymentUnapplied = (p) => p.amount - db().prepare(
  'SELECT COALESCE(SUM(amount),0) s FROM solo_payment_application WHERE payment_id = ?').get(p.id).s;

function invoiceView(id) {
  const { seller_json, customer_json, ...inv } = need('solo_invoice', id, 'invoice');
  const live = get('customer', inv.customer_id);
  const loc = H.locale();
  const cur = inv.currency || 'USD';
  const m = (c) => money(c, cur, loc.locale);
  // The bill-to block freezes at issue like the seller block (S-3); drafts show the live customer.
  const csnap = customer_json ? JSON.parse(customer_json) : null;
  const cust = csnap || { name: live.name, email: live.email, address: live.address, tax_id: live.tax_id };
  const applied = invoiceApplied(id);
  // Issued invoices show the frozen seller (S-3); drafts preview the live profile.
  const snap = seller_json ? JSON.parse(seller_json) : null;
  const seller = snap || db().prepare('SELECT name,address,tax_id,payment_instructions,footer_note,updated_at,country,tax_label,tax_registered,tax_id_label FROM company_profile WHERE id = 1').get() || null;
  if (seller) seller.tax_registered = !!seller.tax_registered;
  const taxRegistered = seller ? !!seller.tax_registered : loc.tax_registered;
  const lines = db().prepare('SELECT * FROM solo_invoice_line WHERE invoice_id = ? ORDER BY pos').all(id)
    .map(l => ({ ...l, rate_display: m(l.rate), amount_display: m(l.amount), tax_display: l.tax_rate_bp ? (l.tax_rate_bp / 100).toFixed(2).replace(/\.?0+$/, '') + '%' : '—' }));
  const rates = [...new Set(lines.filter(l => l.tax_rate_bp > 0).map(l => l.tax_rate_bp))];
  const open = inv.status === 'void' ? 0 : inv.total - applied;
  return {
    ...inv, currency: cur, locale: loc.locale,
    // Show the currency code on the document unless this is plain USD in a US (or unset) space with no other currency.
    show_currency: !(cur === 'USD' && (!loc.country || loc.country === 'US') && loc.currencies.length === 1),
    lines,
    customer: cust, customer_as_issued: !!csnap, customer_name: cust.name, customer_email: cust.email,
    subtotal_display: m(inv.subtotal), tax_display: m(inv.tax_total), total_display: m(inv.total),
    applied, applied_display: m(applied),
    // Nothing on a void invoice is collectible: open is 0 here so no reader has to remember the status.
    open, open_display: m(open),
    tax_label: (seller && seller.tax_label) || loc.tax_label || 'Tax', tax_registered: taxRegistered,
    tax_rate_display: rates.length === 1 ? (rates[0] / 100).toFixed(2).replace(/\.?0+$/, '') + '%' : null,
    tax_invoice: taxRegistered && inv.tax_total > 0,
    tax_id_label: (seller && seller.tax_id_label) || loc.tax_id_label || 'Tax ID',
    issued_display: H.fmtDate(inv.issued_at, loc.locale), due_display: H.fmtDate(inv.due_at, loc.locale),
    seller, seller_name: seller ? seller.name : null, seller_as_issued: !!snap,
    payment_instructions: seller ? seller.payment_instructions : null,
    doc_path: inv.doc_token ? `/doc/${wsp.currentName()}/${inv.doc_token}` : null,
    pdf_path: inv.doc_token && inv.status !== 'draft' ? `/doc/${wsp.currentName()}/${inv.doc_token}.pdf` : null,
    // Absolute forms: what you hand to a person. Both are unauthenticated capability links.
    doc_url: CFG.absolute(inv.doc_token ? `/doc/${wsp.currentName()}/${inv.doc_token}` : null),
    pdf_url: CFG.absolute(inv.doc_token && inv.status !== 'draft' ? `/doc/${wsp.currentName()}/${inv.doc_token}.pdf` : null),
  };
}

/** Sums that respect currency: one total when everything is in one currency, otherwise one per currency and no grand total. */
function sumByCurrency(rows, field) {
  const by = {};
  for (const r of rows) { const c = r.currency || 'USD'; by[c] = by[c] || { currency: c, count: 0, amount: 0 }; by[c].count++; by[c].amount += r[field]; }
  for (const c of Object.keys(by)) by[c].amount_display = money(by[c].amount, c);
  const codes = Object.keys(by);
  return { by, total: codes.length === 1 ? by[codes[0]].amount : null,
           total_display: codes.length ? codes.map(c => by[c].amount_display).join(' · ') : money(0) };
}

function outstanding() {
  const t = today();
  const rows = db().prepare(`
    SELECT i.id, i.customer_id, c.name AS customer_name, i.total, i.currency, i.due_at, i.issued_at,
           i.total - COALESCE((SELECT SUM(amount) FROM solo_payment_application WHERE invoice_id = i.id), 0) AS open
    FROM solo_invoice i JOIN customer c ON c.id = i.customer_id
    WHERE i.status = 'issued' ORDER BY i.due_at`).all().filter(r => r.open > 0);
  const withDays = rows.map(r => ({
    ...r, open_display: money(r.open, r.currency), total_display: money(r.total, r.currency),
    days_overdue: r.due_at && r.due_at < t ? Math.floor((Date.parse(t) - Date.parse(r.due_at)) / 864e5) : 0,
  }));
  const sums = sumByCurrency(withDays, 'open');
  return { as_of: t, invoices: withDays, count: withDays.length, total_open: sums.total, total_open_display: sums.total_display, by_currency: sums.by };
}

function statement(customerId) {
  const c = need('customer', customerId, 'customer');
  const invs = db().prepare("SELECT id, status, total, currency, issued_at, due_at FROM solo_invoice WHERE customer_id = ? AND status IN ('issued','paid') ORDER BY issued_at").all(customerId);
  const pays = db().prepare('SELECT id, amount, currency, method, reference, received_at FROM solo_payment WHERE customer_id = ? ORDER BY received_at').all(customerId);
  const events = [
    ...invs.map(i => ({ at: i.issued_at, kind: 'invoice', ref: i.id, currency: i.currency || 'USD', amount: i.total, amount_display: money(i.total, i.currency) })),
    ...pays.map(p => ({ at: p.received_at, kind: 'payment', ref: p.id, currency: p.currency || 'USD', amount: -p.amount, amount_display: '−' + money(p.amount, p.currency), method: p.method, reference: p.reference })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));
  // One running balance per currency: a CZK invoice and a USD payment never net against each other.
  const bal = {};
  for (const e of events) { bal[e.currency] = (bal[e.currency] || 0) + e.amount; e.balance = bal[e.currency]; e.balance_display = money(e.balance, e.currency); }
  const codes = Object.keys(bal);
  const closing = Object.fromEntries(codes.map(k => [k, { amount: bal[k], amount_display: money(bal[k], k) }]));
  return { customer: c.name, customer_id: customerId, events,
           closing_balance: codes.length === 1 ? bal[codes[0]] : null,
           closing_balance_display: codes.length ? codes.map(k => money(bal[k], k)).join(' · ') : money(0),
           closing_balance_by_currency: closing };
}

module.exports = { invoiceView, outstanding, statement, invoiceApplied, paymentUnapplied };
