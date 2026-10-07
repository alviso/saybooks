'use strict';
/**
 * purchases — what you buy, from statements and receipts the AGENT read. The second
 * deliberately PERSONAL area after jobhunt. No parser lives here: the agent hands over rows
 * and the control totals the statement printed; the module keeps the record, checks that it
 * adds up, refuses what does not reconcile, and remembers where every number came from.
 */
const R = require('../../registry.js');
const V = require('./views.js');
const H = require('../../db.js');

const mod = R.defineModule({
  name: 'purchases', prefix: 'purch',
  tables: ['purch_source', 'purch_vendor', 'purch_vendor_alias', 'purch_transaction', 'purch_split', 'purch_receipt', 'purch_subscription', 'purch_rule', 'purch_bill'],
  ids: { source: 'SRC-0001', transaction: 'T-0001', vendor: 'V-0001', receipt: 'R-0001', subscription: 'SUB-0001', rule: 'RL-0001', bill: 'B-0001' },
  lifecycles: {
    source: 'imported whole (reconciled to its control totals) — immutable; the same hash never twice',
    transaction: 'unreviewed -> purchase | recurring | transfer | income | fee | ignored (a reasoned act; amount and date never change) -> optionally split into legs that add to it exactly',
    subscription: 'active (declared) -> cancelled (reasoned); lapsed is DERIVED from two missed periods, never stored',
    receipt: 'unmatched -> matched to exactly one transaction (reasoned) -> unmatched again (reasoned)',
    rule: 'active (suggests a category on matching unreviewed rows) -> ended (reasoned); it never books a row',
    bill: 'open (recorded from what the vendor sent) -> approved (a person only) -> paid (recorded after the fact, linked to its statement row) | rejected (reasoned)',
  },
  rules: [
    'A statement is accepted whole or not at all: rows must reconcile to the printed opening balance, closing balance and row count.',
    'Every transaction traces to a source row and the raw line as read; nothing is edited in place.',
    'The same source hash is never imported twice; rows already present are skipped and listed.',
    'Category, vendor and status are empty until an act with a reason sets them.',
    'A subscription is declared, then confirmed by the record; a missing charge shows as missed, never assumed.',
    'Files never live here — a source or a receipt is its hash and its facts.',
    'A standing rule suggests, never books: matching rows stay unreviewed until a person confirms them.',
    'A bill is a record, never a payment: only a person approves paying it, and a payment is recorded after it happened.',
  ],
  doctrine: `AGENT FIRST. You read the file — bank statement, card statement, receipt photo —
and hand over what it says. The module checks it and keeps it. Nothing here parses.

Importing a statement (purch_import_statement):
- You were handed the file. Pass its lines in text, exactly as you have them, one row per
  line. Do not retype rows into fields: that is where digits slip, and the tool reads the
  lines itself. Dates without a year and a running-balance column are fine.
- State the opening and closing balance the statement prints. The import is refused when
  the rows do not add up to them, and the refusal names the gap; then re-read. Never "fix"
  a line to make it reconcile. row_count only if the statement prints a count.
- The hash is computed from the text. The same statement is refused twice; rows already on
  record (same date, amount, description) are skipped and listed back; say so to the person.

Reviewing: FIRST read purch_vocabulary — the statuses and what they mean, and the person's
own categories and vendors. Propose a status, category and vendor for every row of the
statement from those words, show the person, and once they have answered write it all with
purch_review_batch (one reason). purch_review_transaction is the single-row form. Statuses:
purchase (one-off) / recurring (repeats — rent, streaming, insurance; naming the vendor
declares the subscription) / transfer (their own money moving) / income / fee / ignored. Ask
when unsure; never guess a category — a row you cannot name stays unreviewed.

A transfer still needs to say WHERE the money went, as its category: savings, owner draw, the
card being paid off. That is how the ledger's bank balance keeps tying to the statement. The
one time to leave it blank is money already recorded elsewhere in these books — a client
payment against an invoice you already issued — which must not be counted twice; those rows
are then listed, every time, as not posted. purch_set_vendor names
the shop once and its statement spelling becomes an alias for every later row.

Splitting: one line is often several things — a payroll run is wages, employer taxes and the
processor's fee. purch_split_transaction takes the legs; they must add to the row exactly, and
the row's own amount, date and provenance never move. The breakdown comes from the person or a
document they have; never invent it.

Receipts: purch_add_receipt with what the receipt says (vendor, date, total, currency) and the
file's name and hash; candidates come back. purch_match_receipt is a reasoned act and is
refused when the total does not fit — say why if it truly does (override).

Standing rules: when the person says something ahead of time ("the next five days are the Texas
conference, book it to travel"), record it with purch_add_rule, real dates in place of relative
ones. Matching rows then carry a suggestion (purch_transactions shows it as suggested; the
import result counts them). A rule never books: propose its suggestions with the rest of the
review, and once the person confirms, write them with purch_accept_suggestions or in the batch.

Bills: a vendor's invoice the person was sent goes in with purch_add_bill, as printed. Only a
person approves paying it; tell them it is waiting and show purch_payables (what is due against
the cash on the latest statement). When they say they paid it, record the payment with the day
it went and link the statement row that shows it. Nothing here pays anything.

Subscriptions: purch_declare_subscription from a charge you have seen; the record then
confirms it month by month. A missed period is shown, never assumed; two make it lapsed.
Money is integer minor units; sums are per currency and never cross.`,
  env_acts: { import_statement: 'purch_import_statement', review_batch: 'purch_review_batch', review_transaction: 'purch_review_transaction', set_vendor: 'purch_set_vendor' },
  env_argmap: { transaction: 'transaction_id' },
  implements: {
    area: 'purchases', spec: '0.5',
    argmap: { transaction: 'transaction_id', receipt: 'receipt_id', subscription: 'subscription_id', source: 'source_id', rule: 'rule_id', bill: 'bill_id' },
    acts: {
      import_statement: 'purch_import_statement', discard_source: 'purch_discard_source', review_transaction: 'purch_review_transaction', review_batch: 'purch_review_batch', split_transaction: 'purch_split_transaction', set_vendor: 'purch_set_vendor', vocabulary: 'purch_vocabulary', rename_category: 'purch_rename_category',
      add_receipt: 'purch_add_receipt', match_receipt: 'purch_match_receipt', unmatch_receipt: 'purch_unmatch_receipt',
      declare_subscription: 'purch_declare_subscription', cancel_subscription: 'purch_cancel_subscription',
      sources: 'purch_sources', source: 'purch_source', transactions: 'purch_transactions', purchases: 'purch_purchases',
      subscriptions: 'purch_subscriptions', receipts: 'purch_receipts', spend: 'purch_spend',
      add_rule: 'purch_add_rule', end_rule: 'purch_end_rule', accept_suggestions: 'purch_accept_suggestions', rules: 'purch_rules',
      add_bill: 'purch_add_bill', approve_bill: 'purch_approve_bill', record_bill_payment: 'purch_record_bill_payment', reject_bill: 'purch_reject_bill', bills: 'purch_bills', payables: 'purch_payables',
    },
  },
  api: { views: V, journalLines: V.journalLines, journalOmitted: V.journalOmitted, mappableKeys: V.mappableKeys, statementAccounts: V.statementAccounts, unpaidBills: V.unpaidBills },
});

R.defineSubject('purch_transaction', { load: (id) => V.transactionView(id) });
R.defineSubject('purch_receipt', { load: (id) => V.receiptView(id) });
R.defineSubject('purch_subscription', { load: (id) => V.subscriptionView(id) });
R.defineSubject('purch_source', { load: (id) => H.need('purch_source', id, 'source') });
R.defineSubject('purch_rule', { load: (id) => H.need('purch_rule', id, 'rule') });
R.defineSubject('purch_bill', { load: (id) => H.need('purch_bill', id, 'bill') });

R.inModule(mod, () => {
  require('./commands/import.js');
  require('./commands/review.js');
  require('./commands/split.js');
  require('./commands/receipts.js');
  require('./commands/subscriptions.js');
  require('./commands/rules.js');
  require('./commands/bills.js');
  require('./commands/reads.js');
});

module.exports = mod;
