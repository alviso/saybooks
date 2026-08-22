'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'o2c_record_payment',
  permission: 'cash.write',
  title: 'Record payment', group: 'Cash', subject: 'payment', scope: 'collection',
  summary: 'Record cash received from a customer.',
  doctrine: `Recording the receipt and deciding what it settles are two acts, and this is only the
first. A payment that arrives without a remittance advice sits as unapplied cash — which is the
correct state, and visible in o2c_unapplied_cash. Never guess which invoice a payment is for to
make the aging look tidy.`,
  effects: ['payment recorded as unapplied cash'],
  args: {
    customer_id: { ...f.ref('customer', 'Who paid.'), required: true },
    amount:      { ...f.money('Amount received.'), required: true },
    method:      f.pick(['ach', 'wire', 'check', 'card'], 'How it arrived.'),
    reference:   f.text('Check number, wire reference, remittance id — exactly as printed.'),
    received_at: f.date('Value date. Defaults to today.'),
  },
  handler(a, { db, at }) {
    H.need('customer', a.customer_id, 'customer');
    if (a.amount <= 0) throw new Rejected('A payment must be positive. A refund is its own act.');
    const id = H.nextId('P', 'payment');
    db.prepare('INSERT INTO payment (id,customer_id,amount,method,reference,received_at) VALUES (?,?,?,?,?,?)')
      .run(id, a.customer_id, a.amount, a.method || null, a.reference || null, a.received_at || at.slice(0, 10));
    return { ...H.get('payment', id), amount_display: H.money(a.amount), unapplied_display: H.money(a.amount) };
  },
});

defineCommand({
  name: 'o2c_apply_payment',
  permission: 'cash.write',
  title: 'Apply to invoice', group: 'Cash', subject: 'payment',
  summary: 'Apply some or all of a payment to an invoice.',
  doctrine: `Bounded on both sides: never more than the payment has left, never more than the
invoice still owes. Both refusals name the actual numbers, so the right next step is obvious.

Overpayment is real and stays as unapplied cash against the customer. Do not spread it across
invoices the customer did not name.`,
  effects: ['application recorded', 'invoice.status -> paid when fully settled'],
  guards: [ (p) => V.paymentUnapplied(p) > 0 || 'This payment is fully applied.' ],
  args: {
    payment_id: { ...f.ref('payment', 'The payment.'), required: true },
    invoice_id: { ...f.ref('invoice', 'The invoice it settles.'), required: true },
    amount:     f.money('How much to apply. Omit to apply the smaller of what is left on each side.'),
  },
  handler(a, { db }) {
    const p = H.need('payment', a.payment_id, 'payment');
    const inv = H.need('invoice', a.invoice_id, 'invoice');
    if (inv.status === 'void') throw new Rejected(`Invoice ${inv.id} is void.`);
    if (inv.customer_id !== p.customer_id) {
      throw new Rejected(`Payment ${p.id} is from ${H.get('customer', p.customer_id).name} but invoice ${inv.id} belongs to ${H.get('customer', inv.customer_id).name}. Cash is not transferable between customers.`);
    }
    const payLeft = V.paymentUnapplied(p);
    const invLeft = inv.total - V.invoiceApplied(inv.id);
    if (payLeft <= 0) throw new Rejected(`Payment ${p.id} is fully applied.`);
    if (invLeft <= 0) throw new Rejected(`Invoice ${inv.id} is already settled.`);
    const amount = a.amount ?? Math.min(payLeft, invLeft);
    if (amount <= 0) throw new Rejected('Applied amount must be positive.');
    if (amount > payLeft) throw new Rejected(`Payment ${p.id} has only ${H.money(payLeft)} left to apply; you asked for ${H.money(amount)}.`);
    if (amount > invLeft) throw new Rejected(`Invoice ${inv.id} owes only ${H.money(invLeft)}; you asked to apply ${H.money(amount)}. The remainder stays as unapplied cash.`);

    db.prepare('INSERT INTO payment_application (payment_id,invoice_id,amount) VALUES (?,?,?)').run(p.id, inv.id, amount);
    if (V.invoiceApplied(inv.id) >= inv.total) db.prepare("UPDATE invoice SET status = 'paid' WHERE id = ?").run(inv.id);
    return { applied: H.money(amount), payment_unapplied: H.money(V.paymentUnapplied(H.get('payment', p.id))), invoice: V.invoiceView(inv.id) };
  },
});

