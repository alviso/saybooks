'use strict';
/**
 * Read models for procure to pay: orders with what has arrived and been billed against each
 * line, goods received, what is received and not yet billed (GRNI), the 3-way match for one
 * bill, and this area's postings. Bills are the purchases area's; they are read here, never
 * written (its api writes them).
 */
const H = require('../../db.js');
const db = () => H.db();
const money = (c, cur) => H.money(c, cur || 'USD');
const APPROVED = ['approved', 'paid'];

const vendorName = (id) => { try { return (db().prepare('SELECT name FROM purch_vendor WHERE id = ?').get(id) || {}).name || null; } catch { return null; } };
const billRow = (id) => { try { return db().prepare('SELECT * FROM purch_bill WHERE id = ?').get(id) || null; } catch { return null; } };

/** The match tolerance: how far a bill may stray before approval is refused. 0 by default. */
function tolerance() {
  const rows = db().prepare("SELECT * FROM p2p_setting WHERE key IN ('price_pct','qty_pct')").all();
  const get = (k) => rows.find(r => r.key === k);
  const last = rows.slice().sort((a, b) => String(b.set_at || '').localeCompare(String(a.set_at || '')))[0];
  return { price_pct: Number((get('price_pct') || {}).value || 0), qty_pct: Number((get('qty_pct') || {}).value || 0),
    set_by: last ? last.set_by : null, set_at: last ? last.set_at : null, reason: last ? last.reason : null };
}
const pct = (n) => `${Number(n.toFixed(1))}%`;

/** Each line of an order with what arrived, what is billed (approved or waiting) and what is open. */
function poLines(poId) {
  const lines = db().prepare(`SELECT l.*, i.name AS item_name FROM p2p_po_line l LEFT JOIN item i ON i.id = l.item_id WHERE l.po_id = ? ORDER BY l.pos`).all(poId);
  const po = db().prepare('SELECT currency FROM p2p_po WHERE id = ?').get(poId) || {};
  return lines.map(l => {
    const received = db().prepare('SELECT COALESCE(SUM(qty), 0) n FROM p2p_receipt_line WHERE po_line_id = ?').get(l.id).n;
    const billed = db().prepare(`SELECT bl.qty, b.status FROM p2p_bill_line bl JOIN purch_bill b ON b.id = bl.bill_id WHERE bl.po_line_id = ? AND b.status <> 'rejected'`).all(l.id);
    const billed_approved = billed.filter(b => APPROVED.includes(b.status)).reduce((n, b) => n + b.qty, 0);
    const billed_waiting = billed.filter(b => b.status === 'open').reduce((n, b) => n + b.qty, 0);
    return { ...l, stocked: !!l.stocked, item_name: l.item_name || l.item_id, value: l.qty * l.unit_price, value_display: money(l.qty * l.unit_price, po.currency),
      unit_price_display: money(l.unit_price, po.currency), received, open_to_receive: l.stocked ? Math.max(0, l.qty - received) : 0,
      billed_approved, billed_waiting, not_billed: l.stocked ? Math.max(0, received - billed_approved) : 0 };
  });
}

function stateOf(po, lines) {
  if (po.status !== 'issued') return po.status;
  return lines.some(l => l.received > 0) ? 'partly received' : 'issued';
}

function poView(id) {
  const po = H.need('p2p_po', id, 'purchase order');
  const lines = poLines(id);
  const total = lines.reduce((n, l) => n + l.value, 0);
  const receipts = db().prepare('SELECT id, received_at, reference FROM p2p_receipt WHERE po_id = ? ORDER BY received_at, id').all(id);
  const bills = db().prepare(`SELECT DISTINCT b.id, b.number, b.status, b.amount, b.bill_date FROM p2p_bill_line bl JOIN purch_bill b ON b.id = bl.bill_id WHERE bl.po_id = ? ORDER BY b.id`).all(id)
    .map(b => ({ ...b, amount_display: money(b.amount, po.currency), match: matchOf(b.id) }));
  const vendor = vendorName(po.vendor_id);
  return { ...po, name: `${vendor || 'Purchase order'}`, vendor, state: stateOf(po, lines), lines, line_count: lines.length,
    total, total_display: money(total, po.currency),
    to_receive: lines.reduce((n, l) => n + l.open_to_receive, 0),
    received_value: lines.reduce((n, l) => n + l.received * l.unit_price, 0),
    received_value_display: money(lines.reduce((n, l) => n + l.received * l.unit_price, 0), po.currency),
    receipts, bills };
}

