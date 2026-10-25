'use strict';
/**
 * Loans read models. A loan starts from the lender's figures (what was owed on a day, the rate, the
 * payment); the statement rows that paid it are split into principal, interest and escrow. Balance,
 * schedule, payoff date and interest per year are derived from those, never stored.
 */
const H = require('../../db.js');
const { Rejected } = require('../../registry.js');
const db = () => H.db();
const money = (c, cur) => (c == null ? null : H.money(c, cur || H.locale().currency || 'USD'));
const MODULES = () => require('../../registry.js').MODULES;
const purchases = () => { const m = MODULES().find(x => x.name === 'purchases'); return m ? m.api : null; };
const pct = (bp) => `${(bp / 100).toFixed(3).replace(/\.?0+$/, '')}%`;
const monthly = (bal, rateBp) => Math.round(bal * rateBp / 10000 / 12);
const INTEREST_WORD = { mortgage: 'mortgage interest', student: 'student loan interest' };
const interestCategory = (loan) => INTEREST_WORD[loan.kind] || 'loan interest';

const loanRows = () => { try { return db().prepare('SELECT * FROM loan_loan ORDER BY id').all(); } catch { return []; } };
const paymentsOf = (loanId) => { try { return db().prepare('SELECT * FROM loan_payment WHERE loan_id = ? AND unlinked_at IS NULL ORDER BY date, id').all(loanId); } catch { return []; } };
const allPayments = () => { try { return db().prepare('SELECT * FROM loan_payment WHERE unlinked_at IS NULL ORDER BY date, id').all(); } catch { return []; } };
const accountOf = (loan) => H.get('purch_account', loan.account_id) || { id: loan.account_id, name: loan.account_id };

