'use strict';
/**
 * The month-end close (gl 0.1): adjusting entries, closing a period, reopening the latest close.
 * Closing and reopening are a person's acts (GL-2).
 */
const crypto = require('crypto');
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (k, v) => { if (!ISO.test(v || '')) throw new Rejected(`${k} must be a date as YYYY-MM-DD; got "${v}".`); };
const reasonOf = (r, what) => { const s = String(r || '').trim(); if (!s) throw new Rejected(`${what} needs a reason.`); return s; };
const firstOfNextMonth = (d) => { const [y, m] = d.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };
const ENTRY_LINE = {
  account: { ...f.text('The account, in the accountant\'s words (Accrued expenses, Depreciation).'), required: true },
  kind:    { ...f.pick(V.KINDS, 'What kind of account it is, so the statements can place it.'), required: true },
  debit:   f.money('Debit.'),
  credit:  f.money('Credit.'),
};

defineCommand({
  name: 'gl_record_entry',
  permission: 'billing.write',
  title: 'New adjusting entry', group: 'Month-end', subject: 'gl_entry', scope: 'collection',
  summary: 'An adjusting entry for the close: an accrual, depreciation, a correction. Balanced, dated in an open period, with a reason. An accrual can reverse itself on the 1st of the next month.',
  doctrine: `Adjusting entries are the accountant's tool: record them when the accountant or the person
gives the figures, never invent an amount. Each line names an account in their words and says
what kind it is (asset, liability, equity, income, expense), with a debit or a credit; the entry
must balance. Mark an accrual to reverse (reverse: true) so it undoes itself on the 1st of the next
month, when the real bill or payment arrives. A period that is already closed takes no entries:
date it in the open period.`,
  effects: ['adjusting entry recorded', 'its reversal on the 1st of the next month, when marked'],
  args: {
    date:    { ...f.date('The day it belongs to, usually the last day of the month.'), required: true },
    memo:    { ...f.text('What it is: "September internet, not billed yet".'), required: true },
    lines:   { ...f.lines(ENTRY_LINE, 'The lines; debits must equal credits.'), required: true },
    reverse: f.bool('An accrual: reverse it on the 1st of the next month.'),
    reason:  { ...f.text('Why, and where the figure comes from.'), required: true },
  },
  handler(a, { db, at, actor }) {
    isDate('date', a.date);
    const last = V.closedThrough();
    if (last && a.date <= last) throw new Rejected(`The books are closed through ${last}. Date the entry after it; a closed period takes no entries.`);
    if (!Array.isArray(a.lines) || a.lines.length < 2) throw new Rejected('An entry needs at least two lines, a debit and a credit.');
    let dr = 0, cr = 0;
    a.lines.forEach((l, i) => {
      const acct = String(l.account || '').trim(); if (!acct) throw new Rejected(`Line ${i + 1} has no account.`);
      if (!V.KINDS.includes(l.kind)) throw new Rejected(`Line ${i + 1} (${acct}): kind is one of ${V.KINDS.join(', ')}.`);
      const d = l.debit || 0, c = l.credit || 0;
      if (d < 0 || c < 0 || (d > 0) === (c > 0)) throw new Rejected(`Line ${i + 1} (${acct}) takes a debit or a credit, one of them, positive.`);
      dr += d; cr += c;
    });
    if (dr !== cr) throw new Rejected(`The entry does not balance: debits ${H.money(dr)}, credits ${H.money(cr)}.`);
    const id = H.nextId('JE', 'gl_entry');
    db.prepare('INSERT INTO gl_entry (id,date,memo,reason,reverse_on,created_by,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, a.date, String(a.memo).trim(), reasonOf(a.reason, 'An adjusting entry'), a.reverse ? firstOfNextMonth(a.date) : null, actor || null, at);
    a.lines.forEach((l, i) => db.prepare('INSERT INTO gl_entry_line (entry_id,pos,account,kind,debit,credit) VALUES (?,?,?,?,?,?)').run(id, i + 1, String(l.account).trim(), l.kind, l.debit || 0, l.credit || 0));
    const e = V.entryView(id);
    return { ...e, note: `Recorded ${id} on ${e.date}: ${e.memo}, ${e.total_display}.${e.reverse_on ? ` It reverses on ${e.reverse_on}.` : ''}` };
  },
});

defineCommand({
  name: 'gl_void_entry',
  permission: 'billing.write',
  title: 'Void entry', group: 'Month-end', subject: 'gl_entry',
  summary: 'Void an adjusting entry in an open period, with a reason. It stays on the record as voided.',
  doctrine: 'Only while its period is open. In a closed period, record the opposite entry in the open period instead.',
  effects: ['entry voided'],
  guards: [
    (e) => !e.voided_at || `${e.id} is already voided.`,
    (e) => !(V.closedThrough() && e.date <= V.closedThrough()) || `${e.id} is in a period closed through ${V.closedThrough()}. Record the opposite entry in the open period instead.`,
  ],
  args: { entry_id: { ...f.text('The entry, e.g. JE-0001.'), required: true }, reason: { ...f.text('Why it is voided.'), required: true } },
  handler(a, { db, at }) {
    const e = H.need('gl_entry', a.entry_id, 'adjusting entry');
    if (e.voided_at) throw new Rejected(`${e.id} is already voided.`);
    const last = V.closedThrough();
    if (last && e.date <= last) throw new Rejected(`${e.id} is in a period closed through ${last}. Record the opposite entry in the open period instead.`);
    db.prepare('UPDATE gl_entry SET voided_at = ?, void_reason = ? WHERE id = ?').run(at, reasonOf(a.reason, 'Voiding an entry'), e.id);
    return { ...V.entryView(e.id), note: `${e.id} voided; it stays on the record.` };
  },
});

defineCommand({
  name: 'gl_close_period',
  permission: 'credit.authority',
  title: 'Close the books', group: 'Month-end', subject: 'gl_close', scope: 'collection',
  human_only: 'Closing the books is the person\'s or the accountant\'s sign-off on what the period says.',
  summary: 'Close the books through a day: the period\'s journal is kept as it stands, and its figures stop moving. Later changes land as corrections in the next open period.',
  doctrine: 'Refused to you whatever your role. Show the person the checklist (gl_checklist): what blocks the close and what is open. They close it in the app.',
  effects: ['period closed; its journal kept with its totals and a hash'],
  args: {
    through: { ...f.date('The last day of the period being closed.'), required: true },
    reason:  { ...f.text('What the close is: "September close, reviewed with Dana".'), required: true },
  },
  handler(a, { db, at, actor }) {
    isDate('through', a.through);
    const last = V.closedThrough();
    if (last && a.through <= last) throw new Rejected(`The books are already closed through ${last}.`);
    if (a.through > H.today()) throw new Rejected(`${a.through} has not ended yet. Close a period once it is over.`);
    const why = reasonOf(a.reason, 'A close');
    const c = V.checklist({ through: a.through });
    if (!c.ready) throw new Rejected(`The books cannot close through ${a.through} yet: ${c.blocking.map(b => b.text).join(' ')}`);
    const j = require('../../core/index.js').journal({ from: last ? H.addDays(last, 1) : undefined, to: a.through });
    const kept = j.entries.map(e => ({ date: e.date, memo: e.memo, customer: e.customer || null, currency: e.currency,
      lines: e.lines.map(l => ({ account: l.account, ...(l.map ? { map: l.map } : {}), ...(l.debit ? { debit: l.debit } : { credit: l.credit }) })) }));
    const hash = crypto.createHash('sha256').update(JSON.stringify(kept)).digest('hex').slice(0, 16);
    const id = H.nextId('CL', 'gl_close');
    db.prepare('INSERT INTO gl_close (id,through,reason,closed_by,closed_at,entry_count,debits,hash) VALUES (?,?,?,?,?,?,?,?)').run(id, a.through, why, actor || null, at, kept.length, j.debits, hash);
    const ins = db.prepare('INSERT INTO gl_closed_entry (close_id,seq,date,memo,customer,currency,lines_json) VALUES (?,?,?,?,?,?,?)');
    kept.forEach((e, i) => ins.run(id, i + 1, e.date, e.memo, e.customer, e.currency, JSON.stringify(e.lines)));
    return { id, through: a.through, entry_count: kept.length, debits: j.debits, debits_display: j.debits_display, hash, open_items: c.open,
      note: `Closed through ${a.through} (${id}): ${kept.length} entries, ${j.debits_display} each side, kept with hash ${hash}. From now on, anything that changes this period lands as a correction on ${H.addDays(a.through, 1)}.` };
  },
});

defineCommand({
  name: 'gl_reopen_period',
  permission: 'credit.authority',
  title: 'Reopen the latest close', group: 'Month-end', subject: 'gl_close', scope: 'collection',
  human_only: 'Reopening a closed period undoes a sign-off; a person decides that, with a reason.',
  summary: 'Reopen the most recent close, with a reason. Its period moves again with the record; the close stays on the record as reopened.',
  doctrine: 'Refused to you whatever your role. Only the latest close can be reopened; earlier ones stay closed.',
  effects: ['latest close reopened'],
  args: { reason: { ...f.text('Why it is reopened.'), required: true } },
  handler(a, { db, at, actor }) {
    const closes = V.activeCloses();
    if (!closes.length) throw new Rejected('Nothing is closed.');
    const c = closes[closes.length - 1];
    db.prepare('UPDATE gl_close SET reopened_at = ?, reopened_by = ?, reopen_reason = ? WHERE id = ?').run(at, actor || null, reasonOf(a.reason, 'Reopening a close'), c.id);
    const now = V.closedThrough();
    return { id: c.id, through: c.through, note: `${c.id} reopened: the period through ${c.through} moves with the record again.${now ? ` The books stay closed through ${now}.` : ''}` };
  },
});
