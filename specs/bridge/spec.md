# bridge — The Ledger Bridge · Goal Sketch

**Status: 0.0-sketch. A goal on the record, not yet a spec.**

Saybooks owns operational truth and derives balanced journal lines from it (`core_journal`).
The LEDGER OF RECORD — QuickBooks Online, Xero, an accountant's own system — owns the chart
of accounts, manual journals, adjustments, and the close. The bridge is how the first feeds
the second. We never compete with the ledger; we make it better fed than it has ever been.

## What it is

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

## What it is not

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

---

*Change log: 0.0-sketch (2026-08-24) — recorded as a goal after the o2c 0.2 journal work,
so the "operating layer in front of the books" positioning has its roadmap on paper.*