/** The next due date on or after a day, on the loan's due day (clamped to the month's last day). */
function dueOnOrAfter(loan, day) {
  const [y, m, d] = day.split('-').map(Number);
  const mk = (yy, mm) => { const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(loan.due_day, last)).padStart(2, '0')}`; };
  const here = mk(y, m);
  return here >= day ? here : (m === 12 ? mk(y + 1, 1) : mk(y, m + 1));
}

/** The split a row of this size would get by the schedule, with the balance as it stands before it. */
function scheduleSplit(loan, before, amount) {
  const interest = monthly(before, loan.rate_bp);
  const escrow = loan.escrow && amount >= loan.payment + loan.escrow ? loan.escrow : 0;
  return { interest, escrow, principal: amount - interest - escrow };
}

/** The loan's balance after each payment, from the lender's figure on balance_date. */
function history(loan, asOf) {
  let bal = loan.balance;
  const rows = paymentsOf(loan.id).filter(p => !asOf || p.date <= asOf).map(p => { bal -= p.principal; return { ...p, balance_after: bal }; });
  return { balance: bal, rows };
}

/** P-L4: twelve months ahead and the payoff, by the rate and the scheduled payment. Never paid off when the payment does not cover the interest. */
function projection(loan, from, bal) {
  const out = []; let b = bal, due = dueOnOrAfter(loan, H.addDays(from, 1)), months = 0, interestLeft = 0;
  if (b <= 0) return { ahead: [], payoff_date: null, months_left: 0, interest_left: 0 };
  if (loan.payment <= monthly(b, loan.rate_bp)) return { ahead: [], payoff_date: null, months_left: null, interest_left: null, never: true };
  while (b > 0 && months < 600) {
    const interest = monthly(b, loan.rate_bp); const principal = Math.min(loan.payment - interest, b);
    b -= principal; months++; interestLeft += interest;
    if (out.length < 12) out.push({ due, payment: principal + interest, interest, principal, escrow: loan.escrow, balance_after: b });
    if (b > 0) { const [y, m] = due.split('-').map(Number); due = dueOnOrAfter(loan, `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`); }
  }
  return { ahead: out, payoff_date: due, months_left: months, interest_left: interestLeft };
}

function loanView(id, asOf = H.today()) {
  const loan = H.need('loan_loan', id, 'loan');
  const acc = accountOf(loan), cur = loan.currency;
  const h = history(loan, asOf);
  const last = h.rows[h.rows.length - 1] || null;
  const from = last ? last.date : loan.balance_date;
  const pr = projection(loan, from, h.balance);
  // P-L5: the lender's own figure, where one was stated (purchases' values on the loan account), against the derived balance on that day.
  let lenderFig = null; try { lenderFig = db().prepare('SELECT * FROM purch_valuation WHERE account_id = ? AND as_of <= ? AND as_of > ? ORDER BY as_of DESC, id DESC').get(acc.id, asOf, loan.balance_date); } catch { /* none */ }
  const tie = lenderFig ? (() => { const ours = history(loan, lenderFig.as_of).balance; const theirs = -lenderFig.value; return { as_of: lenderFig.as_of, source: lenderFig.source, lender: theirs, lender_display: money(theirs, cur), ours, ours_display: money(ours, cur), ties: ours === theirs, difference: theirs - ours, difference_display: money(theirs - ours, cur) }; })() : null;
  const year = asOf.slice(0, 4);
  const thisYear = h.rows.filter(p => p.date.startsWith(year));
  const nextDue = dueOnOrAfter(loan, H.addDays(from, 1));
  return { ...loan, name: acc.name, status: h.balance <= 0 ? 'paid off' : 'open', account: acc.name, rate: pct(loan.rate_bp),
    balance_display: money(loan.balance, cur), payment_display: money(loan.payment, cur), escrow_display: money(loan.escrow, cur),
    owed: h.balance, owed_display: money(h.balance, cur), owed_as_of: from,
    payments: h.rows.map(p => ({ ...p, amount_display: money(p.amount, cur), principal_display: money(p.principal, cur), interest_display: money(p.interest, cur), escrow_display: money(p.escrow, cur), balance_after_display: money(p.balance_after, cur) })).reverse(),
    next_due: h.balance > 0 ? nextDue : null, next_due_amount: loan.payment + loan.escrow, next_due_amount_display: money(loan.payment + loan.escrow, cur),
    ahead: pr.ahead.map(x => ({ ...x, payment_display: money(x.payment, cur), interest_display: money(x.interest, cur), principal_display: money(x.principal, cur), balance_after_display: money(x.balance_after, cur) })),
    payoff_date: pr.payoff_date, months_left: pr.months_left, interest_left_display: pr.interest_left == null ? null : money(pr.interest_left, cur), never_paid_off: !!pr.never,
    interest_this_year: thisYear.reduce((n, p) => n + p.interest, 0), interest_this_year_display: money(thisYear.reduce((n, p) => n + p.interest, 0), cur),
    lender_tie: tie,
    note: `${acc.name}: ${money(h.balance, cur)} owed as of ${from} at ${pct(loan.rate_bp)}.${pr.never ? ' The payment does not cover the interest: it never pays off at this rate.' : pr.payoff_date ? ` Paid off ${pr.payoff_date} on the scheduled payment, ${pr.months_left} payments from now.` : ''}${tie ? (tie.ties ? ` Ties to the lender's ${tie.as_of} figure.` : ` The lender's ${tie.as_of} figure is ${tie.lender_display}; ours is ${tie.ours_display}, ${tie.difference_display} apart.`) : ''}` };
}

function loans({ as_of } = {}) {
  const items = loanRows().map(l => loanView(l.id, as_of || H.today()));
  return { count: items.length, items, note: items.length ? items.map(x => x.note).join(' ') : 'No loans yet.' };
}

const PAY_WORDS = /\b(mortgage|loan|mtg|auto pay|autopay|pmt|payment|servicing|lending|financial)\b/i;
/** P-L6: rows that look like a loan's payment: its amount (payment, with or without escrow) and near a due date, or the lender named. Suggestions only. */
function candidates() {
  const p = purchases(); if (!p) return { count: 0, items: [] };
  const linked = new Set(allPayments().map(x => x.transaction_id));
  const held = p.views.matchedRows(), pi = p.views.pairIndex();
  const rows = p.statementRows().filter(t => t.amount < 0 && !linked.has(t.id) && !held.has(t.id) && !pi.has(t.id) && (t.status === 'unreviewed' || (t.status === 'transfer' && !t.category)));
  const out = [];
  for (const loan of loanRows()) {
    const lw = String(loan.lender || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (const t of rows) {
      if (t.currency !== loan.currency || t.date <= loan.balance_date) continue;
      const amt = -t.amount, d = t.description.toLowerCase();
      const exact = amt === loan.payment + loan.escrow || amt === loan.payment;
      const named = lw.some(w => d.includes(w));
      const due = dueOnOrAfter(loan, H.addDays(t.date, -10));
      const near = Math.abs((Date.parse(due) - Date.parse(t.date)) / 864e5) <= 10;
      if (!((exact && near) || (named && amt >= loan.payment))) continue;
      out.push({ loan_id: loan.id, loan: accountOf(loan).name, transaction_id: t.id, date: t.date, description: t.description, amount: amt, amount_display: money(amt, t.currency), account: t.account,
        why: [exact ? 'the scheduled amount' : `more than the payment by ${money(amt - loan.payment - loan.escrow, t.currency)} (extra principal?)`, named ? 'the lender named' : null, near ? `near the ${due} due date` : null].filter(Boolean).join(', ') });
    }
  }
  return { count: out.length, items: out, note: out.length ? `${out.length} row${out.length === 1 ? '' : 's'} look${out.length === 1 ? 's' : ''} like loan payments. Suggestions only: link with loan_link_payment and a reason.` : 'No statement row looks like a loan payment waiting to be linked.' };
}

/** P-L7: interest paid per loan in a year, from the payments' splits. */
function interest({ year } = {}) {
  const y = String(year || H.today().slice(0, 4));
  const items = loanRows().map(l => { const ps = paymentsOf(l.id).filter(p => p.date.startsWith(y));
    return { loan_id: l.id, name: accountOf(l).name, kind: l.kind, currency: l.currency, payments: ps.length, interest: ps.reduce((n, p) => n + p.interest, 0), principal: ps.reduce((n, p) => n + p.principal, 0), escrow: ps.reduce((n, p) => n + p.escrow, 0),
      from_lender: ps.filter(p => p.split_from === 'lender').length }; }).filter(x => x.payments)
    .map(x => ({ ...x, interest_display: money(x.interest, x.currency), principal_display: money(x.principal, x.currency), escrow_display: money(x.escrow, x.currency) }));
  return { year: y, count: items.length, items, note: items.length ? `${y}: ${items.map(x => `${x.name}, ${x.interest_display} interest over ${x.payments} payment${x.payments === 1 ? '' : 's'}${x.from_lender < x.payments ? ` (${x.payments - x.from_lender} split by the schedule, not the lender)` : ''}`).join('; ')}.` : `No loan payments linked in ${y}.` };
}

// ---- for other areas
/** purchases: statement rows this area posts itself. */
const statementRowPosts = () => allPayments().map(p => p.transaction_id);
/** purchases: rows matched here, for its review guard and left-out lists. */
const statementRowMatches = () => allPayments().map(p => { const l = H.get('loan_loan', p.loan_id); return [p.transaction_id, `loan payment ${p.id} (${l ? accountOf(l).name : p.loan_id})`]; });
/** purchases: a loan account's balance, from the lender's figure and the payments since, for net worth. */
function accountBalance(accountId, asOf) {
  const loan = loanRows().find(l => l.account_id === accountId); if (!loan || loan.balance_date > asOf) return null;
  const h = history(loan, asOf); const last = h.rows[h.rows.length - 1];
  return { balance: -h.balance, as_of: last ? last.date : loan.balance_date, from: last ? `loan ${loan.id}, after payment ${last.id}` : `loan ${loan.id}, the lender's figure` };
}

