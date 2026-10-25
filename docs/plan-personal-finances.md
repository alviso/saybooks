# Personal finances: towards feature complete

Started 2026-10-25, at Peter's request: make the personal finances area properly complete
(bank statements, credit cards, loans, bills received, purchase receipts, and what else belongs
to the subject) before any video series about it.

## Where it stands (purchases 0.5)

Already solid: statements imported whole against their printed totals, every row traced to its
line; review into purchase, recurring, transfer, income, fee or ignored; splits; standing rules
that suggest; vendors and their spellings; subscriptions confirmed by what actually charges;
receipts matched to rows; bills recorded, approved by a person, payment recorded after the fact;
spend by category and month.

The gaps, in the order they hurt:

1. **Accounts are only a label on each statement.** There is no list of the accounts a person
   has, no balance over time, no check that statements chain (a missing month, an opening that
   does not match the last closing), and no net worth.
2. **Moving money between your own accounts is half-recorded.** Paying the card from checking
   shows on both statements. Each side is reviewed separately as a transfer naming the other,
   and nothing pairs them, so a payment can be counted twice or not at all.
3. **Credit cards are treated like bank accounts.** The statement's own facts (statement
   balance, minimum payment, due date, credit limit, interest charged) are not kept, so there is
   no "card payment due Friday" and no interest paid this year. Refunds are not tied to the
   purchase they reverse.
4. **Loans do not exist.** A mortgage or car loan payment is one row on a statement; nothing
   knows how much was principal and how much interest, what is still owed, or when it ends.
5. **Bills are shaped for a business.** Approval by a person suits a company. A household needs
   the bills that come every month (the electric bill, never the same amount), autopay, and one
   view of what is due in the next weeks: bills, card payments, loan payments and
   subscriptions, against what is in checking.
6. **Receipts stop at the match.** No return-by date, no warranty end, no work expense waiting
   to be reimbursed, no way to find the medical or charitable receipts at tax time.

## The plan: six parts, each reviewed before the next

Each part: spec update with invariants and scenarios, the build, a contract gate, UI, site and
docs kept complete, demo data, then a short walkthrough for Peter (screenshots and what changed)
to approve before it deploys. Video series after, once it is complete.

| # | Part | What it adds |
|---|---|---|
| A | Accounts and net worth | An account register (checking, savings, credit card, loan, and things with a value like a house or a car); statements belong to an account; balance over time from the statements; statement gaps and mismatched openings named; values a person states for assets without statements (dated, sourced); net worth on any day |
| B | Transfers between your accounts | The two sides of one move paired (checking out, card in), suggested by amount and date, confirmed with a reason; a paired transfer is neither spending nor income; an unpaired side is listed until its other half arrives |
| C | Credit cards | The statement's facts kept (balance, minimum, due date, limit, interest and fees charged); payment due on the due list, confirmed by the paired transfer; interest and fees per year; a refund tied to the purchase it reverses |
| D | Loans | Mortgage, car, student and personal loans: principal, rate, term, payment, escrow; the schedule derived; each payment row split into principal, interest and escrow; balance checked against the lender's statement; extra payments; payoff date; interest paid per year |
| E | Household bills and what is due | Bills that recur with varying amounts (expected monthly, flagged when missing or unusually high); autopay; one upcoming view: bills, card payments, loan payments and subscriptions due in the next weeks, beside the checking balance. Approval stays available for spaces that want it |
| F | Receipts and the year | Return-by and warranty dates as the receipt states them; work expenses marked reimbursable and tied to the reimbursement when it arrives; tags for what matters at tax time (medical, charitable, business, home office); a year summary listing tagged spending, interest paid and earned, and receipts that are missing |

## Kept out, on purpose

Bank feeds (files stay the boundary), investment holdings and prices (a value the person states
is enough for net worth), tax advice (tags and totals, never what is deductible), and budgets:
the spec says Saybooks records and does not counsel. A budget is the person's own policy; if
wanted later, it would be their numbers shown beside actuals, nothing more.

## Notes

- The business areas lean on purchases (p2p bills, the bank reconciliation, the journal); every
  part keeps them working and the contract gates prove it.
- Demo data: a household with checking, savings, one credit card, a car loan and a mortgage,
  three months of statements, so every part has something real to show.
