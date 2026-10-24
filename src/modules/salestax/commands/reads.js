'use strict';
const { defineCommand, f } = require('../../../registry.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Sales tax read', ...def });

read({ name: 'tax_return', title: 'Sales tax return', summary: 'The return for a period: taxable and non-taxable sales, the tax charged by rate, the tax given back on credits, what is due, and changes to periods already filed.',
  args: { period: f.text('A month (2026-09), a quarter (2026-Q3) or a year.'), from: f.date('Or the first day.'), to: f.date('And the last day.'), currency: f.text('Only when the books hold more than one.') },
  handler: (a) => V.taxReturn(a) });
read({ name: 'tax_liability', title: 'Sales tax owed', summary: 'Sales tax owed as of a day, beside Sales Tax Payable in the books, and each month: due, filed, paid, or not filed.',
  args: { as_of: f.date('The day. Defaults to today.') }, handler: (a) => V.liability(a) });
read({ name: 'tax_filings', title: 'Filings', summary: 'Every filed return: the period, what was filed and paid, and whether the record has changed since.', args: {}, handler: () => V.filings() });
read({ name: 'tax_get_filing', title: 'Filing', summary: 'One filed return with its kept figures and payments.', args: { filing_id: { ...f.text('e.g. TF-0001.'), required: true } }, handler: (a) => V.filingView(a.filing_id) });
