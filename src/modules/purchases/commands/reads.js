'use strict';
const { defineCommand, f } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Purchases read', ...def });

read({ name: 'purch_vocabulary', title: 'Words in use', summary: 'Statuses with their meaning, the person\'s categories and vendors with aliases, cadences, subscriptions — read this before proposing a review.', args: {}, handler: () => V.vocabulary() });
read({ name: 'purch_sources', title: 'Statements', summary: 'Every statement imported: period, account, balances, rows in and skipped, who imported it.', args: {}, handler: () => V.sources() });
read({ name: 'purch_source', title: 'Statement', summary: 'One statement with its rows and reconciliation.', args: { source_id: { ...f.text('e.g. SRC-0001.'), required: true } }, handler: (a) => V.sourceView(a.source_id) });
read({ name: 'purch_transactions', title: 'Transactions', summary: 'Rows on record, newest first, with filters. unreviewed says how many still need a word.',
  args: { from: f.date('From date.'), to: f.date('To date.'), status: f.pick(['unreviewed', 'purchase', 'transfer', 'income', 'fee', 'ignored'], 'Only this status.'), source_id: f.text('Only this statement.'), vendor: f.text('Only this vendor.'), category: f.text('Only this category.'), limit: f.int('Max rows, default 500.') },
  handler: (a) => V.transactions(a) });
read({ name: 'purch_purchases', title: 'Purchases', summary: 'Reviewed spending: by category, by month, by vendor, per currency.',
  args: { from: f.date('From date.'), to: f.date('To date.'), vendor: f.text('Only this vendor.'), category: f.text('Only this category.') }, handler: (a) => V.purchases(a) });
read({ name: 'purch_subscriptions', title: 'Subscriptions', summary: 'Every declared subscription with its periods matched or missed, derived status, next expected charge, and the monthly equivalent per currency.',
  args: { as_of: f.date('Evaluate as of this date. Defaults to today.') }, handler: (a) => V.subscriptions(a.as_of) });
read({ name: 'purch_receipts', title: 'Receipts', summary: 'Receipts on record, matched or not.', args: { unmatched: f.bool('Only unmatched ones.') }, handler: (a) => V.receipts(a) });
read({ name: 'purch_spend', title: 'Spend', summary: 'Spending by month, category and vendor, per currency — the numbers behind the charts.',
  args: { from: f.date('From date.'), to: f.date('To date.') },
  handler: (a) => { const p = V.purchases(a); const t = V.transactions({ ...a, limit: 5000 }); return { from: a.from || null, to: a.to || null, spend_by_currency: p.spend_by_currency, by_month: p.by_month, by_category: p.by_category, by_vendor: p.by_vendor, unreviewed: t.unreviewed, transactions: t.count, purchases: p.count, subscriptions: V.subscriptions() }; } });
read({ name: 'purch_get_transaction', title: 'Transaction', summary: 'One row: provenance, review, vendor, receipt.', args: { transaction_id: { ...f.text('e.g. T-0012.'), required: true } }, handler: (a) => V.transactionView(a.transaction_id) });
read({ name: 'purch_get_receipt', title: 'Receipt', summary: 'One receipt and, if unmatched, its candidate rows.', args: { receipt_id: { ...f.text('e.g. R-0003.'), required: true } }, handler: (a) => { const r = V.receiptView(a.receipt_id); return { ...r, candidates: r.matched ? [] : V.receiptCandidates(r) }; } });
read({ name: 'purch_get_subscription', title: 'Subscription', summary: 'One subscription with every period matched or missed.', args: { subscription_id: { ...f.text('e.g. SUB-0001.'), required: true }, as_of: f.date('Evaluate as of this date.') }, handler: (a) => V.subscriptionView(a.subscription_id, a.as_of) });
