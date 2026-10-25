# purchases — What You Buy · Area Specification

**Status: 0.5.** A spec on the record before a line of module code, so the shape can be
argued with. 0.3 makes the statement's own lines the normal path of import_statement. 0.4 adds
standing rules: what the person says ahead of time, kept as suggestions, never as bookings. 0.5
adds bills: what vendors say is owed, prepared here, approved by a person, paid in their bank.

## 1. Calibration: who this is for

One person, a household, or a very small business that wants to know what it buys, what it
pays for every month without noticing, and whether it has the receipt. The facts arrive as
files: bank and card statements, receipts. Nobody parses them here. The agent reads the file
and states what it read; the module keeps the record, checks that the statement adds up,
refuses what it cannot reconcile, and remembers where every number came from. Agent first:
the import is a batch of rows the agent hands over, never a parser we maintain per bank.

## 2. Scope

In: statements as sources with control totals, transactions traced to their source row,
review and classification, purchases, subscriptions declared and then confirmed by what
actually charges, receipts matched to transactions, spend by category and month, per currency.

Out (§9): bank connections and feeds (files only, by design), currency conversion, budgets,
forecasts, advice, tax treatment of purchases, paying anything.

## 3. Entities and lifecycles

- **source** — one file the agent read: name, a content hash the agent computed, kind
  (bank | card | other), the account label as printed, period start and end, opening and
  closing balance, row count, currency. Immutable once accepted. The same hash is never
  accepted twice.
- **account** (0.6) — an account the person has, in a register: name as its statements print
  it, kind (checking | savings | credit_card | loan | asset | other), currency, institution, last
  four digits, opened and closed days. Every statement belongs to one; importing a statement whose
  label is not in the register adds the account. A card's statements are card statements, a bank
  account's bank statements; an asset (a house, a car) has none. Closed with a day and a reason;
  it stays in the register.
- **value** (0.6) — what something without statements is worth, or what is still owed on it, on a
  day, as the person states it with its source ("county assessment 2026", "lender's payoff
  letter"). Never estimated here.
- **transfer** (0.7) — one move between two of the person's own accounts: the row where money
  left and the row where it arrived, paired by a reasoned act, exactly opposite, in the same
  currency, at most ten days apart. Counted once, as a move from one account into the other;
  neither side is spending or income, and neither can be reviewed again while paired. Unpaired with
  a reason; both rows go back to how they were reviewed. A row reviewed as a transfer naming one of
  the person's accounts, with no pair, is one-sided: waiting for that account's statement, or
  missing from it.
- **card statement facts** (0.8) — what a card statement prints besides its rows: minimum payment,
  payment due date, credit limit, purchase rate. Kept as printed, with the import or after it;
  changing them is a correction with a reason. What is due on a card comes from its latest
  statement's facts; payments seen into the card by the due date (or out of another account toward
  it) meet it in full, meet the minimum, or it is missed. A due date no statement covers yet is
  said to be unseen, never assumed paid.
- **refund** (0.8) — money in tied to the purchase it reverses, by a reasoned act, never more than
  is left of that purchase after earlier refunds. It takes back that much spending in the
  purchase's category and is not income. Unlinked with a reason; the row goes back as it was.
- **expected bill** (0.9) — a vendor whose bill comes every period (monthly, quarterly, yearly), declared
  once from what the person says. Its bills are the vendor's bills on record; its usual amount is the
  median of its recent bills (or what the person said, until there are a few). A period with no bill
  well past its time is named missing; a bill well above the usual amount is named. Ended with a reason.
- **autopay** (0.9) — a person's standing approval for one vendor's bills to be taken from one account.
  Set and stopped only by a person; a bill recorded while it stands is approved by it, and says so.
