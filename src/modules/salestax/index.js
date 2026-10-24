'use strict';
/**
 * salestax — the sales tax return for a period, derived from what was invoiced (o2c, solo) and
 * credited, the filings a person records, the payments that follow, and the liability in the books
 * beside it. Payments are cash the bank reconciliation matches like any other recorded payment.
 */
const R = require('../../registry.js');
const V = require('./views.js');

const mod = R.defineModule({
  name: 'salestax', prefix: 'tax',
  tables: ['tax_filing', 'tax_payment'],
  ids: { filing: 'TF-0001', payment: 'TP-0001' },
  lifecycles: {
    filing: 'recorded by a person once filed, kept as it stood -> paid (by payments recorded after the fact); shows as changed since when the record moves',
  },
  rules: [
    'The return is derived from invoices and credit notes as they were issued: tax as charged, never recomputed.',
    'A credit gives back the tax inside it; a write-off does not.',
    'Recording a filing is a person\'s act; a filed amount that differs from the return needs a reason.',
    'Filed periods never overlap; a later change to one shows as changed since and goes on the next return.',
    'Payments are recorded, never made, and never exceed what was filed.',
  ],
  doctrine: `Sales tax. The return for a period (tax_return, a month or a quarter) comes from the invoices
issued and the credit notes raised in it: taxable and non-taxable sales, the tax charged at each rate,
the tax given back on credits, and what is due. Read it to the person in plain words. Filing happens on
the agency's site and is the person's; they record it here in the app, and you never do. When they say
they paid, record the payment (tax_record_payment) with the day and the agency's reference; it waits in
the bank reconciliation until the statement shows it. tax_liability says what is owed and whether the
books agree. The rate on each line is the one the invoice charged; determining rates is outside this.`,
  implements: {
    area: 'salestax', spec: '0.1',
    argmap: { filing: 'filing_id' },
    acts: { return: 'tax_return', liability: 'tax_liability', filings: 'tax_filings', record_filing: 'tax_record_filing', record_payment: 'tax_record_payment' },
  },
  api: { views: V, cashMovements: V.cashMovements, journalLines: V.journalLines, unfiledThrough: V.unfiledThrough },
});

R.defineSubject('tax_filing', { load: (id) => V.filingView(id) });

R.inModule(mod, () => {
  require('./commands/filing.js');
  require('./commands/reads.js');
});

module.exports = mod;