function pos({ state } = {}) {
  const rows = db().prepare(`SELECT id FROM p2p_po ORDER BY CASE status WHEN 'draft' THEN 0 WHEN 'issued' THEN 1 WHEN 'received' THEN 2 ELSE 3 END, id DESC`).all();
  let items = rows.map(r => poView(r.id)).map(({ receipts, bills, ...p }) => ({ ...p, receipt_count: receipts.length, bill_count: bills.length }));
  if (state) items = items.filter(p => p.status === state || p.state === state);
  const open = items.filter(p => ['draft', 'issued'].includes(p.status));
  return { count: items.length, open: open.length, to_receive: open.reduce((n, p) => n + p.to_receive, 0), items };
}

function receiptView(id) {
  const r = H.need('p2p_receipt', id, 'goods receipt');
  const po = db().prepare('SELECT * FROM p2p_po WHERE id = ?').get(r.po_id);
  const lines = db().prepare(`SELECT rl.*, i.name AS item_name FROM p2p_receipt_line rl LEFT JOIN item i ON i.id = rl.item_id WHERE rl.receipt_id = ?`).all(id)
    .map(l => ({ ...l, item_name: l.item_name || l.item_id, value: l.qty * l.unit_cost, value_display: money(l.qty * l.unit_cost, po.currency) }));
  const value = lines.reduce((n, l) => n + l.value, 0);
  return { ...r, vendor: vendorName(po.vendor_id), currency: po.currency, lines, value, value_display: money(value, po.currency) };
}

function goodsReceived({ po_id } = {}) {
  const rows = db().prepare(`SELECT id FROM p2p_receipt ${po_id ? 'WHERE po_id = ?' : ''} ORDER BY received_at DESC, id DESC`).all(...(po_id ? [po_id] : []));
  const items = rows.map(r => receiptView(r.id));
  return { count: items.length, items };
}

/** Goods received and not yet on an approved bill (P2P-14): a real liability, line by line. */
function unbilled() {
  const items = [];
  for (const po of db().prepare("SELECT * FROM p2p_po WHERE status <> 'cancelled' ORDER BY id").all()) {
    for (const l of poLines(po.id)) {
      if (!l.stocked || l.not_billed <= 0) continue;
      const value = l.not_billed * l.unit_price;
      items.push({ po_id: po.id, vendor: vendorName(po.vendor_id), currency: po.currency, item_id: l.item_id, item_name: l.item_name,
        received: l.received, billed: l.billed_approved, waiting_on_open_bills: l.billed_waiting, not_billed: l.not_billed,
        unit_price_display: l.unit_price_display, value, value_display: money(value, po.currency) });
    }
  }
  const by = {};
  for (const i of items) { by[i.currency] = by[i.currency] || { currency: i.currency, value: 0 }; by[i.currency].value += i.value; }
  for (const c of Object.values(by)) c.value_display = money(c.value, c.currency);
  return { count: items.length, by_currency: by, items };
}

/**
 * The 3-way match for one bill (P2P-3): each line against what was received (stocked) or
 * ordered (services), and against the order's price, with the tolerance that applies now.
 * Bills already approved on the same line count against what was received.
 */
