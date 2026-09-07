# purchases — What You Buy · Area Specification

**Status: 0.1-draft.** A spec on the record before a line of module code, so the shape can be
argued with. No module implements it yet.

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
- **receipt** — an attachment the person gave the agent: file name, hash, vendor, date, total,
  currency. Matched to at most one transaction, by an act with a reason; unmatched is a
  visible state, not an error.

## 4. The acts

Writes (10): import_statement, discard_source (a wrong read thrown out whole, with a
reason, its hash freed), review_transaction, review_batch (many rows, one reasoned
act, validated whole), set_vendor, add_receipt, match_receipt, declare_subscription,
cancel_subscription, unmatch_receipt. Reads (8): vocabulary (the statuses with their meaning,
the person's categories and vendors — what an agent proposes from), sources, transactions,
purchases, subscriptions, receipts, spend, source.

## 5. Invariants

- **P-1** Money is integer minor units, signed; every source and every transaction carries
  a currency; sums are per currency and never cross.
- **P-2** Every transaction traces to a source: source id, row index, and the raw line as
  the agent read it. A transaction without provenance cannot exist.
- **P-3** A statement is accepted whole or not at all. The agent states the control totals
  the statement prints — opening balance, closing balance, row count — and the batch is
  refused when the rows do not reconcile to them, naming the gap. That is where a
  transcription error is caught.
- **P-4** The same source (by hash) is refused a second time. Rows already present from an
  overlapping source (same date, amount, description) are skipped and listed in the result,
  never silently merged and never silently duplicated.
- **P-5** Nothing is invented: category, vendor and status are empty or unreviewed until an
  act with a reason sets them. Review is an act, and the reason is part of the record.
- **P-6** A subscription is declared, then confirmed by the record: a period with no
  matching purchase is shown as missed; two missed periods make it lapsed. The module never
  assumes a charge happened.
- **P-7** A receipt matches at most one transaction and a transaction at most one receipt;
  matching is an act with a reason, refused when amounts differ beyond the receipt's stated
  total or dates differ by more than seven days, unless the reason says why.
- **P-8** Every write is a logged act with an actor; refusals are logged too.
- **P-9** Files never live here. A source is its hash, its metadata and its rows; the file
  stays with the person. The record can prove what was read, not re-show the page.

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
two · 04 receipts: added, matched with a reason, a mismatched total refused, unmatched shown.

## 9. Deferred — with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Bank connections / feeds** | Files are the honest boundary: the person chooses what the agent sees, and every import is a deliberate act. A feed is a standing permission, which is a different product. |
| **Currency conversion** | Same whole-area concern as everywhere; sums stay per currency. |
| **Budgets, forecasts, advice** | Saybooks records; it does not counsel. A budget is policy the person owns. |
| **Business expense treatment** | Tax deductibility varies by country and status; recording what was bought is our part. |
| **Reading receipts (OCR)** | The agent reads; the module records what it says. No image pipeline here. |

---

*Change log: 0.1-draft (2026-09-06) — drafted from Peter's and Pavan's "my purchases" idea,
with the agent-first import discipline agreed the same day: no parsers, batch-or-nothing,
control totals, provenance, refusals.*
