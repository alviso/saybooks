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
  tables: ['purch_source', 'purch_vendor', 'purch_vendor_alias', 'purch_transaction', 'purch_split', 'purch_receipt', 'purch_subscription'],
  ids: { source: 'SRC-0001', transaction: 'T-0001', vendor: 'V-0001', receipt: 'R-0001', subscription: 'SUB-0001' },
  lifecycles: {
    source: 'imported whole (reconciled to its control totals) — immutable; the same hash never twice',
    transaction: 'unreviewed -> purchase | recurring | transfer | income | fee | ignored (a reasoned act; amount and date never change) -> optionally split into legs that add to it exactly',
    subscription: 'active (declared) -> cancelled (reasoned); lapsed is DERIVED from two missed periods, never stored',
    receipt: 'unmatched -> matched to exactly one transaction (reasoned) -> unmatched again (reasoned)',
  },
  rules: [
    'A statement is accepted whole or not at all: rows must reconcile to the printed opening balance, closing balance and row count.',
    'Every transaction traces to a source row and the raw line as read; nothing is edited in place.',
    'The same source hash is never imported twice; rows already present are skipped and listed.',
    'Category, vendor and status are empty until an act with a reason sets them.',
    'A subscription is declared, then confirmed by the record; a missing charge shows as missed, never assumed.',
    'Files never live here — a source or a receipt is its hash and its facts.',
  ],
  doctrine: `AGENT FIRST. You read the file — bank statement, card statement, receipt photo —
and hand over what it says. The module checks it and keeps it. Nothing here parses.

Importing a statement (purch_import_statement):
- Read every row: date (ISO), signed amount in minor units (spending NEGATIVE, money in
  POSITIVE), the description exactly as printed, and the raw line. Keep the statement's
  own order; row_index is its position.
- State the control totals the statement prints: opening balance, closing balance, number
  of rows. The import is refused when the rows do not add up to them — then re-read; a
  refusal names the gap. Never "fix" a row to make it reconcile.
- hash: a content hash of the file if you can compute one; otherwise a stable id the
  statement itself carries (statement number + period). The same hash is refused twice.
- Rows already on record (same date, amount, description) are skipped and listed back; say
  so to the person.

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

Subscriptions: purch_declare_subscription from a charge you have seen; the record then
confirms it month by month. A missed period is shown, never assumed; two make it lapsed.
Money is integer minor units; sums are per currency and never cross.`,
  env_acts: { import_statement: 'purch_import_statement', review_batch: 'purch_review_batch', review_transaction: 'purch_review_transaction', set_vendor: 'purch_set_vendor' },
  env_argmap: { transaction: 'transaction_id' },
  implements: {
    area: 'purchases', spec: '0.2',
    argmap: { transaction: 'transaction_id', receipt: 'receipt_id', subscription: 'subscription_id', source: 'source_id' },
    acts: {
      import_statement: 'purch_import_statement', discard_source: 'purch_discard_source', review_transaction: 'purch_review_transaction', review_batch: 'purch_review_batch', split_transaction: 'purch_split_transaction', set_vendor: 'purch_set_vendor', vocabulary: 'purch_vocabulary', rename_category: 'purch_rename_category',
      add_receipt: 'purch_add_receipt', match_receipt: 'purch_match_receipt', unmatch_receipt: 'purch_unmatch_receipt',
      declare_subscription: 'purch_declare_subscription', cancel_subscription: 'purch_cancel_subscription',
      sources: 'purch_sources', source: 'purch_source', transactions: 'purch_transactions', purchases: 'purch_purchases',
      subscriptions: 'purch_subscriptions', receipts: 'purch_receipts', spend: 'purch_spend',
    },
  },
  api: { views: V, journalLines: V.journalLines, journalOmitted: V.journalOmitted, mappableKeys: V.mappableKeys },
});

R.defineSubject('purch_transaction', { load: (id) => V.transactionView(id) });
R.defineSubject('purch_receipt', { load: (id) => V.receiptView(id) });
R.defineSubject('purch_subscription', { load: (id) => V.subscriptionView(id) });
R.defineSubject('purch_source', { load: (id) => H.need('purch_source', id, 'source') });

R.inModule(mod, () => {
  require('./commands/import.js');
  require('./commands/review.js');
  require('./commands/split.js');
  require('./commands/receipts.js');
  require('./commands/subscriptions.js');
  require('./commands/reads.js');
});

module.exports = mod;
