'use strict';
/**
 * Inventory (0.1): the opening cost of stock that came in without one, and physical counts. Stock
 * moves go through core's door (STK-2); cost is derived (STK-3).
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');
const core = () => require('../../core/index.js');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const reasonOf = (r, what) => { const s = String(r || '').trim(); if (!s) throw new Rejected(`${what} needs a reason.`); return s; };

defineCommand({
  name: 'inv_set_opening_cost',
  permission: 'billing.write',
  title: 'Set opening cost', group: 'Inventory', subject: 'inv_item',
  summary: 'What one unit was worth when it came in without a cost: stock on hand before these books, or a correction received by hand. Everything after it is derived.',
  doctrine: `Only for stock that came in without a cost. Take the figure from a record the person has:
the last supplier invoice, a stock sheet, the accountant's figure. Never estimate it yourself, and
never use the selling price. It is the one cost anyone states; every other cost is derived from what
was paid on purchase orders. Changing it later re-derives everything after it, so say why.`,
  effects: ['opening cost stated; average cost, value and cost of goods sold re-derived'],
  guards: [ (i) => i.stocked || `${i.id} is a service; it has no stock to cost.` ],
  args: {
    item_id:   { ...f.ref('item', 'The item.'), required: true },
    unit_cost: { ...f.money('What one unit was worth.'), required: true },
    reason:    { ...f.text('Where the figure comes from: "last Bay Gasket invoice, March".'), required: true },
  },
  handler(a, { db, at, actor }) {
    const item = H.need('item', a.item_id, 'item');
    if (!item.stocked) throw new Rejected(`${item.id} is a service; it has no stock to cost.`);
    if (!(a.unit_cost >= 0)) throw new Rejected('The cost is a whole number of cents, zero or more.');
    const why = reasonOf(a.reason, 'An opening cost');
    const before = V.itemStock(item.id);
    db.prepare(`INSERT INTO inv_opening_cost (item_id,unit_cost,reason,set_by,set_at) VALUES (?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET unit_cost = excluded.unit_cost, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`).run(item.id, a.unit_cost, why, actor || null, at);
    const s = V.itemStock(item.id);
    return { ...s, note: `${item.id}: opening cost ${s.opening_cost_display}. ${s.cost_known ? `${s.qty} on hand at an average of ${s.average_cost_display}, worth ${s.value_display}.` : s.note}${before.cost_known ? '' : ' Its cost of goods sold is now derived too.'}` };
  },
});

defineCommand({
  name: 'inv_count_stock',
  permission: 'fulfil.write',
  title: 'Record a count', group: 'Inventory', subject: 'inv_item',
  summary: 'What was counted on the shelf for one item. The difference from the record becomes a count move, valued at the average cost.',
  doctrine: `Record what the person counted, never what you expect. A count needs a reason, said plainly
("three damaged in the move", "yearly count"). When the count matches the record nothing moves, and
that is worth saying too. A difference is valued at the average cost of that moment and posts to
Inventory Adjustments: the accountant sees it as shrinkage or a gain, never hidden in cost of sales.`,
  effects: ['count recorded; the difference moves stock through core'],
  guards: [ (i) => i.stocked || `${i.id} is a service; there is nothing to count.` ],
  args: {
    item_id:    { ...f.ref('item', 'The item counted.'), required: true },
    counted:    { ...f.int('How many are on the shelf, as counted.'), required: true },
    reason:     { ...f.text('Why it was counted, or why it differs.'), required: true },
    counted_at: f.date('The day it was counted. Defaults to today.'),
  },
  handler(a, { db, at }) {
    const item = H.need('item', a.item_id, 'item');
    if (!item.stocked) throw new Rejected(`${item.id} is a service; there is nothing to count.`);
    if (!Number.isInteger(a.counted) || a.counted < 0) throw new Rejected('The count is a whole number, zero or more.');
    if (a.counted_at && !ISO.test(a.counted_at)) throw new Rejected(`counted_at must be a date as YYYY-MM-DD; got "${a.counted_at}".`);
    const day = a.counted_at || H.today();
    if (day > H.today()) throw new Rejected(`${day} has not happened yet. Record a count once it is done.`);
    const why = reasonOf(a.reason, 'A count');
    const diff = a.counted - item.on_hand;
    if (diff === 0) return { ...V.itemStock(item.id), difference: 0, note: `${item.id}: ${a.counted} counted, the same as the record. Nothing moves.` };
    core().adjustStock(db, item.id, diff, `count: ${why}`, { kind: 'count', date: day });
    const s = V.itemStock(item.id);
    const mv = s.moves[0];
    return { ...s, difference: diff, difference_value: mv.value_change, difference_value_display: mv.value_change_display,
      note: `${item.id}: ${a.counted} counted, the record said ${item.on_hand}; ${Math.abs(diff)} ${diff < 0 ? 'fewer' : 'more'}${mv.value_change != null ? `, ${mv.value_change_display.replace('-', '')} at the average cost, posted to Inventory Adjustments` : ' (its cost is unknown until the opening cost is stated)'}.` };
  },
});
