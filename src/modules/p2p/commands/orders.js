'use strict';
/**
 * Purchase orders and goods received (p2p 0.2). An order freezes its prices when it is issued;
 * stock enters only through a goods receipt, by core's stock door (P2P-4); receiving more than
 * is open is refused with the numbers (P2P-11). Nothing here pays anything (P2P-9).
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (k, v) => { if (v && !ISO.test(v)) throw new Rejected(`${k} must be a date as YYYY-MM-DD; got "${v}".`); };
const area = (name) => { const m = require('../../../registry.js').MODULES.find(x => x.name === name); if (!m) throw new Error(`the ${name} area is not loaded`); return m.api; };
const core = () => require('../../core/index.js');
const reasonOf = (r, what) => { const s = String(r || '').trim(); if (!s) throw new Rejected(`${what} needs a reason.`); return s; };

const PO_LINE = {
  item_id:    { ...f.ref('item', 'What is being bought.'), required: true },
  qty:        { ...f.int('How many.'), required: true },
  unit_price: { ...f.money('The vendor\'s price for one, as quoted.'), required: true },
};
const RECEIVE_LINE = {
  item_id: { ...f.ref('item', 'What arrived.'), required: true },
  qty:     { ...f.int('How many arrived, as counted.'), required: true },
};

defineCommand({
  name: 'p2p_create_po',
  permission: 'cash.write',
  title: 'New purchase order', group: 'Purchasing', subject: 'p2p_po', scope: 'collection',
  summary: 'Draft an order to a vendor: what, how many, at the price they quoted. A draft commits to nothing until it is issued.',
  doctrine: `Use the items as they are on record (core items); the price is the vendor's price for
one, as they quoted it, never the price you sell at. One line per item. Never invent a price or a
quantity: ask. A draft can be cancelled and raised again; once issued, the prices are frozen and
the order is what bills are matched against.`,
  effects: ['purchase order created in draft'],
  args: {
    vendor:        { ...f.text('The vendor\'s name as a person would say it (Acme Supply).'), required: true },
    lines:         { ...f.lines(PO_LINE, 'What is being ordered.'), required: true },
    expected_date: f.date('When the vendor said it will arrive.'),
    vendor_ref:    f.text('The vendor\'s quote or order reference.'),
    currency:      f.text('ISO 4217. Defaults to the company currency.'),
    note:          f.text('Anything about the order.'),
  },
  handler(a, { db, at, actor }) {
    if (!Array.isArray(a.lines) || !a.lines.length) throw new Rejected('An order needs at least one line.');
    isDate('expected_date', a.expected_date);
    const cur = (a.currency ? String(a.currency).trim().toUpperCase() : (H.locale().currency || 'USD'));
    if (!/^[A-Z]{3}$/.test(cur)) throw new Rejected(`"${a.currency}" is not a currency code; use three letters (USD, EUR).`);
    const seen = new Set();
    for (const l of a.lines) {
      core().needItem(l.item_id);
      if (seen.has(l.item_id)) throw new Rejected(`${l.item_id} is on the order twice. Put the whole quantity on one line.`);
      seen.add(l.item_id);
      if (!(l.qty > 0)) throw new Rejected(`${l.item_id}: the quantity must be a positive whole number.`);
      if (!(l.unit_price > 0)) throw new Rejected(`${l.item_id}: the price is the vendor's price for one, a positive number of cents.`);
    }
    const v = area('purchases').vendorFor(db, a.vendor, at);
    const id = H.nextId('PO', 'p2p_po');
    db.prepare(`INSERT INTO p2p_po (id,vendor_id,status,currency,expected_date,vendor_ref,note,created_by,created_at,updated_at) VALUES (?,?,'draft',?,?,?,?,?,?,?)`)
      .run(id, v.id, cur, a.expected_date || null, a.vendor_ref || null, a.note || null, actor || null, at, at);
    a.lines.forEach((l, i) => {
      const item = core().needItem(l.item_id);
      db.prepare('INSERT INTO p2p_po_line (po_id,pos,item_id,qty,unit_price,stocked) VALUES (?,?,?,?,?,?)').run(id, i + 1, l.item_id, l.qty, l.unit_price, item.stocked ? 1 : 0);
    });
    const po = V.poView(id);
    return { ...po, note: `Drafted ${id} to ${po.vendor}: ${po.line_count} line${po.line_count === 1 ? '' : 's'}, ${po.total_display}. Issue it once the person has checked it.` };
  },
});

defineCommand({
  name: 'p2p_issue_po',
  permission: 'cash.write',
  title: 'Issue order', group: 'Purchasing', subject: 'p2p_po',
  summary: 'Record that the order went to the vendor. Its prices freeze: bills are matched against them.',
  doctrine: 'Issue when the person says the order went out (Saybooks sends nothing; they send it). After this the order cannot be edited, only received against, closed short or, while nothing has arrived, cancelled.',
  effects: ['order issued, prices frozen'],
  guards: [ (p) => p.status === 'draft' || `${p.id} is ${p.status}; only a draft is issued.` ],
  args: { po_id: { ...f.ref('p2p_po', 'The order, e.g. PO-0001.'), required: true } },
  handler(a, { db, at, actor }) {
    const p = H.need('p2p_po', a.po_id, 'purchase order');
    if (p.status !== 'draft') throw new Rejected(`${p.id} is ${p.status}; only a draft is issued.`);
    db.prepare("UPDATE p2p_po SET status = 'issued', issued_at = ?, issued_by = ?, updated_at = ? WHERE id = ?").run(at, actor || null, at, p.id);
    const po = V.poView(p.id);
    return { ...po, note: `${p.id} issued to ${po.vendor}, ${po.total_display}. Its prices are now what bills are matched against.` };
  },
});

defineCommand({
  name: 'p2p_cancel_po',
  permission: 'cash.write',
  title: 'Cancel order', group: 'Purchasing', subject: 'p2p_po',
  summary: 'Cancel an order nothing has arrived against and no bill points at. With a reason.',
  doctrine: 'Once anything has arrived, the order cannot be cancelled: close the rest short instead. The order stays on the record as cancelled.',
  effects: ['order cancelled'],
  guards: [
    (p) => ['draft', 'issued'].includes(p.status) || `${p.id} is ${p.status}.`,
    (p) => !(p.receipts && p.receipts.length) || `Goods have arrived against ${p.id}. Close the rest short instead.`,
    (p) => !(p.bills && p.bills.some(b => b.status !== 'rejected')) || `A bill points at ${p.id}. Reject the bill first, or close the order short.`,
  ],
  args: { po_id: { ...f.ref('p2p_po', 'The order.'), required: true }, reason: { ...f.text('Why it is cancelled.'), required: true } },
  handler(a, { db, at }) {
    const po = V.poView(a.po_id);
    if (!['draft', 'issued'].includes(po.status)) throw new Rejected(`${po.id} is ${po.status}.`);
    if (po.receipts.length) throw new Rejected(`Goods have arrived against ${po.id}. Close the rest short instead.`);
    if (po.bills.some(b => b.status !== 'rejected')) throw new Rejected(`A bill points at ${po.id}. Reject the bill first, or close the order short.`);
    db.prepare("UPDATE p2p_po SET status = 'cancelled', closed_at = ?, closed_reason = ?, updated_at = ? WHERE id = ?").run(at, reasonOf(a.reason, 'Cancelling an order'), at, po.id);
    return { ...V.poView(po.id), note: `${po.id} cancelled; it stays on the record.` };
  },
});

defineCommand({
  name: 'p2p_close_po_short',
  permission: 'cash.write',
  title: 'Close the rest short', group: 'Purchasing', subject: 'p2p_po',
  summary: 'Stop waiting for what has not arrived: the vendor will not send it. What did arrive stays received and billable. With a reason.',
  doctrine: 'Use it when the vendor says the rest is not coming. When nothing has arrived at all, cancel instead.',
  effects: ['order closed short'],
  guards: [
    (p) => p.status === 'issued' || `${p.id} is ${p.status}; only an issued order waiting for goods is closed short.`,
    (p) => (p.receipts && p.receipts.length > 0) || `Nothing has arrived against ${p.id}; cancel it instead.`,
  ],
  args: { po_id: { ...f.ref('p2p_po', 'The order.'), required: true }, reason: { ...f.text('Why the rest will not come.'), required: true } },
  handler(a, { db, at }) {
    const po = V.poView(a.po_id);
    if (po.status !== 'issued') throw new Rejected(`${po.id} is ${po.status}; only an issued order waiting for goods is closed short.`);
    if (!po.receipts.length) throw new Rejected(`Nothing has arrived against ${po.id}; cancel it instead.`);
    db.prepare("UPDATE p2p_po SET status = 'closed_short', closed_at = ?, closed_reason = ?, updated_at = ? WHERE id = ?").run(at, reasonOf(a.reason, 'Closing an order short'), at, po.id);
    const after = V.poView(po.id);
    const short = po.lines.filter(l => l.open_to_receive > 0).map(l => `${l.open_to_receive} ${l.item_id}`).join(', ');
    return { ...after, note: `${po.id} closed short${short ? `; not coming: ${short}` : ''}.` };
  },
});

defineCommand({
  name: 'p2p_receive_goods',
  permission: 'fulfil.write',
  title: 'Receive goods', group: 'Purchasing', subject: 'p2p_po',
  summary: 'Record what arrived against an order, as counted. Stock goes up; the goods are owed for until their bill is approved.',
  doctrine: `Record what was counted at the door, against the order it came on, with the packing
slip number when there is one. Never receive what was not counted, and never more than is still
open on a line: that is refused with the numbers, and the answer is a conversation with the
vendor, not a second order. Services are not received; their bill is matched against the order.
A receipt cannot be changed afterwards.`,
  effects: ['goods receipt recorded', 'stock increased through core', 'order received when every stocked line has arrived'],
  guards: [ (p) => p.status === 'issued' || `${p.id} is ${p.status}; goods are received against an issued order.` ],
  args: {
    po_id:       { ...f.ref('p2p_po', 'The order the goods came on.'), required: true },
    lines:       { ...f.lines(RECEIVE_LINE, 'What arrived.'), required: true },
    received_at: f.date('The day it arrived. Defaults to today.'),
    reference:   f.text('The packing slip or delivery note number.'),
    note:        f.text('Anything about the delivery (one box damaged).'),
  },
  handler(a, { db, at, actor }) {
    const po = V.poView(a.po_id);
    if (po.status !== 'issued') throw new Rejected(`${po.id} is ${po.status}; goods are received against an issued order.`);
    isDate('received_at', a.received_at);
    const day = a.received_at || H.today();
    if (day > H.today()) throw new Rejected(`${day} has not happened yet. Receive goods once they have arrived.`);
    if (!Array.isArray(a.lines) || !a.lines.length) throw new Rejected('Say what arrived: at least one line.');
    const tol = V.tolerance();
    const seen = new Set();
    for (const r of a.lines) {
      const l = po.lines.find(x => x.item_id === r.item_id);
      if (!l) throw new Rejected(`${r.item_id} is not on ${po.id}. Goods that were not ordered go back, or on an order of their own.`);
      if (seen.has(r.item_id)) throw new Rejected(`${r.item_id} is listed twice. Count it once.`);
      seen.add(r.item_id);
      if (!l.stocked) throw new Rejected(`${r.item_id} is a service; nothing arrives. Its bill is matched against what was ordered.`);
      if (!(r.qty > 0)) throw new Rejected(`${r.item_id}: the quantity received is a positive whole number.`);
      const allowed = Math.floor(l.qty * (100 + tol.qty_pct) / 100) - l.received;
      if (r.qty > allowed) throw new Rejected(`${po.id} ${r.item_id}: ${l.qty} ordered, ${l.received} already received, so ${Math.max(0, l.qty - l.received)} still open; ${r.qty} is ${r.qty - Math.max(0, allowed)} too many${tol.qty_pct ? ` (quantity tolerance ${tol.qty_pct}%)` : ''}.`);
    }
    const id = H.nextId('GR', 'p2p_receipt');
    db.prepare('INSERT INTO p2p_receipt (id,po_id,received_at,reference,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, po.id, day, a.reference || null, a.note || null, actor || null, at);
    for (const r of a.lines) {
      const l = po.lines.find(x => x.item_id === r.item_id);
      db.prepare('INSERT INTO p2p_receipt_line (receipt_id,po_line_id,item_id,qty,unit_cost) VALUES (?,?,?,?,?)').run(id, l.id, r.item_id, r.qty, l.unit_price);
      core().adjustStock(db, r.item_id, r.qty, `${id} on ${po.id}`);   // core's single stock door
    }
    const after = V.poView(po.id);
    if (after.lines.filter(l => l.stocked).every(l => l.received >= l.qty)) db.prepare("UPDATE p2p_po SET status = 'received', updated_at = ? WHERE id = ?").run(at, po.id);
    const gr = V.receiptView(id);
    const still = V.poView(po.id);
    return { ...gr, po_state: still.state, still_to_receive: still.to_receive,
      note: `${id}: received ${gr.lines.map(l => `${l.qty} ${l.item_id}`).join(', ')} on ${po.id}, ${gr.value_display} at the order's prices.${still.to_receive ? ` ${still.to_receive} still to come.` : ' Everything on the order has arrived.'}` };
  },
});

module.exports = { PO_LINE };
