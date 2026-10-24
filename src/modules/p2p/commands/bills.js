'use strict';
/**
 * A vendor bill recorded against an order (p2p 0.2). The bill is the purchases area's bill,
 * recorded through its one door, so its duplicate guard holds (P2P-10); this area keeps its
 * lines for the 3-way match, which a person's approval must pass (P2P-2, P2P-3). Loosening the
 * match is a person's act (P2P-6).
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const area = (name) => { const m = require('../../../registry.js').MODULES.find(x => x.name === name); if (!m) throw new Error(`the ${name} area is not loaded`); return m.api; };

const BILL_LINE = {
  item_id:    { ...f.ref('item', 'The item the line bills for.'), required: true },
  qty:        { ...f.int('How many the bill charges for.'), required: true },
  unit_price: { ...f.money('The price for one, as printed on the bill.'), required: true },
};

defineCommand({
  name: 'p2p_record_vendor_bill',
  permission: 'cash.write',
  title: 'Record a bill on this order', group: 'Purchasing', subject: 'p2p_po',
  summary: 'Record a vendor\'s bill against an order, line by line as printed. It is matched against what was ordered and received; a person approves paying it only when it matches.',
  doctrine: `You were handed the vendor's invoice for goods on an order. Record it line by line as
printed: the item, the quantity and the price for one, plus the vendor's invoice number and the
dates. Never correct a line to make it match; the bill is what the vendor says, and the match
exists to show where it differs. The result says whether it matches the order and, when it does
not, by how much. Recording is never refused for a mismatch; approving it is. Tell the person
what the match says; when it does not match, the answer is a corrected bill from the vendor (record
it, and the person rejects the old one) or a person loosening the tolerance with a reason.`,
  effects: ['bill recorded in Bills, waiting for approval', 'its lines kept for the 3-way match'],
  audit_subject: (r) => r.id,   // the audit row is about the bill, so the bill's own history shows it
  guards: [ (p) => ['issued', 'received', 'closed_short'].includes(p.status) || `${p.id} is ${p.status}; bills are recorded against an issued order.` ],
  args: {
    po_id:      { ...f.ref('p2p_po', 'The order the bill is for.'), required: true },
    number:     f.text('The vendor\'s own invoice number, as printed.'),
    bill_date:  { ...f.date('The date on the bill.'), required: true },
    due_date:   f.date('When it is due, as printed.'),
    terms_days: f.int('Or the days the bill gives (30 for net 30), when it prints no due date.'),
    lines:      { ...f.lines(BILL_LINE, 'What the bill charges, line by line.'), required: true },
    category:   f.text('For service lines only (freight, installation): what it is for, in the person\'s words.'),
    file_name:  f.text('The file you were handed, for the record.'),
    file_hash:  f.text('A hash of that file, if you have one.'),
    reason:     f.text('Where it came from: "emailed by Acme on the 3rd".'),
  },
  handler(a, { db, at, actor }) {
    const po = V.poView(a.po_id);
    if (!['issued', 'received', 'closed_short'].includes(po.status)) throw new Rejected(`${po.id} is ${po.status}; bills are recorded against an issued order.`);
    if (!Array.isArray(a.lines) || !a.lines.length) throw new Rejected('A bill on an order needs its lines, as printed.');
    const seen = new Set();
    for (const r of a.lines) {
      const l = po.lines.find(x => x.item_id === r.item_id);
      if (!l) throw new Rejected(`${r.item_id} is not on ${po.id}. A charge for something not ordered is its own bill (purch_add_bill), or a question for the vendor.`);
      if (seen.has(r.item_id)) throw new Rejected(`${r.item_id} is listed twice. Record the bill's line once, as printed.`);
      seen.add(r.item_id);
      if (!(r.qty > 0)) throw new Rejected(`${r.item_id}: the billed quantity is a positive whole number.`);
      if (!(r.unit_price >= 0)) throw new Rejected(`${r.item_id}: the price is in cents, not negative.`);
    }
    const amount = a.lines.reduce((n, r) => n + r.qty * r.unit_price, 0);
    const bill = area('purchases').addBill(db, {
      vendor: po.vendor, number: a.number, bill_date: a.bill_date, due_date: a.due_date, terms_days: a.terms_days, amount, currency: po.currency,
      category: a.category || null, description: `On ${po.id}`, file_name: a.file_name, file_hash: a.file_hash,
    }, { at, actor });
    for (const r of a.lines) {
      const l = po.lines.find(x => x.item_id === r.item_id);
      db.prepare('INSERT INTO p2p_bill_line (bill_id,po_id,po_line_id,item_id,qty,unit_price) VALUES (?,?,?,?,?,?)').run(bill.id, po.id, l.id, r.item_id, r.qty, r.unit_price);
    }
    const m = V.matchOf(bill.id);
    return { ...bill, po_id: po.id, match: m,
      note: `Recorded ${bill.name} on ${po.id}: ${bill.amount_display}, due ${bill.due_date}. ${m.ok ? 'It matches the order; it waits for a person to approve paying it.' : `It does not match: ${m.problems.join('; ')}. A person cannot approve it as it stands.`}` };
  },
});

defineCommand({
  name: 'p2p_set_match_tolerance',
  permission: 'workspace.admin',
  title: 'Set match tolerance', group: 'Purchasing', scope: 'collection', subject: 'p2p_po',
  human_only: 'Loosening the match is a decision about how much a vendor may overcharge before a person is told no.',
  summary: 'How far a bill may stray from its order before approval is refused: a price percentage and a quantity percentage. 0 by default.',
  doctrine: 'Refused to you whatever your role. If a bill is refused by the match, show the person the numbers (p2p_bill_match); they decide whether to loosen it.',
  effects: ['match tolerance set'],
  args: {
    price_pct: f.int('Percent a billed price may exceed the order\'s price (2 for 2%).'),
    qty_pct:   f.int('Percent a billed or received quantity may exceed what was received or ordered.'),
    reason:    { ...f.text('Why, for the record.'), required: true },
  },
  handler(a, { db, at, actor }) {
    if (a.price_pct == null && a.qty_pct == null) throw new Rejected('Say which tolerance: price_pct, qty_pct, or both.');
    for (const [k, v] of [['price_pct', a.price_pct], ['qty_pct', a.qty_pct]]) if (v != null && (v < 0 || v > 50)) throw new Rejected(`${k} is 0 to 50 percent.`);
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Changing the match tolerance needs a reason.');
    const put = db.prepare('INSERT INTO p2p_setting (key,value,set_by,set_at,reason) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at, reason = excluded.reason');
    if (a.price_pct != null) put.run('price_pct', String(a.price_pct), actor || null, at, why);
    if (a.qty_pct != null) put.run('qty_pct', String(a.qty_pct), actor || null, at, why);
    const t = V.tolerance();
    return { ...t, note: `Match tolerance is now price ${t.price_pct}%, quantity ${t.qty_pct}%.` };
  },
});

module.exports = { BILL_LINE };
