'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Loans read', ...def });
const isDate = (k, v) => { if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Rejected(`${k} is a date, YYYY-MM-DD.`); };
const KINDS = ['mortgage', 'auto', 'student', 'personal', 'other'];

defineCommand({
  name: 'loan_add',
  permission: 'cash.write',
  title: 'Add a loan', group: 'Loans', subject: 'loan_loan', scope: 'collection',
  summary: 'Start a loan from the lender\'s figures: what was owed on a day, the rate, the monthly payment, escrow and the due day. The schedule, payoff date and interest are worked out from these.',
  doctrine: `Take the figures from a lender statement or the loan papers the person hands you, and say which
(source). Never fill a rate or a balance in from memory or the market. The loan gets an account in the
register under its name ("Chase mortgage ending 7731"). A variable rate is outside this version:
record the current rate and say so in the source.`,
  effects: ['loan recorded from the lender\'s figures', 'its account added to the register'],
  args: {
    name:               { ...f.text('As the lender prints it, e.g. "Chase mortgage ending 7731".'), required: true },
    kind:               { ...f.pick(KINDS, 'What it is.'), required: true },
    lender:             f.text('Who holds it.'),
    currency:           { ...f.text('ISO 4217 code.'), required: true },
    balance:            { ...f.money('What was owed on balance_date, from the lender.'), required: true },
    balance_date:       { ...f.date('The day that balance is for.'), required: true },
    rate_bp:            { ...f.int('Annual rate in basis points: 650 means 6.5%.'), required: true },
    payment:            { ...f.money('The scheduled monthly payment of principal and interest.'), required: true },
    escrow:             f.money('Taxes and insurance collected with each payment, if any.'),
    due_day:            { ...f.int('Day of the month the payment is due (1 to 31).'), required: true },
    original_principal: f.money('What was first borrowed, if known.'),
    term_months:        f.int('The original term in months, if known.'),
    source:             { ...f.text('Where the figures come from: "lender statement, October 2026".'), required: true },
  },
  handler(a, { db, at, actor }) {
    const p = V.purchases(); if (!p) throw new Rejected('Loans live alongside personal finances, which is not in this space.');
    const cur = String(a.currency).toUpperCase(); if (!H.CUR_RE.test(cur)) throw new Rejected('currency is a three-letter ISO 4217 code.');
    isDate('balance_date', a.balance_date);
    if (a.balance_date > H.today()) throw new Rejected(`${a.balance_date} is in the future. The balance is for a day that has happened.`);
    for (const k of ['balance', 'payment']) if (!Number.isInteger(a[k]) || a[k] <= 0) throw new Rejected(`${k} is whole cents, more than zero.`);
    if (!Number.isInteger(a.rate_bp) || a.rate_bp < 0 || a.rate_bp > 5000) throw new Rejected('rate_bp is basis points, 0 to 5000 (650 = 6.5%).');
    if (!Number.isInteger(a.due_day) || a.due_day < 1 || a.due_day > 31) throw new Rejected('due_day is 1 to 31.');
    if (a.escrow != null && (!Number.isInteger(a.escrow) || a.escrow < 0)) throw new Rejected('escrow is whole cents, zero or more.');
    const src = String(a.source || '').trim(); if (!src) throw new Rejected('A loan needs its source: where the figures come from.');
    if (a.payment <= V.monthly(a.balance, a.rate_bp)) throw new Rejected(`A payment of ${H.money(a.payment, cur)} does not cover a month's interest (${H.money(V.monthly(a.balance, a.rate_bp), cur)} at ${a.rate_bp / 100}%). Re-read the figures: is the payment principal and interest, without escrow?`);
    const acc = p.ensureAccount(db, { name: String(a.name).trim(), kind: 'loan', currency: cur, institution: a.lender }, at);
    if (db.prepare('SELECT id FROM loan_loan WHERE account_id = ?').get(acc.id)) throw new Rejected(`${acc.name} already has a loan recorded.`);
    const id = H.nextId('LN', 'loan_loan');
    db.prepare(`INSERT INTO loan_loan (id,account_id,kind,lender,currency,balance,balance_date,rate_bp,payment,escrow,due_day,original_principal,term_months,source,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, acc.id, a.kind, a.lender || null, cur, a.balance, a.balance_date, a.rate_bp, a.payment, a.escrow || 0, a.due_day, a.original_principal ?? null, a.term_months ?? null, src, actor || null, at);
    return { ...V.loanView(id) };
  },
});

defineCommand({
  name: 'loan_link_payment',
  permission: 'cash.write',
  title: 'Link a payment', group: 'Loans', subject: 'loan_loan',
  summary: 'Tie the statement row that paid the loan to it, split into principal, interest and escrow: as the lender printed it, or by the schedule when no split is given.',
  doctrine: `Read loan_candidates for rows that look like the payment. When the lender's statement prints
the split (principal, interest, escrow), pass it: it is the record, and it must add up to the row. With
no split given, the schedule works it out from the balance and the rate, and the result says so.
Anything above the scheduled payment and escrow goes to principal.`,
  effects: ['payment split and recorded', 'the row posts once, through the loan'],
  guardless: true,
  args: {
    loan_id:        { ...f.ref('loan_loan', 'The loan, e.g. LN-0001.'), required: true },
    transaction_id: { ...f.ref('purch_transaction', 'The statement row that paid it.'), required: true },
    principal:      f.money('As the lender printed it, if it did.'),
    interest:       f.money('As the lender printed it, if it did.'),
    escrow:         f.money('As the lender printed it, if it did.'),
    reason:         { ...f.text('Why this row is this payment.'), required: true },
  },
  handler(a, { db, at, actor }) {
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Linking a payment needs a reason.');
    const loan = H.need('loan_loan', a.loan_id, 'loan');
    const p = V.purchases();
    const t = p.statementRows().find(r => r.id === a.transaction_id);
    if (!t) throw new Rejected(`${a.transaction_id} is not a statement row here.`);
    if (!(t.amount < 0)) throw new Rejected(`${t.id} is money in; a loan payment is money out.`);
    if (t.currency !== loan.currency) throw new Rejected(`${t.id} is in ${t.currency}; the loan is in ${loan.currency}.`);
    if (t.date <= loan.balance_date) throw new Rejected(`${t.id} (${t.date}) is on or before the lender's figure (${loan.balance_date}); that payment is already inside the balance.`);
    if (db.prepare('SELECT id FROM loan_payment WHERE transaction_id = ? AND unlinked_at IS NULL').get(t.id)) throw new Rejected(`${t.id} is already linked to a loan.`);
    if (p.views.matchedRows().has(t.id)) throw new Rejected(`${t.id} is matched to ${p.views.matchedRows().get(t.id)}.`);
    if (p.views.pairIndex().has(t.id)) throw new Rejected(`${t.id} is one side of a transfer between your accounts.`);
    if (!(t.status === 'unreviewed' || (t.status === 'transfer' && !t.category))) throw new Rejected(`${t.id} (${t.description}) is reviewed as ${t.status}${t.category ? ` (${t.category})` : ''}. If it really is the loan payment, leave it unreviewed or review it as a transfer with no other side first.`);
    const amount = -t.amount;
    const before = V.history(loan, t.date).balance;
    let split, from;
    const given = [a.principal, a.interest, a.escrow].some(x => x != null);
    if (given) {
      split = { principal: a.principal || 0, interest: a.interest || 0, escrow: a.escrow || 0 }; from = 'lender';
      for (const [k, v] of Object.entries(split)) if (!Number.isInteger(v) || v < 0) throw new Rejected(`${k} is whole cents, zero or more.`);
      const sum = split.principal + split.interest + split.escrow;
      if (sum !== amount) throw new Rejected(`The split adds up to ${H.money(sum, t.currency)}; ${t.id} paid ${H.money(amount, t.currency)}. As printed, it adds up exactly.`);
    } else {
      split = V.scheduleSplit(loan, before, amount); from = 'schedule';
      if (split.principal < 0) throw new Rejected(`${H.money(amount, t.currency)} does not cover the month's interest (${H.money(split.interest, t.currency)}) and escrow. Pass the split the lender printed.`);
    }
    if (split.principal > before) throw new Rejected(`${H.money(split.principal, t.currency)} of principal is more than is owed (${H.money(before, t.currency)}). A payoff's figures come from the lender's payoff letter: pass its split.`);
    const was = p.markRecordedElsewhere(db, t.id, `Loan payment to ${H.get('purch_account', loan.account_id).name}`, at);
    const id = H.nextId('LP', 'loan_payment');
    db.prepare(`INSERT INTO loan_payment (id,loan_id,transaction_id,date,amount,principal,interest,escrow,split_from,row_was,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, loan.id, t.id, t.date, amount, split.principal, split.interest, split.escrow, from, JSON.stringify(was), why, actor || null, at);
    const v = V.loanView(loan.id);
    return { payment_id: id, loan_id: loan.id, transaction_id: t.id, split_from: from, principal: split.principal, interest: split.interest, escrow: split.escrow, owed: v.owed, owed_display: v.owed_display,
      note: `Linked ${t.id} (${H.money(amount, t.currency)}, ${t.date}) to ${v.name} as ${id}: ${H.money(split.principal, t.currency)} principal, ${H.money(split.interest, t.currency)} interest${split.escrow ? `, ${H.money(split.escrow, t.currency)} escrow` : ''}${from === 'schedule' ? ' (by the schedule; the lender\'s statement, when it comes, is the record)' : ' (as the lender printed it)'}. ${v.owed_display} owed now.` };
  },
});

defineCommand({
  name: 'loan_unlink_payment',
  permission: 'cash.write',
  title: 'Unlink a payment', group: 'Loans', subject: 'loan_loan',
  summary: 'Undo a payment link, with a reason. The row goes back to how it was reviewed; the balance moves back.',
  doctrine: 'For a link that was wrong, or to relink it with the lender\'s split once the statement arrives. Say so to the person.',
  effects: ['payment unlinked; the row back to its earlier review'],
  guardless: true,
  args: { loan_id: { ...f.ref('loan_loan', 'The loan.'), required: true }, payment_id: { ...f.text('e.g. LP-0001.'), required: true }, reason: { ...f.text('Why.'), required: true } },
  handler(a, { db, at }) {
    const pay = H.need('loan_payment', a.payment_id, 'payment');
    if (pay.loan_id !== a.loan_id) throw new Rejected(`${pay.id} belongs to ${pay.loan_id}.`);
    if (pay.unlinked_at) throw new Rejected(`${pay.id} was already unlinked.`);
    const why = String(a.reason || '').trim(); if (!why) throw new Rejected('Unlinking needs a reason.');
    V.purchases().restoreRow(db, pay.transaction_id, JSON.parse(pay.row_was || '{}'));
    db.prepare('UPDATE loan_payment SET unlinked_at = ?, unlink_reason = ? WHERE id = ?').run(at, why, pay.id);
    const v = V.loanView(pay.loan_id);
    return { ...v, note: `${pay.id} unlinked; ${pay.transaction_id} is back to how it was reviewed. ${v.owed_display} owed.` };
  },
});

read({ name: 'loan_loans', title: 'Loans', summary: 'Each loan: what is owed and as of when, the rate, the next payment, the payoff date, interest this year, and whether it ties to the lender\'s figure.',
  args: { as_of: f.date('') }, handler: (a) => V.loans(a) });
read({ name: 'loan_get', title: 'Loan', summary: 'One loan whole: the payments with their splits, the twelve months ahead, the payoff, and the lender\'s figure against ours.',
  args: { loan_id: { ...f.text('e.g. LN-0001.'), required: true }, as_of: f.date('') }, handler: (a) => V.loanView(a.loan_id, a.as_of || undefined) });
read({ name: 'loan_candidates', title: 'Payment suggestions', summary: 'Statement rows that look like a loan payment: its amount near a due date, or the lender named. Suggestions only.',
  args: {}, handler: () => V.candidates() });
read({ name: 'loan_interest', title: 'Interest paid', summary: 'Interest, principal and escrow paid per loan in a year, from the payments\' splits, saying which were split by the schedule rather than the lender.',
  args: { year: f.text('e.g. 2026.') }, handler: (a) => V.interest(a) });
