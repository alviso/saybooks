'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const LEG = {
  amount: { ...f.money('This leg, positive.'), required: true },
  category: { ...f.text("What this part was, in the person's word."), required: true },
  note: f.text('Anything they said about this part.'),
};

defineCommand({
  name: 'purch_split_transaction',
  permission: 'cash.write',
  title: 'Split a row', group: 'Purchases', subject: 'purch_transaction',
  summary: 'Say how one statement row breaks down: several categories that add up to it exactly. The row itself never changes.',
  doctrine: `One line on a statement is often several things: a payroll run is wages, employer
taxes and the processor's fee; a warehouse trip is supplies and groceries. The statement only
knows the total, so the breakdown comes from the person or from a document they have — the
payroll report, the receipt. Never invent the split; ask, or leave the row whole.

The legs must add to the row's amount exactly. They are refused otherwise, with the gap named,
for the same reason a statement is: a breakdown that does not add up is a transcription error.
The row keeps its amount, its date and the line it came from; only the ledger sees the legs,
each posting to its own category against the account the money moved on. Pass remove to drop a
split and put the row back to its single category.`,
  effects: ['split legs recorded, replacing any earlier split'],
  guards: [ (t) => ['purchase', 'recurring', 'income'].includes(t.status) || `${t.id} is ${t.status === 'unreviewed' ? 'not reviewed yet' : `a ${t.status}`}; only spending or income breaks down into categories.` ],
  args: {
    transaction_id: { ...f.text('The row, e.g. T-0014.'), required: true },
    parts: f.lines(LEG, 'The parts it breaks into. At least two, adding to the row exactly.'),
    remove: f.bool('Drop the split and leave the row whole.'),
    reason: f.text('Where the breakdown came from — the payroll report, the receipt.'),
  },
  handler(a, { db }) {
    const t = H.need('purch_transaction', a.transaction_id, 'transaction');
    if (!['purchase', 'recurring', 'income'].includes(t.status)) throw new Rejected(`${t.id} is ${t.status === 'unreviewed' ? 'not reviewed yet' : `a ${t.status}`}; only spending or income breaks down into categories.`);
    if (a.remove) {
      const n = db.prepare('DELETE FROM purch_split WHERE transaction_id = ?').run(t.id).changes;
      if (!n) throw new Rejected(`${t.id} is not split.`);
      return { ...V.transactionView(t.id), removed: n };
    }
    const parts = a.parts || [];
    if (parts.length < 2) throw new Rejected('A split needs at least two parts. To change what a whole row is, review it again.');
    const total = Math.abs(t.amount);
    let sum = 0;
    parts.forEach((p, i) => {
      if (!Number.isInteger(p.amount) || p.amount <= 0) throw new Rejected(`Part ${i + 1}: each leg is a positive whole number of minor units.`);
      if (!String(p.category || '').trim()) throw new Rejected(`Part ${i + 1} has no category — what was it?`);
      sum += p.amount;
    });
    if (sum !== total) {
      throw new Rejected(`The parts add to ${H.money(sum, t.currency)}, but ${t.id} is ${H.money(total, t.currency)} — a gap of ${H.money(total - sum, t.currency)}. Check the breakdown; the row itself is what the statement said and does not move.`);
    }
    db.prepare('DELETE FROM purch_split WHERE transaction_id = ?').run(t.id);
    parts.forEach((p, i) => db.prepare('INSERT INTO purch_split (transaction_id,pos,amount,category,note) VALUES (?,?,?,?,?)')
      .run(t.id, i + 1, p.amount, p.category.trim(), p.note || null));
    return V.transactionView(t.id);
  },
});