- **what is due** (0.9) — derived: every recorded obligation in a window by date (bills, card payments,
  loan payments from the loans area, subscriptions' next charges, expected bills not received yet)
  beside the cash on the latest bank statements, with the day it would run short. Not a forecast:
  nothing unrecorded, income included, is assumed.
- **transaction** — one row of a source: date, signed amount in minor units, description as
  printed, counterparty if the row names one, source and row index, the raw line as read.
  Status: unreviewed → purchase | recurring | transfer | income | fee | ignored, set by review
  with a reason; recurring is spending that repeats, and naming its vendor declares the
  subscription. Never edited in amount or date: a wrong row is a wrong source, re-imported after
  the agent re-reads it.
- **purchase** — a transaction reviewed as spending: vendor, category, note, optional
  receipt. Category empty until someone sets it; empty beats guessed.
- **vendor** — a name and its aliases as statements spell it, so the same shop is one vendor.
- **subscription** — a declared recurring charge: vendor, cadence (weekly | monthly | yearly),
  expected amount and currency, tolerance, start. Status: active | cancelled | lapsed.
  Confirmed by matches: each period either has a matching purchase, or shows as missed.
  Lapsed is derived (two periods missed), never asserted; cancelled is an act with a reason.
- **rule** — something the person said ahead of time ("the next five days are the Texas
  conference, book it to travel"): a label, the category and status it suggests, and what it
  matches (a date window, words the statement line contains, a vendor, a currency; at least
  one of window, words or vendor). Status: active | ended, ending is an act with a reason. A
  rule never books a row: it suggests, and the suggestion is computed when rows are read, so
  ending a rule removes its suggestions and leaves every reviewed row as the person confirmed it.
- **bill** — what a vendor says the person owes: the vendor, their invoice number, the bill
  and due dates, the amount and currency as printed, a category in the person's words, the file
  it came from (name and hash; the file stays with the person). open → approved (a person only,
  optionally with a pay-by date) → paid (recorded after the fact with the day it went and how,
  linked to the statement row that shows it) | rejected (with a reason). A bill is a record,
  never a payment.
- **receipt** — an attachment the person gave the agent: file name, hash, vendor, date, total,
  currency. Matched to at most one transaction, by an act with a reason; unmatched is a
  visible state, not an error.

## 4. The acts

Writes (19): import_statement, split_transaction (one row broken into legs that add to it
exactly), rename_category (one word changed on every row that
carries it), discard_source (a wrong read thrown out whole, with a
reason, its hash freed), review_transaction, review_batch (many rows, one reasoned
act, validated whole), set_vendor, add_receipt, match_receipt, declare_subscription,
cancel_subscription, unmatch_receipt, add_rule (a standing rule, with its window, words or
vendor), end_rule (with a reason), accept_suggestions (confirm what rules suggest, one reasoned
act, rows the person rejects left out), add_bill, approve_bill (a person only),
record_bill_payment, reject_bill, add_account, update_account, close_account, record_value (0.6), pair_transfer, unpair_transfer (0.7), set_card_facts, link_refund, unlink_refund (0.8), declare_bill_series, end_bill_series, set_autopay
(a person only) (0.9).
Reads (14): accounts (each with its balance, as of when, and where its statements do not chain),
account, net_worth (held less owed, per currency, each figure dated), transfers (pairs and
one-sided transfers and the suggested pairs, with why), card_dues (each card's balance, minimum, due date,
payments seen and state), card_costs (interest and fees per card and year), refunds (linked, and suggested with why), bill_series,
payables (now also the bills a statement row looks like it paid),
upcoming (what is due beside the cash), vocabulary (the statuses with their meaning,
the person's categories, vendors and active rules — what an agent proposes from), sources,
transactions (each unreviewed row with the suggestion a rule makes for it), purchases,
subscriptions, receipts, spend, source, rules, bills, payables (open bills by when they fall
due, set against the cash on the latest bank statements).

## 5. Invariants

- **P-1** Money is integer minor units, signed; every source and every transaction carries
  a currency; sums are per currency and never cross.
- **P-2** Every transaction traces to a source: source id, row index, and the raw line as
  the agent read it. A transaction without provenance cannot exist.
- **P-3** A statement is accepted whole or not at all. The agent hands over the statement's
  lines as it was given them and states the control totals the statement prints: the opening
  and closing balance always, the row count when one is printed. The batch is refused when
  the rows do not reconcile to them, naming the gap. That is where a transcription error is
  caught. (0.3: the lines as text are the normal path and the hash is computed from them;
  typed rows remain for a statement with no text, and then carry the hash. Five runs out of
  five, a 26B model retyped forty-seven rows into fields when the schema listed fields first.)
- **P-4** The same source (by hash) is refused a second time. Rows already present from an
  overlapping source (same date, amount, description) are skipped and listed in the result,
  never silently merged and never silently duplicated.
- **P-5** Nothing is invented: category, vendor and status are empty or unreviewed until an
  act with a reason sets them. Review is an act, and the reason is part of the record.
- **P-10** One row may break into several categories, and the legs must add to the row exactly
  or the split is refused with the gap named. The row's own amount, date and provenance never
  move: the statement said what it said, and a breakdown is an annotation on top of it.
- **P-11** A standing rule suggests and never books. A row a rule matches stays unreviewed and
  carries the suggestion, the rule's name and id, until a review act confirms it; accepting is
  a review, so it carries a reason and follows the person's confirmation. A rule suggesting
  spending never suggests it for money in, nor income for money out. The most specific rule
  wins (words, then vendor, then the narrowest window), and other matching rules that say
  something different are listed with the suggestion. Ending a rule removes its suggestions and
  changes no reviewed row. A rule must narrow something: one that would match every row is
  refused, as is a window that ends before it starts.
- **P-12** A bill is a record, never a payment: nothing here pays anything. Approving payment is
  a person's act, refused to an agent whatever its role. A payment is recorded only after it
  happened, with the day it went (never in the future), and an agent records one only for an
  approved bill; a person recording it approves it in the same act. A linked statement row must
  be money out, in the bill's currency, for the bill's amount, and pays one bill only; an
  unreviewed row is reviewed as the bill says. The same vendor and invoice number is refused a
  second time, as is a bill with no number that matches another's vendor, amount and date. A
  bill due before its own date is refused. Bills count on a cash basis: the statement row that
  paid one reaches the books, and bills unpaid at a date are named beside the statements.
- **P-6** A subscription is declared, then confirmed by the record: a period with no
  matching purchase is shown as missed — but only once a statement covering that period has
  been read; before that it is "no statement yet". Two missed periods make it lapsed. A vendor
  may carry several subscriptions (different cadence or amount). The module never assumes a
  charge happened.
- **P-7** A receipt matches at most one transaction and a transaction at most one receipt;
  matching is an act with a reason, refused when amounts differ beyond the receipt's stated
  total or dates differ by more than seven days, unless the reason says why.
- **P-8** Every write is a logged act with an actor; refusals are logged too.
- **P-9** Files never live here. A source is its hash, its metadata and its rows; the file
  stays with the person. The record can prove what was read, not re-show the page.

- **P-13** Every statement belongs to one account; an account's statements chain. A gap, an
  overlap or an opening that is not the last closing is named, never smoothed over.
- **P-14** A balance is what a statement printed or a value a person stated, each with its date
  and source. Nothing is extrapolated from rows or estimated.
- **P-15** Net worth is per currency: what is held less what is owed, each line showing as of
  when. A figure older than 45 days is named as old.

- **P-16** A move between two of the person's accounts is one transfer: its two sides paired,
  exactly opposite, counted once, never as spending or income.
- **P-17** Pairing is a reasoned act on rows not already booked otherwise; suggestions never pair;
  unpairing puts both rows back as they were.
- **P-18** A transfer naming one of the person's accounts with no other side is listed, saying
  whether that account's statement should already show it.

- **P-19** A card statement's printed facts are kept as printed; changing them is a correction with
  a reason.
- **P-20** A card payment is due from the statement's facts and met by payments seen into the card
  by the due date; a missed one is named, never assumed paid.
- **P-21** A refund is tied to the purchase it reverses, never more than is left of it; it takes
  back spending in the purchase's category and is not income.
- **P-22** Interest and fees are what rows reviewed as fees say, per card and year; nothing is
  estimated from the rate.

- **P-23** A bill that comes every period is expected: a period with no bill past its usual time is
  named missing, a bill well above its usual amount is named; neither is assumed.
- **P-24** Autopay is a person's standing approval for one vendor's bills from one account, set and
  stopped only by a person; bills under it are approved by it and say so.
- **P-25** What is due lists every recorded obligation in a window beside the cash on the latest
  statements; it is not a forecast: nothing unrecorded is assumed.

## 6. Required read models

sources (what was imported, when, by whom, reconciled), transactions (by period, status,
source), purchases (by vendor, category, month), subscriptions (with next expected charge,
missed periods, derived status), receipts (matched and unmatched), spend (by category and by
month, per currency), source (one source with its rows and the reconciliation).

## 7. Contract vs freedom

Contract: batch-or-nothing with control totals, provenance on every row, per-currency sums,
declared-then-confirmed subscriptions, matching as a reasoned act, hash-refused re-imports.
Freedom: category vocabulary (the person's words), vendor alias rules, tolerances, how the
agent reads a given bank's layout, which files count as receipts.

## 8. Conformance (scenarios)

01 a card statement imported whole: control totals reconcile; a second import of the same
hash refused; a transposed amount refused with the gap named · 02 overlapping statements:
rows already present skipped and listed, new rows in · 03 subscriptions: declared from a
purchase, confirmed by the next month's charge, missed when it does not come, lapsed after
two · 04 receipts: added, matched with a reason, a mismatched total refused, unmatched shown ·
05 splitting: a payroll line broken into wages, employer taxes and the processor's fee; legs
that do not add up refused with the gap named; the row itself unchanged · 08 standing rules:
a conference rule recorded before the statement, the statement's rows in the window suggested
as travel (a refund in the same window not), the suggestions accepted in one act, a second
accept refused, a rule that narrows nothing refused, the rule ended · 09 bills: a vendor's
bill recorded, the same one forwarded twice refused, one due before its date refused, one with
no due date and no terms refused; approval refused to the agent; a payment refused before
approval; what is coming due set against the latest statement; a bill rejected with a reason ·
10 accounts: two statements file under the same account by their label, and the missing month
and the jump between them are named · 11 net worth: a checking balance and a card balance from
their statements, a house from a value stated with its source, net worth as held less owed · 12
a bank balance stated by hand refused, and a card statement refused on a checking account · 13
a card payment from checking: suggested, paired with a reason, listed once, the paired row refused
a second review · 14 a pair that does not add up, two rows on one account, and a row reviewed as a
purchase refused · 15 a one-sided transfer whose other half the card's statement should show · 16
a card statement imported with its facts, paid in full from checking by the due date; facts refused
on a bank statement and a second recording refused without a reason · 17 a missed card payment
named once a statement covers the due date, and the year's interest from rows reviewed as fees · 18
a refund suggested, linked to its purchase, more than is left refused, the refund closed to review ·
19 an expected electric bill: a bill well above the usual named, and the missing month named · 20 autopay
refused to the agent · 21 what is due: a bill and a subscription's next charge beside the cash, and the
statement row that paid a bill suggested.

## 9. Deferred — with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Bank connections / feeds** | Files are the honest boundary: the person chooses what the agent sees, and every import is a deliberate act. A feed is a standing permission, which is a different product. |
| **Currency conversion** | Same whole-area concern as everywhere; sums stay per currency. |
| **Budgets, forecasts, advice** | Saybooks records; it does not counsel. A budget is policy the person owns. |
| **Business expense treatment** | Tax deductibility varies by country and status; recording what was bought is our part. The postings themselves reach the accountant's ledger through the bridge area (0.2): a reviewed purchase debits its category and credits the account it was paid from. |
| **Reading receipts (OCR)** | The agent reads; the module records what it says. No image pipeline here. |

---

*Change log: 0.9 (2026-10-25) — household bills: expected bills with missing and unusual ones named,
autopay as a person's standing approval, bill payments suggested, and what is due beside the cash;
part E of the personal finances plan. 0.8 (2026-10-25) — credit cards: statement facts kept, what is due and whether it was
met, interest and fees per year, refunds tied to their purchase, fees posting to their own word;
part C of the personal finances plan. 0.7 (2026-10-25) — transfers between the person's own accounts: the two sides paired
and counted once, suggestions, one-sided transfers named; part B of the personal finances plan.
0.6 (2026-10-25) — accounts: a register statements belong to, values stated for
things without statements, balances that say where they come from, statement chains checked, and
net worth; part A of the personal finances plan (docs/plan-personal-finances.md). 0.5 (2026-10-07) — bills prepared for approval, from Aryeh Munk's phase 1 list
("Enable AI to make payments, process invoices"), reshaped so nothing pays: the agent prepares,
a person approves, the bank pays, the record follows. 0.4 (2026-10-07) — standing rules, from Aryeh Munk's phase 1 list ("I am
traveling these next 5 days for conference, book to Texas conference"), kept as suggestions
so P-5 still holds. 0.2 (2026-09-10) — splitting one row into legs that add to it exactly, for payroll
runs and mixed receipts, prompted by a demo session pointing out that one lump to one account
would annoy a bookkeeper. 0.1-draft (2026-09-06) — drafted from Peter's and Pavan's "my purchases" idea,
with the agent-first import discipline agreed the same day: no parsers, batch-or-nothing,
control totals, provenance, refusals.*
