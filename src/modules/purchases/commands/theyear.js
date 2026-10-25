'use strict';
/**
 * Receipts and the year (purchases 1.0): work expenses paid back (P-27), tax tags on categories and
 * the year as the record has it (P-28). Return and warranty dates ride on receipts (P-26).
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'The year read', ...def });

defineCommand({
  name: 'purch_record_reimbursement',
  permission: 'cash.write',
  title: 'Paid back', group: 'Purchases', subject: 'purch_reimbursement', scope: 'collection',
  summary: 'Tie money in to the work expenses it paid back. They must add up to it exactly; together they are no longer personal spending.',
  doctrine: `Work expenses are marked when reviewed (reimbursable_by, claim_ref). When the employer or client
pays them back, read purch_reimbursements, find the expenses the money covers (often one claim), show
the person, and tie them with a reason. The expenses must add up to the money in exactly; if less came
back than was claimed, tie the ones it covers and leave the rest waiting.`,
  effects: ['money in tied to the expenses it paid back', 'those expenses no longer personal spending'],
  args: {
    in_transaction_id: { ...f.ref('purch_transaction', 'The money in that paid them back.'), required: true },
    expenses:          { ...f.lines({ transaction_id: { ...f.ref('purch_transaction', 'An expense it paid back.'), required: true } }, 'The expenses it covers.'), required: true },
    reason:            { ...f.text('Which claim it was: "expense report 14, October travel".'), required: true },
  },
  handler(a, { db, at, actor }) {
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Tying a reimbursement needs a reason.');
    const t = H.need('purch_transaction', a.in_transaction_id, 'transaction');
    if (!(t.amount > 0)) throw new Rejected(`${t.id} is money out; a reimbursement is money in.`);
    if (!['unreviewed', 'income'].includes(t.status)) throw new Rejected(`${t.id} is reviewed as ${t.status}. If it really is money paid back, leave it unreviewed or review it as income first.`);
    if (V.reimbursementOf(t.id) || V.pairIndex().has(t.id) || V.matchedRows().has(t.id) || V.activeRefunds().some(r => r.refund_tx === t.id)) throw new Rejected(`${t.id} is already tied to something else.`);
    const ids = (a.expenses || []).map(x => (typeof x === 'string' ? x : x && x.transaction_id)).filter(Boolean);
    if (!ids.length) throw new Rejected('Name the expenses it paid back.');
    if (new Set(ids).size !== ids.length) throw new Rejected('An expense is listed twice.');
    const rows = ids.map(id => {
      const e = H.need('purch_transaction', id, 'transaction');
      if (!['purchase', 'recurring'].includes(e.status) || !(e.amount < 0)) throw new Rejected(`${e.id} (${e.description}) is ${e.status}; only spending is paid back.`);
      if (!e.reimbursable_by) throw new Rejected(`${e.id} (${e.description}) is not marked as a work expense. Mark it when reviewing (reimbursable_by) if it is one.`);
      if (e.currency !== t.currency) throw new Rejected(`${e.id} is in ${e.currency}; ${t.id} is in ${t.currency}.`);
      if (V.reimbursementOf(e.id)) throw new Rejected(`${e.id} is already paid back (${V.reimbursementOf(e.id)}).`);
      if (e.date > t.date) throw new Rejected(`${e.id} (${e.date}) is after the money came in (${t.date}).`);
      return e;
    });
    const sum = rows.reduce((n, e) => n - e.amount, 0);
    if (sum !== t.amount) throw new Rejected(`The expenses add up to ${H.money(sum, t.currency)}; ${t.id} is ${H.money(t.amount, t.currency)}. Tie exactly the expenses it covers; any left over keep waiting.`);
    const id = H.nextId('RB', 'purch_reimbursement');
    db.prepare('INSERT INTO purch_reimbursement (id,in_tx,in_was,reason,created_by,created_at) VALUES (?,?,?,?,?,?)').run(id, t.id, JSON.stringify({ status: t.status, category: t.category, note: t.note, reviewed_at: t.reviewed_at }), why, actor || null, at);
    const ins = db.prepare('INSERT INTO purch_reimbursement_item (reimbursement_id,transaction_id,amount) VALUES (?,?,?)');
    for (const e of rows) ins.run(id, e.id, -e.amount);
    db.prepare("UPDATE purch_transaction SET status = 'reimbursement', category = NULL, note = ?, reviewed_at = ? WHERE id = ?").run(`Paid back ${rows.map(e => e.id).join(', ')} (${id})`, at, t.id);
    return { id, in_transaction_id: t.id, expenses: rows.map(e => e.id), amount_display: H.money(t.amount, t.currency),
      note: `Tied ${t.id} (${H.money(t.amount, t.currency)}) to ${rows.length} expense${rows.length === 1 ? '' : 's'} it paid back, as ${id}: ${rows.map(e => `${e.id} ${e.description}`).join('; ')}. Together they are no longer personal spending.` };
  },
});

defineCommand({
  name: 'purch_unlink_reimbursement',
  permission: 'cash.write',
  title: 'Untie', group: 'Purchases', subject: 'purch_reimbursement',
  summary: 'Undo a reimbursement tie, with a reason. The money in goes back to how it was reviewed; the expenses wait again.',
  doctrine: 'For a tie that was wrong: say so to the person, since the expenses count as theirs again until tied correctly.',
  effects: ['tie undone; the money in back to its earlier review'],
  guards: [ (r) => !r.unlinked_at || `${r.id} was already untied.` ],
  args: { reimbursement_id: { ...f.ref('purch_reimbursement', 'e.g. RB-0001.'), required: true }, reason: { ...f.text('Why.'), required: true } },
  handler(a, { db, at }) {
    const r = H.need('purch_reimbursement', a.reimbursement_id, 'reimbursement');
    if (r.unlinked_at) throw new Rejected(`${r.id} was already untied.`);
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Untying needs a reason.');
    const was = JSON.parse(r.in_was || '{}');
    db.prepare('UPDATE purch_transaction SET status = ?, category = ?, note = ?, reviewed_at = ? WHERE id = ?').run(was.status || 'unreviewed', was.category ?? null, was.note ?? null, was.reviewed_at ?? null, r.in_tx);
    db.prepare('UPDATE purch_reimbursement SET unlinked_at = ?, unlink_reason = ? WHERE id = ?').run(at, why, r.id);
    return { id: r.id, note: `${r.id} untied: ${r.in_tx} is back to how it was reviewed, and its expenses wait again.` };
  },
});

defineCommand({
  name: 'purch_tag_category',
  permission: 'cash.write',
  title: 'Tax tag', group: 'Purchases', scope: 'collection',
  summary: 'Tag a category for tax time (medical, charitable, business, home office, education, childcare), or clear its tag. The year summary totals tagged spending and lists rows without a receipt.',
  doctrine: `The tag is the person's word on what their category is, never yours on what is deductible: ask,
then tag. Clear it with tag none. Saybooks totals; it does not advise.`,
  effects: ['category tagged, or its tag cleared'],
  args: {
    category: { ...f.text('The category, as the person uses it.'), required: true },
    tag:      { ...f.pick([...V.TAX_TAGS, 'none'], 'What it is at tax time; none clears it.'), required: true },
    reason:   f.text('What the person said.'),
  },
  handler(a, { db, at, actor }) {
    const cat = String(a.category || '').trim(); if (!cat) throw new Rejected('Say which category.');
    const used = db.prepare('SELECT COUNT(*) n FROM purch_transaction WHERE category = ? COLLATE NOCASE').get(cat).n;
    if (!used) throw new Rejected(`No row carries the category "${cat}". Tag a category in use (purch_vocabulary lists them).`);
    if (a.tag === 'none') { db.prepare('DELETE FROM purch_category_tag WHERE category = ? COLLATE NOCASE').run(cat); return { category: cat, tag: null, note: `"${cat}" no longer carries a tax tag.` }; }
    db.prepare('INSERT INTO purch_category_tag (category,tag,reason,set_by,set_at) VALUES (?,?,?,?,?) ON CONFLICT(category) DO UPDATE SET tag = excluded.tag, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at')
      .run(cat, a.tag, a.reason || null, actor || null, at);
    return { category: cat, tag: a.tag, rows: used, note: `"${cat}" is tagged ${a.tag.replace('_', ' ')}: ${used} row${used === 1 ? '' : 's'} count toward it in the year summary.` };
  },
});

read({ name: 'purch_reimbursements', title: 'Paid back', summary: 'Work expenses waiting to be paid back (with how long; a long wait named), and the money that paid them back.',
  args: { as_of: f.date('') }, handler: (a) => V.reimbursements(a) });
read({ name: 'purch_year', title: 'The year', summary: 'A year as the record has it: spending by tax tag net of refunds and of what was paid back, rows in a tagged category with no receipt, interest paid on cards and loans and interest earned, fees, and expenses still waiting to be paid back. Totals, not tax advice.',
  args: { year: f.text('e.g. 2026. Defaults to this year.') }, handler: (a) => V.year(a) });
