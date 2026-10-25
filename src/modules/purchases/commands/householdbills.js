'use strict';
/**
 * Household bills (purchases 0.9): vendors whose bill comes every period, so a missing or unusually
 * high one is named (P-23); autopay, a person's standing approval for one vendor's bills (P-24); and
 * what is due in the coming weeks beside the cash (P-25).
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');
const { vendorFor } = require('./bills.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Bills read', ...def });

defineCommand({
  name: 'purch_declare_bill_series',
  permission: 'cash.write',
  title: 'Expect a bill', group: 'Purchases', subject: 'purch_bill_series', scope: 'collection',
  summary: 'Say a vendor\'s bill comes every period (the electric bill, the phone, insurance), so a missing one, or one well above the usual amount, is named.',
  doctrine: `When the person says a bill comes regularly, declare it once: the vendor as they say it, how often,
the category, and the usual amount if they know it. Its bills are then the vendor's bills on record; the usual
amount comes from them once there are a few. Never guess a usual amount.`,
  effects: ['bill expected every period from this vendor'],
  args: {
    vendor:         { ...f.text('The vendor, as the person says it.'), required: true },
    cadence:        { ...f.pick(['monthly', 'quarterly', 'yearly'], 'How often it comes.'), required: true },
    category:       f.text('What it is for, in the person\'s words.'),
    currency:       f.text('ISO 4217 code; the default currency when left out.'),
    typical_amount: f.money('What it usually is, if the person says.'),
    due_day:        f.int('The day of the month it is usually due, if the person says.'),
    reason:         f.text('What the person said.'),
  },
  handler(a, { db, at, actor }) {
    const name = String(a.vendor || '').trim(); if (!name) throw new Rejected('Say which vendor.');
    const cur = a.currency ? String(a.currency).toUpperCase() : (H.locale().currency || 'USD');
    if (!H.CUR_RE.test(cur)) throw new Rejected('currency is a three-letter ISO 4217 code.');
    if (a.due_day != null && (!Number.isInteger(a.due_day) || a.due_day < 1 || a.due_day > 31)) throw new Rejected('due_day is 1 to 31.');
    if (a.typical_amount != null && (!Number.isInteger(a.typical_amount) || a.typical_amount <= 0)) throw new Rejected('typical_amount is whole cents, more than zero.');
    const v = vendorFor(db, name, at);
    const have = V.activeSeriesFor(v.id);
    if (have) throw new Rejected(`${v.name}'s bill is already expected (${have.id}, ${have.cadence}).`);
    const id = H.nextId('BS', 'purch_bill_series');
    db.prepare('INSERT INTO purch_bill_series (id,vendor_id,cadence,category,currency,typical_amount,due_day,reason,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, v.id, a.cadence, a.category ? String(a.category).trim() : null, cur, a.typical_amount ?? null, a.due_day ?? null, a.reason || null, actor || null, at, at);
    return { ...V.seriesView(id), note: `Expecting ${v.name}'s bill ${a.cadence} as ${id}.` };
  },
});

defineCommand({
  name: 'purch_end_bill_series',
  permission: 'cash.write',
  title: 'Stop expecting', group: 'Purchases', subject: 'purch_bill_series',
  summary: 'Stop expecting a vendor\'s bill (moved, cancelled, switched provider), with a reason. Its bills stay on record.',
  doctrine: 'Only when the person says the bill has stopped. Autopay ends with it.',
  effects: ['bill no longer expected; autopay ended'],
  guards: [ (sr) => sr.status === 'active' || `${sr.id} has already ended.` ],
  args: { series_id: { ...f.ref('purch_bill_series', 'e.g. BS-0001.'), required: true }, reason: { ...f.text('Why it stopped.'), required: true } },
  handler(a, { db, at }) {
    const sr = H.need('purch_bill_series', a.series_id, 'bill series');
    if (sr.status !== 'active') throw new Rejected(`${sr.id} has already ended.`);
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Ending it needs a reason.');
    db.prepare("UPDATE purch_bill_series SET status = 'ended', end_reason = ?, autopay_account_id = NULL, updated_at = ? WHERE id = ?").run(why, at, sr.id);
    return V.seriesView(sr.id);
  },
});

defineCommand({
  name: 'purch_set_autopay',
  permission: 'cash.write',
  title: 'Autopay', group: 'Purchases', subject: 'purch_bill_series',
  human_only: 'Letting a vendor take its bills from an account on its own is the person\'s standing decision to pay them.',
  summary: 'Put a vendor\'s bills on autopay from one account, or take them off. Its bills then count as approved by this standing decision, and say so.',
  doctrine: 'A person sets autopay in the app, whatever an agent\'s role: it approves paying every bill of that vendor ahead. An agent records the bills, and the payments when the statement shows them.',
  effects: ['vendor\'s bills approved ahead from one account, or no longer'],
  guards: [ (sr) => sr.status === 'active' || `${sr.id} has ended.` ],
  args: {
    series_id:  { ...f.ref('purch_bill_series', 'The expected bill, e.g. BS-0001.'), required: true },
    account_id: f.ref('purch_account', 'The account it is paid from. Leave out with off to stop autopay.'),
    off:        f.bool('Stop autopay.'),
    reason:     { ...f.text('What the person decided.'), required: true },
  },
  handler(a, { db, at, actor }) {
    const sr = H.need('purch_bill_series', a.series_id, 'bill series');
    if (sr.status !== 'active') throw new Rejected(`${sr.id} has ended.`);
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Autopay needs a reason.');
    if (a.off) {
      db.prepare('UPDATE purch_bill_series SET autopay_account_id = NULL, autopay_set_by = ?, autopay_set_at = ?, autopay_reason = ?, updated_at = ? WHERE id = ?').run(actor || null, at, why, at, sr.id);
      return { ...V.seriesView(sr.id), note: `Autopay off for ${V.seriesView(sr.id).vendor}; its bills wait for approval again.` };
    }
    const acc = H.need('purch_account', a.account_id, 'account');
    if (!['checking', 'savings', 'credit_card'].includes(acc.kind)) throw new Rejected(`${acc.id} is a ${acc.kind.replace('_', ' ')} account; autopay comes from a bank account or a card.`);
    if (acc.currency !== sr.currency) throw new Rejected(`${acc.id} is in ${acc.currency}; the bill is in ${sr.currency}.`);
    db.prepare('UPDATE purch_bill_series SET autopay_account_id = ?, autopay_set_by = ?, autopay_set_at = ?, autopay_reason = ?, updated_at = ? WHERE id = ?').run(acc.id, actor || null, at, why, at, sr.id);
    const v = V.seriesView(sr.id);
    return { ...v, note: `${v.vendor} on autopay from ${acc.name}: its bills count as approved by this decision from now on.` };
  },
});

read({ name: 'purch_bill_series', title: 'Expected bills', summary: 'Each bill that comes every period: its usual amount from its own history, when the next is expected, whether one is missing or unusually high, and autopay. With series_id: that one with its bills.',
  args: { series_id: f.text('One, e.g. BS-0001.'), as_of: f.date('') }, handler: (a) => a.series_id ? V.seriesView(a.series_id, a.as_of || undefined) : V.billSeries(a) });
read({ name: 'purch_upcoming', title: 'What is due', summary: 'Everything on record due in the next weeks (bills, card payments, loan payments, subscriptions, expected bills not received yet) by date, beside the cash on the latest bank statements. Nothing unrecorded is assumed.',
  args: { days: f.int('How far ahead. Defaults to 30.'), as_of: f.date('From which day. Defaults to today.') }, handler: (a) => V.upcoming(a) });