/** P-L3: the opening owed, and each payment: principal off the loan, interest and escrow as expenses, paid from the account the row is on. */
function journalLines() {
  const out = [];
  const p = purchases(); if (!p) return out;
  const rowAcct = new Map(p.statementRows().map(t => [t.id, t]));
  for (const loan of loanRows()) {
    const name = accountOf(loan).name, liab = { account: name, map: { kind: 'category', key: name, role: 'liability' } };
    out.push({ date: loan.balance_date, memo: `Loan ${loan.id} · ${name} owed (${loan.source})`, customer: null, currency: loan.currency, source: loan.id,
      lines: [{ account: 'Opening Balance Equity', debit: loan.balance }, { ...liab, credit: loan.balance }] });
    for (const pay of paymentsOf(loan.id)) {
      const t = rowAcct.get(pay.transaction_id); if (!t) continue;
      const ic = interestCategory(loan);
      out.push({ date: pay.date, memo: `Loan payment ${pay.id} · ${name}`, customer: loan.lender || null, currency: loan.currency, source: pay.transaction_id,
        lines: [{ ...liab, debit: pay.principal }, { account: ic, map: { kind: 'category', key: ic, role: 'expense' }, debit: pay.interest },
          ...(pay.escrow ? [{ account: 'escrow', map: { kind: 'category', key: 'escrow', role: 'expense' }, debit: pay.escrow }] : []),
          { account: t.account, map: { kind: 'source', key: t.account }, credit: pay.amount }] });
    }
  }
  return out;
}

const DERIVATION_ACCOUNTS = [{ account: 'Opening Balance Equity', kind: 'equity', when: 'what a loan was owed when its record starts' }];

module.exports = { loanView, loans, candidates, interest, scheduleSplit, history, dueOnOrAfter, statementRowPosts, statementRowMatches, accountBalance, journalLines, DERIVATION_ACCOUNTS, interestCategory, purchases, monthly };
