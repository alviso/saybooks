'use strict';
/**
 * Transfers between the person's own accounts (purchases 0.7): the two statement rows of one move
 * paired, so it is counted once and never as spending or income (P-16), by a reasoned act (P-17).
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Transfers read', ...def });
const MAX_DAYS = 10;

defineCommand({
  name: 'purch_pair_transfer',
  permission: 'cash.write',
  title: 'Pair a transfer', group: 'Transfers', subject: 'purch_transfer', scope: 'collection',
  summary: 'Tie the two sides of one move between your own accounts: the row where money left and the row where it arrived. Counted once, as neither spending nor income.',
  doctrine: `Paying the card from checking shows twice: out of checking, into the card. Read
purch_transfers for the suggested pairs (same amount, close in time, worded as a payment), show the
person, and pair with a reason. The amounts must be exactly opposite and the accounts different;
a pair is refused otherwise. A transfer to an account that has no statements here (a savings
account kept elsewhere, an owner draw) is not a pair: review that row as a transfer naming where
the money went.`,
  effects: ['both rows reviewed as one transfer', 'the move counted once, between the two accounts'],
  args: {
    out_transaction_id: { ...f.ref('purch_transaction', 'The row where money left, e.g. the checking row.'), required: true },
    in_transaction_id:  { ...f.ref('purch_transaction', 'The row where it arrived, e.g. the card\'s payment row.'), required: true },
    reason:             { ...f.text('Why they are one move.'), required: true },
  },
  handler(a, { db, at, actor }) {
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Pairing a transfer needs a reason.');
    if (a.out_transaction_id === a.in_transaction_id) throw new Rejected('A transfer has two sides; name two rows.');
    const o = V.rowWithAccount(a.out_transaction_id), i = V.rowWithAccount(a.in_transaction_id);
    if (!o) throw new Rejected(`${a.out_transaction_id} is not a statement row here.`);
    if (!i) throw new Rejected(`${a.in_transaction_id} is not a statement row here.`);
    if (!(o.amount < 0)) throw new Rejected(`${o.id} is money in (${H.money(o.amount, o.currency)}); the out side is where money left.`);
    if (!(i.amount > 0)) throw new Rejected(`${i.id} is money out (${H.money(i.amount, i.currency)}); the in side is where money arrived.`);
    if (o.currency !== i.currency) throw new Rejected(`${o.id} is in ${o.currency}, ${i.id} in ${i.currency}. A transfer across currencies is not paired here.`);
    if (o.amount !== -i.amount) throw new Rejected(`They do not add up: ${H.money(-o.amount, o.currency)} left, ${H.money(i.amount, i.currency)} arrived. A pair is exact; a fee in between is its own row.`);
    if (o.account_id && o.account_id === i.account_id) throw new Rejected(`Both rows are on ${o.account_name}. A transfer moves money between two accounts.`);
    const gap = Math.abs(Math.round((Date.parse(i.date) - Date.parse(o.date)) / 864e5));
    if (gap > MAX_DAYS) throw new Rejected(`${o.date} and ${i.date} are ${gap} days apart; a transfer between your accounts arrives within ${MAX_DAYS}. If this truly is one move, the statements are worth a second look first.`);
    const pi = V.pairIndex(), held = V.matchedRows();
    let billPaid = new Set(); try { billPaid = new Set(db.prepare('SELECT transaction_id FROM purch_bill WHERE transaction_id IS NOT NULL').all().map(r => r.transaction_id)); } catch { /* none */ }
    for (const t of [o, i]) {
      if (pi.has(t.id)) throw new Rejected(`${t.id} is already paired (${pi.get(t.id).pair.id}).`);
      if (held.has(t.id)) throw new Rejected(`${t.id} is matched to ${held.get(t.id)}; it is not a transfer.`);
      if (billPaid.has(t.id)) throw new Rejected(`${t.id} paid a bill; it is not a transfer between your accounts.`);
      if (V.splitsOf(t.id).length) throw new Rejected(`${t.id} is split into parts; a split row is not one side of a transfer.`);
      if (!['unreviewed', 'transfer'].includes(t.status)) throw new Rejected(`${t.id} (${t.description}) is reviewed as ${t.status}${t.category ? ` (${t.category})` : ''}. If it really is a transfer, review it as one first; pairing never overrides a review silently.`);
    }
    const was = (t) => JSON.stringify({ status: t.status, category: t.category, note: t.note, reviewed_at: t.reviewed_at });
    const id = H.nextId('TR', 'purch_transfer');
    db.prepare('INSERT INTO purch_transfer (id,out_tx,in_tx,out_was,in_was,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, o.id, i.id, was(o), was(i), why, actor || null, at);
    db.prepare("UPDATE purch_transaction SET status = 'transfer', category = ?, note = ?, reviewed_at = ? WHERE id = ?").run(i.account_name, `Transfer ${id} to ${i.account_name}`, at, o.id);
    db.prepare("UPDATE purch_transaction SET status = 'transfer', category = NULL, note = ?, reviewed_at = ? WHERE id = ?").run(`Transfer ${id} from ${o.account_name}`, at, i.id);
    return { ...V.transferView(id), note: `Paired ${id}: ${H.money(-o.amount, o.currency)} from ${o.account_name} (${o.id}, ${o.date}) to ${i.account_name} (${i.id}, ${i.date}). Counted once, as a move between the two accounts.` };
  },
});

defineCommand({
  name: 'purch_unpair_transfer',
  permission: 'cash.write',
  title: 'Unpair', group: 'Transfers', subject: 'purch_transfer',
  summary: 'Undo a pairing, with a reason. Both rows go back to how they were reviewed before.',
  doctrine: 'For a pair that was wrong. Say so to the person: both rows need reviewing again.',
  effects: ['pair undone; both rows back to their earlier review'],
  guards: [ (p) => !p.unpaired_at || `${p.id} was already unpaired.` ],
  args: {
    transfer_id: { ...f.ref('purch_transfer', 'The pair, e.g. TR-0001.'), required: true },
    reason:      { ...f.text('Why it was wrong.'), required: true },
  },
  handler(a, { db, at, actor }) {
    const p = H.need('purch_transfer', a.transfer_id, 'transfer');
    if (p.unpaired_at) throw new Rejected(`${p.id} was already unpaired.`);
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Unpairing needs a reason.');
    for (const [tx, w] of [[p.out_tx, p.out_was], [p.in_tx, p.in_was]]) {
      const was = JSON.parse(w || '{}');
      db.prepare('UPDATE purch_transaction SET status = ?, category = ?, note = ?, reviewed_at = ? WHERE id = ?').run(was.status || 'unreviewed', was.category ?? null, was.note ?? null, was.reviewed_at ?? null, tx);
    }
    db.prepare('UPDATE purch_transfer SET unpaired_at = ?, unpaired_by = ?, unpair_reason = ? WHERE id = ?').run(at, actor || null, why, p.id);
    return { ...V.transferView(p.id), note: `${p.id} unpaired: ${p.out_tx} and ${p.in_tx} are back to how they were reviewed before.` };
  },
});

read({ name: 'purch_transfers', title: 'Transfers', summary: 'Moves between your own accounts: the pairs, the rows that look like the two sides of one move (suggested, with why), and transfers with one side so far. With transfer_id: that pair whole.',
  args: { transfer_id: f.text('One pair, e.g. TR-0001.') }, handler: (a) => a.transfer_id ? V.transferView(a.transfer_id) : V.transfers() });