function matchOf(billId) {
  const lines = db().prepare(`SELECT bl.*, pl.qty AS ordered, pl.unit_price AS po_price, pl.stocked, i.name AS item_name
    FROM p2p_bill_line bl JOIN p2p_po_line pl ON pl.id = bl.po_line_id LEFT JOIN item i ON i.id = bl.item_id WHERE bl.bill_id = ? ORDER BY pl.pos`).all(billId);
  if (!lines.length) return null;
  const tol = tolerance();
  const po = db().prepare('SELECT * FROM p2p_po WHERE id = ?').get(lines[0].po_id);
  const cur = po.currency;
  const problems = [];
  const out = lines.map(l => {
    const received = db().prepare('SELECT COALESCE(SUM(qty), 0) n FROM p2p_receipt_line WHERE po_line_id = ?').get(l.po_line_id).n;
    const before = db().prepare(`SELECT COALESCE(SUM(bl.qty), 0) n FROM p2p_bill_line bl JOIN purch_bill b ON b.id = bl.bill_id
      WHERE bl.po_line_id = ? AND bl.bill_id <> ? AND b.status IN ('approved','paid')`).get(l.po_line_id, billId).n;
    const basis = l.stocked ? received : l.ordered;
    const allowed_qty = Math.floor(basis * (100 + tol.qty_pct) / 100);
    const qty_ok = before + l.qty <= allowed_qty;
    const allowed_price = Math.floor(l.po_price * (100 + tol.price_pct) / 100);
    const price_ok = l.unit_price <= allowed_price;
    const over = l.po_price ? (l.unit_price - l.po_price) / l.po_price * 100 : 0;
    const name = `${l.item_id}${l.item_name && l.item_name !== l.item_id ? ` (${l.item_name})` : ''}`;
    if (!price_ok) problems.push(`${name} is billed at ${money(l.unit_price, cur)}, the order says ${money(l.po_price, cur)} (${pct(over)} over)`);
    if (!qty_ok) problems.push(l.stocked
      ? `${name}: ${l.qty} billed${before ? ` on top of ${before} already billed` : ''}, ${received} received`
      : `${name}: ${l.qty} billed${before ? ` on top of ${before} already billed` : ''}, ${l.ordered} ordered`);
    return { item_id: l.item_id, item_name: l.item_name || l.item_id, stocked: !!l.stocked, billed_qty: l.qty, billed_before: before,
      against: l.stocked ? 'received' : 'ordered', against_qty: basis, ordered: l.ordered, received: l.stocked ? received : null,
      billed_price: l.unit_price, order_price: l.po_price, billed_price_display: money(l.unit_price, cur), order_price_display: money(l.po_price, cur),
      price_difference: l.unit_price - l.po_price, price_difference_pct: Number(over.toFixed(1)), qty_ok, price_ok };
  });
  const ok = problems.length === 0;
  const tolText = `Tolerance: price ${tol.price_pct}%, quantity ${tol.qty_pct}%.`;
  return { bill_id: billId, po_id: po.id, ok, lines: out, tolerance: tol, problems,
    summary: ok ? `${billId} matches ${po.id}. ${tolText}` : `${billId} does not match ${po.id}: ${problems.join('; ')}. ${tolText}` };
}

function billMatch(billId) {
  const b = billRow(billId);
  if (!b) throw new (require('../../registry.js').Rejected)(`Bill ${billId} does not exist.`);
  const m = matchOf(billId);
  if (!m) return { bill_id: billId, on_order: false, note: `${billId} is not recorded against a purchase order, so there is nothing to match; it is approved as any other bill.` };
  return { on_order: true, bill_status: b.status, amount_display: money(b.amount, b.currency), ...m };
}

/** Purchases asks before a person approves a bill (purchases' approval hook): a sentence, or null. */
function billApprovalHold(billId) {
  const m = matchOf(billId);
  if (!m || m.ok) return null;
  return `${m.summary} Settle it with the vendor and record the corrected bill, or a person loosens the tolerance with a reason.`;
}
/** A bill on an order is on the accrual basis: it posts to Accounts Payable when approved. */
const billOnAccrual = (billId) => { try { return !!db().prepare('SELECT 1 FROM p2p_bill_line WHERE bill_id = ? LIMIT 1').get(billId); } catch { return false; } };

