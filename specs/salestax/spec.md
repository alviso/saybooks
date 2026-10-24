# salestax — Sales Tax · Area Specification

**Status: 0.1.** The sales tax return for a period, from what was invoiced and credited: taxable and
non-taxable sales, the tax charged at each rate, the tax given back on credits, and what is due. Then
the filing a person records, the payment that follows, and the liability in the books beside it.
Invoices already carry their tax; this closes the loop.

## 1. Calibration: who this is for

A small business that charges sales tax and files monthly or quarterly with one agency. The owner
wants the return's numbers without building a spreadsheet: what was sold, what was taxed, what came
back, what is due. The accountant wants a filed period to stay what was filed, and anything that
changed it afterwards to be named.

## 2. Scope

In: the return for a month, a quarter or a year; credit notes giving back the tax inside them;
recording a filing (a person's act) and its payment; the liability against Sales Tax Payable in the
books; changes to filed periods carried to the next return.

Out (§9): several agencies or jurisdictions per space, determining rates (the rate on each line is
the one the invoice charged), exemption certificates, bad-debt relief, use tax on purchases, and
filing with an agency.

## 3. Entities and lifecycles

- **return**: derived, never stored, for a period: the invoices issued in it (o2c and solo, through
  their api) line by line, as charged; the credit notes raised in it with the tax inside each. A
  write-off gives no tax back.
- **filing**: recorded by a person once the return was filed with the agency: the period, the
  amount filed, the day, the agency and its confirmation. The return is kept as it stood, with a
  hash. A filed amount that differs from the return needs a reason. Filed periods never overlap.
- **payment**: recorded after it happened, against a filing, never more than it still owes. It
  clears the liability and is money out of the bank: it waits in the bank reconciliation until the
  statement shows it.

## 4. The acts

Writes: record_filing (a person's act), record_payment.

Reads: return (a period's figures and changes to filed periods), liability (owed as of a day, beside
the books, and each month's standing), filings.

## 5. Invariants

- **TAX-1** Money is integer cents; the tax on each line is what the invoice charged, never
  recomputed.
- **TAX-2** A period's tax due is the tax charged on invoices issued in it, less the tax inside
  credit notes raised in it; a write-off gives none back.
- **TAX-3** Recording a filing is a person's act, with a reason, refused to an agent whatever its
  role.
- **TAX-4** A filing keeps the return as it stood; a later change to a filed period shows as changed
  since and is named on the next return, never a silent rewrite.
- **TAX-5** A filed amount that differs from the return needs a reason; a period not yet ended
  cannot be filed; filed periods never overlap.
- **TAX-6** Payments are recorded, never made; they never exceed what the filing still owes, and
  they wait in the bank reconciliation like any recorded payment.
- **TAX-7** Sales Tax Payable in the books equals tax charged, less tax given back, less payments;
  a difference is named.
- **TAX-8** Every write is a logged command with an actor; refusals are logged too.

## 6. Required read models

return (gross, non-taxable, taxable, by rate, credits, due, changes to filed periods, whether filed),
liability (owed, the books, ties, months with their state), filings (filed, paid, balance, changed
since).

## 7. Contract vs freedom

Contract: tax as charged, credits giving tax back, the person's filing kept as it stood, payments
recorded not made, a liability that ties. Freedom: how often to file, the agency's name.

## 8. Conformance (scenarios)

01 a month's return: taxable and non-taxable sales and the tax due · 02 the agent cannot record a
filing · 03 the liability ties to the books · 04 a payment needs a filing. The person's filing, the
payment, the credit giving tax back and the changed-since check are contract gate 21, because
scenarios run as an agent.

## 9. Out of scope, on purpose

Several jurisdictions in one space, rate lookup by address, exemption certificates, bad-debt relief,
use tax on purchases, and filing itself: these books record what the person filed and paid, and
never contact an agency.
