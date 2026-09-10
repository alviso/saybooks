# bridge — The Ledger Bridge · Area Specification

**Status: 0.1.** The hand-over to the ledger of record.

Saybooks owns operational truth and derives balanced journal lines from it (`core_journal`).
The LEDGER OF RECORD — QuickBooks Online, Xero, an accountant's own system — owns the chart
of accounts, manual journals, adjustments, and the close. The bridge is how the first feeds
the second. We never compete with the ledger; we make it better fed than it has ever been.

## 1. Calibration: who this is for

The person keeping the books, and the accountant who receives them. The accountant supplies
the chart: codes and names as their system spells them. The person hands over a period and
gets a file their ledger imports. Neither has to re-key anything, and both can answer "what
did the ledger already get?" from the record.

## 2. Scope

In: mapping our fixed derivation accounts onto their chart; building the journal for a period
in the shape the target imports (Xero manual journal CSV, QuickBooks Online journal entries
CSV, plain CSV); recording every hand-over with its control totals and the exact file.

Out (§9): posting into the ledger over an API, pulling anything back, the chart itself, manual
journals, adjustments, the close, currency conversion, cost of goods and inventory.

## 3. What it is

1. **Account mapping** — our fixed derivation accounts (Accounts Receivable, Sales Revenue,
   Service Revenue, Sales Tax Payable, Cash, Customer Deposits, Customer Credits, Sales
   Returns & Allowances, Bad Debt Expense; later the p2p set: Inventory, GRNI, AP, COGS,
   price variance) mapped onto the customer's REAL chart. The mapping is workspace config,
   set once with the accountant, logged like everything else.
2. **Export formats** — journal entries in the shapes the targets actually import
   (Xero manual-journal CSV; QBO journal import; plain CSV for everyone else). Exact field
   layouts to be pinned against live trials, not documentation.
3. **Hand-over tracking** — what has been exported, through when. The journal itself stays
   a pure derivation (re-derivation is the truth); the bridge records the hand-over so
   month-end is a diff against last export, not a re-key and not a duplicate import.
   Late-arriving or voided facts after an export produce a visible correction entry in the
   next export, never a silent rewrite of the past.

## 3. What it is not

No chart of accounts of our own. No manual journals. No close. No bank feeds — the CSV
import on unapplied cash is the honest boundary, and bank-feed integrations remain the moat
we say out loud we have not crossed.

## Acceptance test (the plan)

- **Xero demo company**: free, resettable, imports manual journals — the primary target.
  Export a month of the demo fixture's books, import, verify the trial balance ties to
  `core_journal`'s totals and AR ties to `o2c_ar_aging`.
- **QBO trial account**: same exercise against QBO's journal import; document plan-level
  quirks honestly (import availability differs by plan/region).
- The acceptance bar: an accountant who has never seen Saybooks can take one export file
  and land it in their ledger without asking us anything.

## 5. Entities and lifecycles

- **account map** — one row per derivation account: their code (Xero matches on it), their
  name (QuickBooks matches on it), the tax rate label their import expects, a note. Config,
  changed by a logged act. Changing it never rewrites a hand-over that already went out.
- **export** — one hand-over: format, period, entry and line counts, control totals, a hash,
  and the file exactly as it went out, at a capability link. Immutable.

## 6. The acts

Writes (2): map_account, export. Reads (3): accounts (our accounts, which the books use, how
each is mapped, which formats are ready), preview (the period in the target's shape with its
totals and anything unmapped; records nothing), exports (what has been handed over, through
when). Environment: core's journal derivation, and whatever module produced the facts.

## 7. Invariants

- **B-1** The journal is a derivation, never a posting. An export reads it and changes nothing
  in the books; re-derivation stays the truth.
- **B-2** Money is integer minor units. Every export balances: debits equal credits, per entry
  and in total.
- **B-3** One currency per hand-over. A period holding more than one is refused until a
  currency is named; sums never cross currencies.
- **B-4** An export is refused while an account the period uses has no mapping the chosen
  format needs, naming the accounts and which field is missing.
- **B-5** Every hand-over records its format, period, entry and line counts, control totals, a
  hash and the actor, and keeps the file exactly as it went out.
- **B-6** Omitting the period start continues from the last hand-over in that format: month-end
  is a diff, not a re-key.
- **B-7** Re-exporting a period that has already gone over is allowed and always visible: the
  result names the earlier hand-over and says whether the numbers have changed since.
- **B-8** The chart is theirs. Codes and names come from the accountant; nothing is invented.
- **B-9** Every write is a logged act with an actor; refusals are logged too.

## 8. Conformance (scenarios)

01 the first hand-over: an invoice, a payment and its application; the accounts read shows what
is in use and unmapped; the export is refused naming them; the accountant's codes are written;
the preview is ready; the export records the hand-over and returns a link · 02 the month after:
a second period continues from the last hand-over without a start date, a re-export of a period
already sent is allowed and says so, and the plain CSV needs no chart at all.

## 9. Deferred — with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Posting over an API (QBO/Xero apps)** | A file a person reviews and imports is the honest boundary for a system that is not the ledger. An API posting is a standing write permission into someone's books; it needs their app review and their consent, not ours. |
| **Automatic correction entries** | A fact that changes after a period went over shows as a visible re-export today. Deriving a reversing entry pair instead needs the accountant's convention, not ours. |
| **Their chart, pulled** | Reading the chart from the ledger would remove the typing, and it needs the same API connection as posting. |
| **Cost of goods, inventory** | Items carry no cost; the ledger of record owns margin. |
| **Currency conversion** | Sums are per currency and never cross. A rate and a policy belong to the ledger. |

---

*Change log: 0.0-sketch (2026-08) — a goal on the record. 0.1 (2026-09-10) — built: the account
map, three export shapes, hand-over tracking with control totals and the exact file. Prompted
by an accounting firm asking whether it syncs with QuickBooks or Xero; the honest answer was
"it derives the lines but cannot hand them over yet", so that was the thing to build. Layouts
follow the published import templates and want one live trial each; the formats are a table in
`src/modules/bridge/views.js`, so a correction is a data change.*
