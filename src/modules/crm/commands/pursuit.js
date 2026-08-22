'use strict';
const R = require('../../../registry.js');
const { defineCommand, f, Rejected } = R;
const H = require('../../../db.js');
const V = require('../views.js');
const core = () => R.MODULES.find(m => m.name === 'core').api;

defineCommand({
  name: 'crm_log_activity',
  title: 'Log activity', group: 'CRM', subject: 'account',
  permission: 'sales.write', guardless: true,
  summary: 'Record a touch: what happened, when it actually happened, with whom.',
  doctrine: `occurred_at is when it happened, which is not when it got typed (CRM-5) — a call
logged three days late is still a call from three days ago, and staleness math depends on the
truth. Interpretation in the summary is yours to write freely; facts inside it trace to
sources (CRM-10).`,
  effects: ['activity recorded'],
  args: {
    account_id:  { ...f.ref('account', 'The account.'), required: true },
    summary:     { ...f.note('What happened, in your own terms.'), required: true },
    occurred_at: { ...f.date('When it actually happened.'), required: true },
    contact_id:  f.text('Who, if a specific person, e.g. P-0001.'),
    direction:   f.pick(['outbound', 'inbound'], ''),
    medium:      f.pick(['call', 'email', 'meeting', 'linkedin', 'other'], ''),
  },
  handler(a, { db, at }) {
    H.need('account', a.account_id, 'account');
    if (a.contact_id) H.need('contact', a.contact_id, 'contact');
    db.prepare(`INSERT INTO activity (account_id,contact_id,direction,medium,summary,occurred_at,recorded_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(a.account_id, a.contact_id || null, a.direction || null, a.medium || null, a.summary, a.occurred_at, at);
    return V.accountView(a.account_id);
  },
});

defineCommand({
  name: 'crm_promote_to_customer',
  title: 'Promote to customer', group: 'CRM', subject: 'account',
  permission: 'sales.write',
  summary: 'Create the core customer from a won account — the bridge from pursuit to trading.',
  doctrine: `Won accounts only, at most once (CRM-8): a second customer for the same account
would be a reconciliation problem wearing a convenience. Creation goes through core's API —
one logged act marking where this area's job ends and order-to-cash begins. The account keeps
its whole pursuit history; the customer starts clean.`,
  effects: ['core customer created', 'account.customer_id linked'],
  guards: [
    (acc) => acc.status === 'won' || `Only a won account promotes — this one is ${acc.status}. Winning is its own act, with its own reason.`,
    (acc) => !acc.customer_id || `Already promoted — this account is customer ${acc.customer_id}.`,
  ],
  args: {
    account_id:   { ...f.ref('account', 'The won account.'), required: true },
    terms:        f.pick(['immediate', 'net15', 'net30', 'net60'], 'Payment terms for the new customer.'),
    credit_limit: f.money('Opening credit limit. 0 (or omitted) means prepay only — a real position, not a missing value.'),
    email:        f.text('Billing email.'),
  },
  handler(a, { db, at }) {
    const acc = H.need('account', a.account_id, 'account');
    if (acc.status !== 'won') throw new Rejected(`Only a won account promotes — this one is ${acc.status}. Winning is its own act, with its own reason.`);
    if (acc.customer_id) throw new Rejected(`Already promoted — this account is customer ${acc.customer_id}.`);
    const customer = core().createCustomer(db, { name: acc.name, email: a.email, terms: a.terms, credit_limit: a.credit_limit }, at);
    db.prepare('UPDATE account SET customer_id = ?, updated_at = ? WHERE id = ?').run(customer.id, at, a.account_id);
    return { ...V.accountView(a.account_id), customer };
  },
});
