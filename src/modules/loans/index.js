'use strict';
/**
 * loans — a mortgage, a car loan, a student or personal loan, kept from the lender's figures. The
 * statement rows that paid it (the purchases area's) are split into principal, interest and escrow;
 * the balance, the schedule ahead, the payoff date and interest per year are derived. Lives beside
 * personal finances: the loan is an account in its register, and its balance feeds net worth.
 */
const R = require('../../registry.js');
const V = require('./views.js');

const mod = R.defineModule({
  name: 'loans', prefix: 'loan',
  tables: ['loan_loan', 'loan_payment'],
  ids: { loan: 'LN-0001', payment: 'LP-0001' },
  lifecycles: {
    loan: 'recorded from the lender\'s figures -> paid off (derived, when nothing is owed)',
    payment: 'linked to a statement row, split as the lender printed it or by the schedule -> unlinked (reasoned)',
  },
  rules: [
    'A loan starts from the lender\'s figures with their source; nothing is filled in from memory or the market.',
    'A payment is a statement row split into principal, interest and escrow that add up to it exactly; the lender\'s split is the record when there is one.',
    'Principal comes off what is owed; interest and escrow are spending; the row is in the books once.',
  ],
  doctrine: `Loans: a mortgage, a car loan, a student or personal loan. Start one with loan_add from a lender
statement or the loan papers, saying which. Each month the payment shows on a bank statement: read
loan_candidates, show the person, and link the row with loan_link_payment. Pass the lender's printed split
when you have it; without one the schedule splits it, and says so. loan_get shows the payments, the year
ahead and the payoff date; when the person gives you a lender statement's balance, record it on the loan's
account with purch_record_value (according_to the statement) and the loan shows whether it ties.`,
  implements: {
    area: 'loans', spec: '0.1',
    argmap: { loan: 'loan_id', transaction: 'transaction_id' },
    acts: { add: 'loan_add', link_payment: 'loan_link_payment', unlink_payment: 'loan_unlink_payment', loans: 'loan_loans', loan: 'loan_get', candidates: 'loan_candidates', interest: 'loan_interest' },
  },
  api: { views: V, journalLines: V.journalLines, statementRowPosts: V.statementRowPosts, statementRowMatches: V.statementRowMatches, accountBalance: V.accountBalance, derivationAccounts: V.DERIVATION_ACCOUNTS },
});

R.defineSubject('loan_loan', { load: (id) => V.loanView(id) });

R.inModule(mod, () => { require('./commands/loans.js'); });

module.exports = mod;
