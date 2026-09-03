'use strict';
const { defineCommand, f } = require('../../../registry.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Invoicing read', ...def });

read({ name: 'solo_get_invoice', title: 'Invoice', summary: 'The whole document: lines, totals, frozen seller block, what is applied and open, and the shareable doc link.',
  args: { invoice_id: { ...f.text('e.g. INV-0001.'), required: true } },
  handler: (a) => V.invoiceView(a.invoice_id) });

read({ name: 'solo_outstanding', title: 'Outstanding', summary: 'Who owes what: issued, unpaid invoices oldest first, with days overdue and the total open.',
  doctrine: 'This is the morning read. Chasing is the freelancer’s act — the system never sends anything.',
  args: {}, handler: () => V.outstanding() });

read({ name: 'solo_statement', title: 'Statement', summary: 'One client, chronological: every invoice and payment with a running balance.',
  args: { customer_id: { ...f.ref('customer', 'The client.'), required: true } },
  handler: (a) => V.statement(a.customer_id) });
