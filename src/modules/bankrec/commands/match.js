'use strict';
/**
 * Matching a statement row to the payments and refunds it is (REC-1, REC-3, REC-4), and the
 * person's sign-off on a reconciliation (REC-5, REC-6).
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const purchases = () => { const m = require('../../../registry.js').MODULES.find(x => x.name === 'purchases'); if (!m) throw new Rejected('Statements live in the purchases area, which is not in this space.'); return m.api; };
const reasonOf = (r, what) => { const s = String(r || '').trim(); if (!s) throw new Rejected(`${what} needs a reason.`); return s; };

const ITEM = { item: { ...f.text('A payment or refund recorded here, by the key rec_candidates and rec_reconciliation list: o2c:payment:P-0001, solo:payment:P-0001, o2c:refund:RF-0001.'), required: true } };

defineCommand({
  name: 'rec_match',
  permission: 'cash.write',
  title: 'Match to a payment', group: 'Bank reconciliation', subject: 'bankrec_match', scope: 'collection',
  summary: 'Tie a statement row to the payments or refunds recorded here that it is. They must add up to the row exactly. The row then posts nothing itself: the payment already did.',
  doctrine: `A deposit on the statement is often a payment already recorded against an invoice. Read
rec_candidates: per row, what fits by amount, date and name. Show the person, then match with a reason
("the Northwind ACH is their payment NW-ACH-2210"). One row can be several payments (a deposit of
three checks); the items must add up to the row exactly, never "close enough". A row already booked as
income or spending cannot be matched: that would count the money twice; say what it is booked as
and let the person decide. Never record a payment just to have something to match.`,
  effects: ['statement row matched; it posts nothing itself', 'the payments it is are now on the statement'],
  args: {
    transaction_id: { ...f.ref('purch_transaction', 'The statement row.'), required: true },
    items:          { ...f.lines(ITEM, 'The payments or refunds it is; they add up to the row exactly.'), required: true },
    reason:         { ...f.text('Why they are the same money.'), required: true },
  },
  handler(a, { db, at, actor }) {
    const why = reasonOf(a.reason, 'A match');
    const row = purchases().statementRows().find(t => t.id === a.transaction_id);
    if (!row) throw new Rejected(`${a.transaction_id} is not a statement row here.`);
    const ms = V.activeMatches();
    const already = ms.find(m => m.transaction_id === row.id);
    if (already) throw new Rejected(`${row.id} is already matched (${already.id}). Unmatch it first if that match is wrong.`);
    if (row.posts) throw new Rejected(`${row.id} (${row.description}, ${row.amount_display}) is already booked as ${row.status}${row.category ? ` (${row.category})` : ''}, so it is in the books once. Matching it to a payment would count the money twice. If it really is that payment, review it as a transfer with no other side first.`);
    if (row.status === 'ignored') throw new Rejected(`${row.id} is marked as not theirs to track. Review it again first if it is a payment.`);
    const keys = (a.items || []).map(x => (typeof x === 'string' ? x : x && x.item) || '').map(s => s.trim()).filter(Boolean);
    if (!keys.length) throw new Rejected('Name the payments or refunds the row is (items).');
    if (new Set(keys).size !== keys.length) throw new Rejected('An item is listed twice.');
    const all = new Map(V.cashItems().map(c => [c.key, c]));
    const taken = new Map(ms.flatMap(m => m.items.map(i => [i.item_key, m.id])));
    const items = keys.map(k => {
      const c = all.get(k);
      if (!c) throw new Rejected(`${k} is not a payment or refund recorded here. Keys look like o2c:payment:P-0001; rec_candidates lists them.`);
      if (taken.has(k)) throw new Rejected(`${c.label} is already matched (${taken.get(k)}).`);
      if (c.currency !== row.currency) throw new Rejected(`${c.label} is in ${c.currency}; ${row.id} is in ${row.currency}.`);
      return c;
    });
    const total = items.reduce((n, c) => n + c.amount, 0);
    if (total !== row.amount) throw new Rejected(`They add up to ${H.money(total, row.currency)}; ${row.id} is ${row.amount_display}. A match is exact: ${H.money(row.amount - total, row.currency)} is unaccounted for.`);
    const id = H.nextId('BM', 'bankrec_match');
    const was = purchases().markRecordedElsewhere(db, row.id, `Matched to ${items.map(c => c.label).join(' + ')} (${id})`, at);
    db.prepare('INSERT INTO bankrec_match (id,transaction_id,row_was,reason,created_by,created_at) VALUES (?,?,?,?,?,?)').run(id, row.id, JSON.stringify(was), why, actor || null, at);
    const ins = db.prepare('INSERT INTO bankrec_match_item (match_id,item_key,amount) VALUES (?,?,?)');
    for (const c of items) ins.run(id, c.key, c.amount);
    return { ...V.matchView(id), note: `Matched ${row.id} (${row.description}, ${row.amount_display}) to ${items.map(c => c.label).join(' + ')} as ${id}. The row posts nothing itself; the payment is in the books once.` };
  },
});

defineCommand({
  name: 'rec_unmatch',
  permission: 'cash.write',
  title: 'Unmatch', group: 'Bank reconciliation', subject: 'bankrec_match',
  summary: 'Undo a match, with a reason. The row goes back to how it was reviewed before; the payments are unmatched again.',
  doctrine: 'For a match that was wrong. The row returns to its earlier review (often not reviewed); say so to the person.',
  effects: ['match undone; the row back to its earlier review'],
  guards: [ (m) => !m.unmatched_at || `${m.id} was already unmatched.` ],
  args: {
    match_id: { ...f.ref('bankrec_match', 'The match, e.g. BM-0001.'), required: true },
    reason:   { ...f.text('Why it was wrong.'), required: true },
  },
  handler(a, { db, at, actor }) {
    const m = H.need('bankrec_match', a.match_id, 'match');
    if (m.unmatched_at) throw new Rejected(`${m.id} was already unmatched.`);
    const why = reasonOf(a.reason, 'Unmatching');
    purchases().restoreRow(db, m.transaction_id, JSON.parse(m.row_was || '{}'));
    db.prepare('UPDATE bankrec_match SET unmatched_at = ?, unmatched_by = ?, unmatch_reason = ? WHERE id = ?').run(at, actor || null, why, m.id);
    return { ...V.matchView(m.id), note: `${m.id} undone: ${m.transaction_id} is back to how it was reviewed before, and its payments are unmatched.` };
  },
});

defineCommand({
  name: 'rec_sign_off',
  permission: 'credit.authority',
  title: 'Sign off the reconciliation', group: 'Bank reconciliation', subject: 'bankrec_signoff', scope: 'collection',
  human_only: 'A reconciliation is a person\'s word that the bank and the books were looked at and agree.',
  summary: 'Sign off an account\'s reconciliation through a statement\'s last day, with a reason. It is kept as it stands: the figures, the items and a hash.',
  doctrine: 'Refused to you whatever your role. Prepare it (matches, reviews), show the person rec_reconciliation, and they sign it in the app.',
  effects: ['reconciliation signed off and kept as it stood'],
  args: {
    account: { ...f.text('The bank or card account, as the statement prints it.'), required: true },
    through: { ...f.date('The last day of the statement.'), required: true },
    reason:  { ...f.text('What was checked: "September statement, checked with Dana".'), required: true },
  },
  handler(a, { db, at, actor }) {
    const why = reasonOf(a.reason, 'A sign-off');
    const r = V.reconciliation({ account: a.account, through: a.through });
    if (V.signoffRow(r.account, r.currency, r.through)) throw new Rejected(`${r.account} is already signed off through ${r.through}.`);
    if (!r.ready) throw new Rejected(`${r.account} cannot be signed off through ${r.through} yet: ${r.blocking.join(' ')}`);
    const kept = { in_transit: r.in_transit.items, not_in_books: r.not_in_books.items, timing: r.timing.items };
    const id = H.nextId('BR', 'bankrec_signoff');
    db.prepare('INSERT INTO bankrec_signoff (id,account,currency,through,statement_id,printed,books,kept_json,hash,reason,signed_by,signed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, r.account, r.currency, r.through, r.statement_id, r.printed, r.books, JSON.stringify(kept), r.hash, why, actor || null, at);
    return { id, account: r.account, through: r.through, printed_display: r.printed_display, books_display: r.books_display, hash: r.hash,
      note: `Signed off ${r.account} through ${r.through} as ${id}: statement ${r.printed_display}, books ${r.books_display}${r.in_transit.count ? `, ${r.in_transit.total_display} in transit` : ''}. Kept with hash ${r.hash}; a later change will show as changed since.` };
  },
});