defineCommand({
  name: 'o2c_apply_credit',
  permission: 'cash.write',
  title: 'Apply credit to invoice', group: 'Cash', subject: 'credit_note',
  summary: 'Apply some or all of a credit note to an invoice.',
  doctrine: `Same bounds as cash: never more than the credit note has left, never more than the
invoice still owes, never across customers. A credit note the customer wants paid out instead
is a refund, not an application.`,
  effects: ['application recorded', 'invoice.status -> paid when fully settled', 'credit_note.status -> settled when exhausted'],
  guards: [ (cn) => V.creditUnapplied(cn) > 0 || 'This credit note is fully used.' ],
  args: {
    credit_note_id: { ...f.ref('credit_note', 'The credit note.'), required: true },
    invoice_id:     { ...f.ref('invoice', 'The invoice it settles.'), required: true },
    amount:         f.money('How much to apply. Omit to apply the smaller of what is left on each side.'),
  },
  handler(a, { db }) {
    const cn = H.need('credit_note', a.credit_note_id, 'credit note');
    const inv = H.need('invoice', a.invoice_id, 'invoice');
    if (inv.status === 'void') throw new Rejected(`Invoice ${inv.id} is void.`);
    if (inv.customer_id !== cn.customer_id) {
      throw new Rejected(`Credit note ${cn.id} belongs to ${H.get('customer', cn.customer_id).name} but invoice ${inv.id} belongs to ${H.get('customer', inv.customer_id).name}. Credit is not transferable between customers.`);
    }
    const cnLeft = V.creditUnapplied(cn);
    const invLeft = inv.total - V.invoiceApplied(inv.id);
    if (cnLeft <= 0) throw new Rejected(`Credit note ${cn.id} is fully used.`);
    if (invLeft <= 0) throw new Rejected(`Invoice ${inv.id} is already settled.`);
    const amount = a.amount ?? Math.min(cnLeft, invLeft);
    if (amount <= 0) throw new Rejected('Applied amount must be positive.');
    if (amount > cnLeft) throw new Rejected(`Credit note ${cn.id} has only ${H.money(cnLeft)} left; you asked for ${H.money(amount)}.`);
    if (amount > invLeft) throw new Rejected(`Invoice ${inv.id} owes only ${H.money(invLeft)}; you asked to apply ${H.money(amount)}.`);

    db.prepare('INSERT INTO credit_application (credit_note_id,invoice_id,amount) VALUES (?,?,?)').run(cn.id, inv.id, amount);
    if (V.invoiceApplied(inv.id) >= inv.total) db.prepare("UPDATE invoice SET status = 'paid' WHERE id = ?").run(inv.id);
    if (V.creditUnapplied(H.get('credit_note', cn.id)) <= 0) db.prepare("UPDATE credit_note SET status = 'settled' WHERE id = ?").run(cn.id);
    return { applied: H.money(amount), credit_note: V.creditNoteView(cn.id), invoice: V.invoiceView(inv.id) };
  },
});

defineCommand({
  name: 'o2c_refund',
  permission: 'credit.authority',
  title: 'Refund', group: 'Cash', subject: 'payment', scope: 'collection',
  summary: 'Record money returned to the customer against an unapplied payment or credit note balance.',
  doctrine: `Records the fact that money went back; actually moving it is out of scope, like every
other outbound act. Bounded by the unapplied balance of the source instrument — you cannot refund
what is already applied to an invoice without unwinding that application first (which does not
exist yet, on purpose: reverse by credit note instead).`,
  effects: ['refund recorded', 'source unapplied balance reduced', 'credit_note.status -> settled when exhausted'],
  args: {
    source_type: { ...f.pick(['payment', 'credit_note'], 'What the refund draws down.'), required: true },
    source_id:   { ...f.text('The payment or credit note id.'), required: true },
    amount:      { ...f.money('Amount returned.'), required: true },
    method:      f.pick(['ach', 'wire', 'check', 'card'], 'How it went back.'),
    reference:   f.text('Bank reference, exactly as printed.'),
  },
  handler(a, { db, at }) {
    if (a.amount <= 0) throw new Rejected('A refund must be positive.');
    const src = H.need(a.source_type === 'payment' ? 'payment' : 'credit_note', a.source_id, a.source_type);
    const left = a.source_type === 'payment' ? V.paymentUnapplied(src) : V.creditUnapplied(src);
    if (a.amount > left) throw new Rejected(`${src.id} has only ${H.money(left)} unapplied; you asked to refund ${H.money(a.amount)}.`);
    const id = H.nextId('RF', 'refund');
    db.prepare('INSERT INTO refund (id,source_type,source_id,amount,method,reference,recorded_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, a.source_type, a.source_id, a.amount, a.method || null, a.reference || null, at);
    if (a.source_type === 'credit_note' && V.creditUnapplied(H.get('credit_note', src.id)) <= 0) {
      db.prepare("UPDATE credit_note SET status = 'settled' WHERE id = ?").run(src.id);
    }
    return { ...H.get('refund', id), amount_display: H.money(a.amount), source_remaining: H.money(left - a.amount) };
  },
});