const DERIVATION_ACCOUNTS = [
  { account: 'Inventory', kind: 'asset', when: 'goods are received against a purchase order, at the order\'s price' },
  { account: 'Goods Received Not Invoiced', kind: 'liability', when: 'goods are received; cleared when their bill is approved' },
  { account: 'Accounts Payable', kind: 'liability', when: 'a bill on a purchase order is approved; cleared when it is paid' },
  { account: 'Purchase Price Variance', kind: 'expense', when: 'a bill\'s price differs from the order\'s' },
];

/** P2P-13: receipts, approved bills on orders, and payments of those made outside a statement. */
function journalLines({ from, to } = {}) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const out = [];
  let receipts = [];
  try { receipts = db().prepare('SELECT r.*, p.vendor_id, p.currency FROM p2p_receipt r JOIN p2p_po p ON p.id = r.po_id ORDER BY r.received_at, r.id').all(); } catch { return []; }
  for (const r of receipts) {
    if (!inRange(r.received_at)) continue;
    const value = db().prepare('SELECT COALESCE(SUM(qty * unit_cost), 0) v FROM p2p_receipt_line WHERE receipt_id = ?').get(r.id).v;
    out.push({ date: r.received_at, memo: `Received ${r.id} on ${r.po_id}`, customer: vendorName(r.vendor_id), currency: r.currency, source: r.id,
      lines: [{ account: 'Inventory', debit: value }, { account: 'Goods Received Not Invoiced', credit: value }] });
  }
  const bills = db().prepare(`SELECT DISTINCT b.* FROM purch_bill b JOIN p2p_bill_line bl ON bl.bill_id = b.id WHERE b.status IN ('approved','paid') ORDER BY b.bill_date, b.id`).all();
  for (const b of bills) {
    const vendor = vendorName(b.vendor_id);
    if (inRange(b.bill_date)) {
      const lines = db().prepare(`SELECT bl.qty, bl.unit_price, pl.unit_price AS po_price, pl.stocked, bl.po_id FROM p2p_bill_line bl JOIN p2p_po_line pl ON pl.id = bl.po_line_id WHERE bl.bill_id = ?`).all(b.id);
      let grni = 0, variance = 0, services = 0;
      for (const l of lines) {
        if (l.stocked) { grni += l.qty * l.po_price; variance += l.qty * (l.unit_price - l.po_price); }
        else services += l.qty * l.unit_price;
      }
      const cat = (b.category || 'purchased services').trim();
      const legs = [{ account: 'Goods Received Not Invoiced', debit: grni }];
      if (services) legs.push({ account: cat, map: { kind: 'category', key: cat, role: 'expense' }, debit: services });
      if (variance > 0) legs.push({ account: 'Purchase Price Variance', debit: variance });
      if (variance < 0) legs.push({ account: 'Purchase Price Variance', credit: -variance });
      legs.push({ account: 'Accounts Payable', credit: b.amount });
      out.push({ date: b.bill_date, memo: `Bill ${b.id}${b.number ? ' · ' + b.number : ''} on ${lines[0].po_id}`, customer: vendor, currency: b.currency, source: b.id, lines: legs });
    }
    // Paid from an imported statement: that row posts the payment (purchases). Paid any other
    // way, the payment is recorded here so Accounts Payable clears.
    if (b.status === 'paid' && !b.transaction_id && b.paid_at && inRange(b.paid_at)) {
      out.push({ date: b.paid_at, memo: `Paid ${b.id}${b.number ? ' · ' + b.number : ''}`, customer: vendor, currency: b.currency, source: b.id,
        lines: [{ account: 'Accounts Payable', debit: b.amount }, { account: 'Cash', credit: b.amount }] });
    }
  }
  return out;
}

module.exports = { tolerance, poLines, poView, pos, receiptView, goodsReceived, unbilled, matchOf, billMatch, billApprovalHold, billOnAccrual,
  DERIVATION_ACCOUNTS, journalLines, vendorName };
