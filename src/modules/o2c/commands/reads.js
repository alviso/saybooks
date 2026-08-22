'use strict';
const { defineCommand, f, nextActions } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Read', ...def });

read({ name: 'o2c_get_order', title: 'Order', summary: 'Full order: lines, open and uninvoiced quantities, deliveries, invoices, and what can be done to it now.',
  args: { order_id: { ...f.ref('order', 'The order.'), required: true } },
  handler: (a) => ({ ...V.orderView(a.order_id), next_actions: nextActions('order', a.order_id).actions }) });

read({ name: 'o2c_get_customer', title: 'Customer', summary: 'Customer with live credit position: limit, open AR, committed value, available.',
  args: { customer_id: { ...f.ref('customer', 'The customer.'), required: true } },
  handler: (a) => V.customerView(a.customer_id) });

read({ name: 'o2c_get_invoice', title: 'Invoice', summary: 'Invoice with lines and what is still open on it.',
  args: { invoice_id: { ...f.ref('invoice', 'The invoice.'), required: true } },
  handler: (a) => V.invoiceView(a.invoice_id) });

read({ name: 'o2c_backorders', title: 'Backorders', summary: 'Every open confirmed quantity, by order, item and customer — what we owe whom.',
  doctrine: 'The honest ends of a backorder are fulfilment or close-short; this view is where you find the ones waiting for either.',
  args: {},
  handler: () => V.backorders().map(r => ({ ...r, value: r.open_qty * r.unit_price, value_display: H.money(r.open_qty * r.unit_price) })) });

read({ name: 'o2c_customer_statement', title: 'Customer statement', summary: 'One customer, period-bounded: opening balance, invoices, credits, payments, refunds, closing balance.',
  doctrine: 'Balance-forward style — the document a controller sends monthly. Rendering and sending are out of scope; the content is not.',
  args: {
    customer_id: { ...f.ref('customer', 'The customer.'), required: true },
    from: { ...f.date('Period start.'), required: true },
    to:   { ...f.date('Period end.'), required: true },
  },
  handler: (a) => V.customerStatement(a.customer_id, a.from, a.to) });

read({ name: 'o2c_ar_aging', title: 'AR aging', summary: 'Open receivables bucketed by days past due, with the invoice-level detail behind each bucket.',
  doctrine: 'The report to open when asked how the business is doing on cash. Buckets are current / 1-30 / 31-60 / 61-90 / 90+ against the invoice due date.',
  args: { as_of: f.date('As-of date. Defaults to today.') },
  handler: (a) => V.arAging(a.as_of || H.today()) });

read({ name: 'o2c_unapplied_cash', title: 'Unapplied cash', summary: 'Payments received that no invoice claims yet.',
  args: {}, handler: () => V.unappliedCash().map(p => ({ ...p, unapplied_display: H.money(p.unapplied) })) });
