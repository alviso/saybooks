# bankrec — Bank Reconciliation · Area Specification

**Status: 0.1.** The bank statement against the books, per account and statement: every
difference named, every deposit tied to the payment it is, and a reconciliation a person signs.
The check an accountant makes first, on the statements these books already import.

## 1. Calibration: who this is for

A small business and its accountant. The owner records a customer's payment the day the
remittance arrives; the bank shows it days later, sometimes as one deposit for three checks. The
accountant wants to see, for the statement ending on a day: the bank's balance, the books'
balance, and the short list of items that explain the gap, each one named. Then a person's
sign-off that it was looked at.

## 2. Scope

In: matching a statement row to the payments and refunds recorded here (one row to one or more),
the reconciliation of an account at a statement's end, suggestions for matches, a person's
sign-off kept as it stood, and whether the record has changed since.

Out (§9): bank feeds, matching statement rows to bills or adjusting entries (bills already link
their payment's row), cash on hand, foreign currency revaluation, undoing a sign-off.

## 3. Entities and lifecycles

- **cash item**: money recorded in these books that moves through a bank account without coming
  from a statement: a customer payment (o2c or solo) and a refund. Owned by the areas that record
  them; this area reads them through their api. Signed: money in positive.
- **match**: one statement row and the cash items it is, by an agent or a person, with a reason.
  The items must add up to the row exactly. The row then posts nothing itself (the payment already
  did): it is reviewed as money recorded elsewhere, and it cannot be reviewed again while matched.
  Unmatched with a reason; the row goes back to what it was.
- **reconciliation**: derived, never stored, for an account through a statement's last day:
  - the statement's closing balance,
  - the books' balance (the first statement's opening, plus every row that posts, plus the cash
    items that landed in the account),
  - and the items between them:
    - recorded here, not on the statement yet (in transit);
    - on the statement, not in the books (rows not reviewed, rows marked ignored, rows marked as
      recorded elsewhere but matched to nothing);
    - timing (matched rows whose payment is dated after the statement).
  - The difference left over is zero when the statements chain; anything else is named.
- **sign-off**: a person's word that a reconciliation was looked at, through a statement's last
  day, with a reason. Kept as it stood: the figures, the items and a hash. Never withdrawn; a later
  change shows as changed since.

## 4. The acts

Writes: match, unmatch, sign_off (a person's act).

Reads: accounts (each bank and card account with its latest statement and whether it is
reconciled), reconciliation (an account through a statement's last day), candidates (suggested
matches, with why), signoffs.

## 5. Invariants

- **REC-1** Money is integer cents; a match adds up to its row exactly, in the row's currency.
- **REC-2** Statement balance = books − recorded here and not on the statement + on the statement
  and not in the books (timing included); a difference left over is named, never absorbed.
- **REC-3** A matched row posts nothing itself and cannot be reviewed again while matched; no
  payment or row is in two matches.
- **REC-4** Only a row that posts nothing (not reviewed, or money recorded elsewhere) can be
  matched; a row already booked as income or spending is refused, naming what it is.
- **REC-5** Signing off is a person's act, with a reason, refused to an agent whatever its role,
  and refused while the difference is not zero or a row on the statement is not accounted for.
- **REC-6** A sign-off keeps the reconciliation as it stood; a later change shows as changed since,
  never as a silent rewrite.
- **REC-7** Suggestions suggest, never match.
- **REC-8** Every write is a logged command with an actor; refusals are logged too.

## 6. Required read models

accounts, reconciliation (the three item lists with their totals, the difference, what blocks a
sign-off), candidates (per unmatched row: the cash items that fit, by amount, date and name),
signoffs (with whether the record has changed since each).

## 7. Contract vs freedom

Contract: exact matches, a named difference, the person's sign-off, kept as it stood. Freedom:
how the agent finds matches, how often to reconcile.

## 8. Conformance (scenarios)

01 a deposit is matched to its payment and stops being left out · 02 a match that does not add
up, or a row already booked, is refused · 03 a payment not yet on the statement is listed in
transit and the reconciliation ties · 04 the agent cannot sign off. The person's sign-off and the
changed-since check are contract gate 20, because scenarios run as an agent.

## 9. Out of scope, on purpose

Bank feeds (statements arrive as files the agent reads), matching rows to bills (a bill's payment
already links its row), cash on hand, revaluing foreign currency, and withdrawing a sign-off: a
sign-off is a record of what someone looked at, and a later change shows as one.
