'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'purch_declare_subscription',
  permission: 'cash.write',
  title: 'Declare subscription', group: 'Purchases', subject: 'purch_subscription', scope: 'collection',
  summary: 'Declare a recurring charge from one you have seen. The record then confirms it period by period.',
  doctrine: 'Declared, then confirmed (P-6): every period from the start date is matched against the vendor\'s charges within a tolerance; a period with none shows as missed, two in a row make it lapsed. Never declare one the person has not confirmed exists.',
  effects: ['subscription declared active'],
  args: {
    vendor: { ...f.text('The vendor\'s proper name; created if new.'), required: true },
    cadence: { ...f.pick(['weekly', 'monthly', 'yearly'], 'How often it charges.'), required: true },
    amount: { ...f.money('Expected charge, positive.'), required: true },
    currency: { ...f.text('ISO 4217 code.'), required: true },
    start: f.date('First expected charge. Defaults to the earliest matching charge on record, else today.'),
    tolerance_bp: f.int('How far a charge may drift and still count, in basis points. Default 1000 (10%).'),
    reason: f.text('Why — part of the record.'),
  },
  handler(a, { db, at }) {
    const name = a.vendor.trim(); if (!name) throw new Rejected('A vendor needs a name.');
    if (!Number.isInteger(a.amount) || a.amount <= 0) throw new Rejected('amount is a positive whole number of minor units.');
    const cur = String(a.currency).toUpperCase(); if (!H.CUR_RE.test(cur)) throw new Rejected('currency is a three-letter ISO 4217 code.');
    let v = db.prepare('SELECT * FROM purch_vendor WHERE name = ? COLLATE NOCASE').get(name);
    if (!v) { const id = H.nextId('V', 'purch_vendor'); db.prepare('INSERT INTO purch_vendor (id,name,created_at) VALUES (?,?,?)').run(id, name, at); v = { id, name }; }
    const tol = Math.round(a.amount * (a.tolerance_bp ?? 1000) / 10000);
    const dup = db.prepare("SELECT id, amount FROM purch_subscription WHERE vendor_id = ? AND currency = ? AND cadence = ? AND status = 'active'").all(v.id, cur, a.cadence).find(s => Math.abs(s.amount - a.amount) <= tol);
    if (dup) throw new Rejected(`${v.name} already has an active ${a.cadence} subscription at about this amount (${dup.id}). Cancel it with a reason before declaring another; a different plan (other cadence or amount) is a separate subscription.`);
    const first = db.prepare("SELECT MIN(date) d FROM purch_transaction WHERE vendor_id = ? AND currency = ? AND amount < 0 AND ABS(-amount - ?) <= ?").get(v.id, cur, a.amount, tol).d;
    const start = a.start || first || at.slice(0, 10);
    const id = H.nextId('SUB', 'purch_subscription');
    db.prepare('INSERT INTO purch_subscription (id,vendor_id,cadence,amount,currency,tolerance_bp,start,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, v.id, a.cadence, a.amount, cur, a.tolerance_bp ?? 1000, start, 'active', at, at);
    return V.subscriptionView(id);
  },
});

defineCommand({
  name: 'purch_cancel_subscription',
  permission: 'cash.write',
  title: 'Cancel subscription', group: 'Purchases', subject: 'purch_subscription',
  summary: 'Record that a subscription was cancelled, with a reason. Periods after the cancellation are no longer expected.',
  doctrine: 'Cancelled is a fact the person states, not something the module infers: a subscription that stops charging shows as lapsed on its own, and stays that way until the person says it was cancelled. Record when, if they know, in the reason.',
  effects: ['subscription cancelled'],
  guards: [ (s) => s.status !== 'cancelled' || `${s.id} is already cancelled.` ],
  args: { subscription_id: { ...f.text('The subscription, e.g. SUB-0001.'), required: true }, reason: { ...f.text('Why, and when if you know.'), required: true } },
  handler(a, { db, at }) {
    const s = H.need('purch_subscription', a.subscription_id, 'subscription');
    if (s.status === 'cancelled') throw new Rejected(`${s.id} is already cancelled.`);
    db.prepare("UPDATE purch_subscription SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(a.reason, at, s.id);
    return V.subscriptionView(s.id);
  },
});
