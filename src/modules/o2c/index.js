'use strict';
/**
 * o2c — order to cash: quote -> order -> shipment -> invoice -> cash application.
 * Owns the documents; master data belongs to core. Stock depletion goes through
 * core.adjustStock — the contract test will fail this module if it ever writes
 * a core-owned table directly.
 */
const R = require('../../registry.js');
const V = require('./views.js');
const H = require('../../db.js');

const mod = R.defineModule({
  name: 'o2c', prefix: 'o2c',
  tables: ['quote', 'quote_line', 'order', 'order_line', 'delivery', 'delivery_line',
           'invoice', 'invoice_line', 'payment', 'payment_application'],
  ids: { quote: 'Q-0001', order: 'SO-0001', delivery: 'D-0001', invoice: 'INV-0001', payment: 'P-0001', credit_note: 'CN-0001', return: 'R-0001', refund: 'RF-0001' },
  // The conformance contract: spec act -> command, and spec arg name -> command arg name.
  // Scenario files speak in acts; the runner translates through this map, which is also
  // what the Spec tab and core_spec_status derive implementation status from.
  implements: {
    area: 'o2c', spec: '0.2',
    argmap: { customer: 'customer_id', order: 'order_id', quote: 'quote_id', invoice: 'invoice_id',
              payment: 'payment_id', credit_note: 'credit_note_id', item: 'item_id', order_line: 'order_line_id' },
    acts: {
      create_quote: 'o2c_create_quote', send_quote: 'o2c_send_quote', accept_quote: 'o2c_accept_quote',
      create_order: 'o2c_create_order', amend_order: 'o2c_amend_order', confirm_order: 'o2c_confirm_order',
      cancel_order: 'o2c_cancel_order', close_short: 'o2c_close_short',
      fulfil_order: 'o2c_ship_order', invoice_fulfilled: 'o2c_invoice_shipped', void_invoice: 'o2c_void_invoice',
      record_return: 'o2c_record_return', create_credit_note: 'o2c_create_credit_note', write_off: 'o2c_write_off',
      record_payment: 'o2c_record_payment', apply_payment: 'o2c_apply_payment', apply_credit: 'o2c_apply_credit',
      refund: 'o2c_refund',
      order: 'o2c_get_order', customer_position: 'o2c_get_customer', invoice: 'o2c_get_invoice',
      backorders: 'o2c_backorders', ar_aging: 'o2c_ar_aging', unapplied_cash: 'o2c_unapplied_cash',
      customer_statement: 'o2c_customer_statement',
      journal: 'core_journal',
    },
  },
  lifecycles: {
    quote: 'draft -> sent -> accepted (raises a draft order) | expired',
    order: 'draft -> confirmed (credit gate) -> shipped -> closed (fully invoiced) | cancelled',
    invoice: 'open -> paid | void',
    payment: 'recorded as unapplied cash, then applied to invoices; the remainder stays unapplied',
  },
  rules: [
    'Credit is checked once, at confirmation, against open AR plus uninvoiced confirmed value.',
    'We bill what shipped, never what was ordered. Partial shipment produces partial invoice.',
    'Stock cannot go negative. A short ship leaves the balance open on the order.',
    'Recording cash and applying cash are separate acts. Unapplied cash is a valid state.',
  ],
  doctrine: `The credit check at o2c_confirm_order is a gate, not a suggestion. If it refuses,
report the shortfall and stop — raising a limit, splitting an order, or invoicing early to free
credit are decisions for a person. We bill what shipped, never what was ordered. If you do not
know which invoice a payment settles, leave it unapplied; that is a correct, visible state.`,
  search: (like) => ({
    quotes:   H.db().prepare('SELECT id,customer_id,status FROM quote WHERE id LIKE ? LIMIT 10').all(like),
    orders:   H.db().prepare('SELECT id,customer_id,status,po_ref FROM "order" WHERE id LIKE ? OR po_ref LIKE ? LIMIT 10').all(like, like),
    invoices: H.db().prepare('SELECT id,customer_id,status,total FROM invoice WHERE id LIKE ? LIMIT 10').all(like),
    payments: H.db().prepare('SELECT id,customer_id,amount,reference FROM payment WHERE id LIKE ? OR reference LIKE ? LIMIT 10').all(like, like),
    credit_notes: H.db().prepare('SELECT id,customer_id,kind,total,reason FROM credit_note WHERE id LIKE ? OR reason LIKE ? LIMIT 10').all(like, like),
  }),
  api: { views: V },
});

// Subjects: the entities availableFor()/next_actions can evaluate. Declared here, by the
// module that owns the read model — no central map to drift.
R.defineSubject('order',    { load: V.orderView,   ctx: (o) => ({ customer: H.get('customer', o.customer_id) }) });
R.defineSubject('quote',    { load: V.quoteView });
R.defineSubject('invoice',  { load: V.invoiceView });
R.defineSubject('payment',  { load: (id) => H.need('payment', id, 'payment') });
R.defineSubject('customer', { load: V.customerView });   // credit position is o2c semantics
R.defineSubject('item',        { load: (id) => H.need('item', id, 'item') });
R.defineSubject('credit_note', { load: V.creditNoteView });

R.inModule(mod, () => {
  require('./commands/quote.js');
  require('./commands/order.js');
  require('./commands/fulfilment.js');
  require('./commands/billing.js');
  require('./commands/cash.js');
  require('./commands/credits.js');
  require('./commands/reads.js');
});

module.exports = mod.api;
