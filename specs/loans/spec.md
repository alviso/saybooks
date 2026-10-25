# loans — Loans · Area Specification

**Status: 0.1.** A mortgage, a car loan, a student or personal loan, kept from the lender's figures.
The statement rows that paid it are split into principal, interest and escrow; what is owed, the
year ahead, the payoff date and the interest paid each year follow. Part D of the personal finances
plan (docs/plan-personal-finances.md).

## 1. Calibration: who this is for

A household with a mortgage and a car loan, whose payments go out of checking each month. They want
to know what is still owed, when it ends, how much went to interest this year, and whether their
record agrees with the lender's. Their accountant wants mortgage interest as its own figure.

## 2. Scope

In: a loan from the lender's figures (owed on a day, a fixed rate, the monthly payment, escrow, the
due day); linking each statement row that paid it, split as the lender printed it or by the schedule;
what is owed, the twelve months ahead and the payoff date; the lender's figure against ours; interest,
principal and escrow per year; the loan's balance in net worth.

Out (§9): variable rates, recasts and refinances (start a new loan from the new figures), escrow
accounting beyond the monthly amount, lines of credit, and paying anything.

## 3. Entities and lifecycles

- **loan** — kind (mortgage | auto | student | personal | other), lender, currency, what was owed on
  a day, a fixed annual rate, the scheduled monthly payment of principal and interest, escrow
  collected with it, the due day, and where those figures come from. It is an account in the personal
  finances register, under the name the lender prints. Paid off is derived: nothing owed.
- **payment** — a statement row (money out of an account the person has) tied to the loan by a
  reasoned act, split into principal, interest and escrow that add up to the row exactly. As the lender
  printed it, or by the schedule (a month's interest on what was owed before it, the escrow, the rest to
  principal), and it says which. The row then posts once, through the loan, and cannot be reviewed again
  while linked. Unlinked with a reason; the row goes back as it was.

## 4. The acts

Writes: add, link_payment, unlink_payment. Reads: loans, loan (payments with splits, the year ahead,
the payoff, the lender's figure against ours), candidates (rows that look like a payment, with why),
interest (per loan and year).

## 5. Invariants

- **L-1** Money is integer cents; a payment's principal, interest and escrow add up to its row exactly.
- **L-2** A loan starts from the lender's figures with their source; a payment that does not cover a
  month's interest is refused, since it never pays off.
- **L-3** A linked row is in the books once: principal off what is owed, interest and escrow as
  spending, paid from the account the row is on; what was owed at the start sits against opening
  balances.
- **L-4** The lender's printed split is the record; a split by the schedule says so.
- **L-5** What is owed is the lender's starting figure less the principal of each payment since; where
  the lender's own later figure is stated, the difference is named, never absorbed.
- **L-6** Suggestions never link.
- **L-7** Every write is a logged command with an actor; refusals are logged too.

## 6. Required read models

loans and loan (owed and as of when, rate, next payment, payoff date, months left, interest left,
interest this year, the lender tie), candidates, interest.

## 7. Contract vs freedom

Contract: the lender's figures, exact splits, one posting per payment, a named difference with the
lender. Freedom: when to link, which statement a payment shows on.

## 8. Conformance (scenarios)

01 a mortgage payment suggested, linked and split by the schedule; what is owed goes down by its
principal · 02 a lender split that does not add up refused, one that does recorded as the lender's ·
03 a payment that cannot cover the interest refused at the start, and a row dated inside the starting
balance refused · 04 a year's interest from two payments. The postings, net worth and the lender tie
are contract gate 24.

## 9. Out of scope, on purpose

Variable rates and recasts (a new loan from the new figures), escrow account balances, lines of
credit, and payments: these books record what the bank statement shows was paid.
