'use strict';
/**
 * Recording a filed return (a person's act, TAX-3) and the payment that follows (TAX-6). Nothing
 * here files or pays anything: it records what the person did on the agency's site.
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const reasonOf = (r, what) => { const s = String(r || '').trim(); if (!s) throw new Rejected(`${what} needs a reason.`); return s; };
const isDate = (k, v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) throw new Rejected(`${k} is a date, YYYY-MM-DD.`); };

defineCommand({
  name: 'tax_record_filing',
  permission: 'credit.authority',
  title: 'Record a filed return', group: 'Sales tax', subject: 'tax_filing', scope: 'collection',
  human_only: 'Filing a sales tax return is the person\'s signature to the tax agency.',
  summary: 'Record that a sales tax return was filed for a period: what was filed, when, with whom, and the confirmation. The return is kept as it stood.',
  doctrine: 'The person files on the agency\'s site, then records it here: the period, the amount filed, the day and the confirmation. An agent prepares the return (tax_return) and shows it, and is refused this record whatever its role. An amount that differs from the return needs a reason; a later change to a filed period shows as changed since.',
  effects: ['return recorded as filed, kept as it stood with a hash'],
  args: {
    period:            { ...f.text('The period filed: a month (2026-09) or a quarter (2026-Q3).'), required: true },
    filed_amount:      { ...f.money('The amount the return filed says is due.'), required: true },
    filed_on:          { ...f.date('The day it was filed.'), required: true },
    agency:            f.text('Who it was filed with: "California CDTFA".'),
    reference:         f.text('The confirmation number the agency gave.'),
    difference_reason: f.text('Only when the amount filed differs from the return here: why.'),
    reason:            { ...f.text('For the record: "September return, filed online".'), required: true },
  },
  handler(a, { db, at, actor }) {
    const why = reasonOf(a.reason, 'A filing');
    isDate('filed_on', a.filed_on);
    if (a.filed_on > H.today()) throw new Rejected(`${a.filed_on} has not happened yet. Record a filing once it is filed.`);
    const per = V.periodOf({ period: a.period });
    if (per.to >= H.today()) throw new Rejected(`${per.label} has not ended yet. A return is filed once its period is over.`);
    const currency = H.locale().currency || 'USD';
    const clash = V.filingRows().find(r => r.currency === currency && r.period_from <= per.to && r.period_to >= per.from);
    if (clash) throw new Rejected(`${clash.id} already covers ${clash.period_from} to ${clash.period_to}. Periods filed never overlap; a change to a filed period goes on the next return.`);
    if (!Number.isInteger(a.filed_amount) || a.filed_amount < 0) throw new Rejected('filed_amount is whole cents, zero or more.');
    const fig = V.figures(per.from, per.to, currency);
    const diff = a.filed_amount - fig.due;
    const dr = String(a.difference_reason || '').trim();
    if (diff && !dr) throw new Rejected(`The return here says ${H.money(fig.due, currency)} is due for ${per.label}; you filed ${H.money(a.filed_amount, currency)}. Say why they differ (difference_reason), or file the return's amount.`);
    const kept = V.keptOf(fig), hash = V.hashOf(kept);
    const id = H.nextId('TF', 'tax_filing');
    db.prepare('INSERT INTO tax_filing (id,period_from,period_to,label,currency,agency,computed_due,filed_amount,difference_reason,filed_on,reference,kept_json,hash,reason,filed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, per.from, per.to, per.label, currency, a.agency || null, fig.due, a.filed_amount, dr || null, a.filed_on, a.reference || null, JSON.stringify(kept), hash, why, actor || null, at);
    return { ...V.filingView(id), note: `Recorded ${per.label} as filed (${id}): ${H.money(a.filed_amount, currency)}${a.agency ? ` with ${a.agency}` : ''} on ${a.filed_on}${a.reference ? `, confirmation ${a.reference}` : ''}. Kept with hash ${hash}; a later change to ${per.label} will show as changed since.` };
  },
});

defineCommand({
  name: 'tax_record_payment',
  permission: 'cash.write',
  title: 'Record the tax payment', group: 'Sales tax', subject: 'tax_filing',
  summary: 'Record that a filed return was paid: the day, the amount and the reference. It clears the liability, and the bank reconciliation waits for the statement row that shows it.',
  doctrine: `Record a payment after it happened, against the filing it pays, with the day it went and the
agency's reference. Never more than the filing still owes. Nothing here pays anything. The payment
then waits in the bank reconciliation like any recorded payment until the statement shows it.`,
  effects: ['payment recorded against the filing; the liability goes down by it'],
  guards: [ (fl) => { const v = V.filingView(fl.id); return v.balance > 0 || `${fl.id} is fully paid.`; } ],
  args: {
    filing_id: { ...f.ref('tax_filing', 'The filing it pays, e.g. TF-0001.'), required: true },
    amount:    { ...f.money('How much was paid.'), required: true },
    paid_on:   { ...f.date('The day it was paid.'), required: true },
    method:    f.pick(['ach', 'card', 'check', 'other'], 'How it went.'),
    reference: f.text('The agency\'s confirmation for the payment.'),
    reason:    f.text('For the record.'),
  },
  handler(a, { db, at, actor }) {
    const v = V.filingView(a.filing_id);
    isDate('paid_on', a.paid_on);
    if (a.paid_on > H.today()) throw new Rejected(`${a.paid_on} has not happened yet. Record a payment after it went.`);
    if (!Number.isInteger(a.amount) || a.amount <= 0) throw new Rejected('amount is whole cents, more than zero.');
    if (a.amount > v.balance) throw new Rejected(`${v.id} has ${v.balance_display} left to pay; ${H.money(a.amount, v.currency)} is more than that.`);
    const id = H.nextId('TP', 'tax_payment');
    db.prepare('INSERT INTO tax_payment (id,filing_id,amount,currency,paid_on,method,reference,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, v.id, a.amount, v.currency, a.paid_on, a.method || null, a.reference || null, a.reason || null, actor || null, at);
    const after = V.filingView(v.id);
    return { ...after, payment_id: id, note: `Recorded ${id}: ${H.money(a.amount, v.currency)} paid on ${a.paid_on} for ${v.name}${after.balance ? `, ${after.balance_display} still to pay` : ', paid in full'}. It waits in the bank reconciliation until the statement shows it.` };
  },
});
