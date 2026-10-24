# gl — Closing the Books · Area Specification

**Status: 0.1.** The month-end close: a checklist of what stands between a period and its close,
adjusting entries (accruals that reverse, depreciation, corrections), closing a period so its
figures stop moving, and corrections for whatever later changes it. The step from handing a
journal to someone else's ledger towards carrying the ledger itself.

## 1. Calibration: who this is for

A small business and its accountant, closing monthly or quarterly. The accountant wants the
numbers they reported for September to still be September's numbers in December, and anything
that changed since to show up as a change, not as a silent rewrite. The owner wants to know what
is left to do before the month can close.

## 2. Scope

In: the close checklist, adjusting entries (with optional reversal on the first day of the next
month), closing a period, reopening the latest close, and corrections in the first open period.

Out (§9): a fixed asset register and depreciation schedules, recurring entries, budgets,
consolidation, year-end retained earnings roll-forward, tax filings.

## 3. Entities and lifecycles

- **adjusting entry**: a dated, balanced entry the accountant or the agent records with a
  reason: each line names an account, says what kind it is (asset, liability, equity, income,
  expense) and carries a debit or a credit. Dated in an open period only. An accrual can be
  marked to reverse: its reversal appears on the first day of the next month. Voided with a
  reason while its period is open; never edited.
- **close**: through a date, by a person, with a reason. At that moment the journal for the
  period is kept as it stands: its entries, their count, the debits and a hash. A close can be
  reopened (the latest one only), by a person, with a reason.
- **correction**: derived, never stored. When the record now says something different about a
  closed period than its close kept (a late statement row, a reclassified purchase, a cost
  stated later), the difference per account lands as one entry on the first open day, named
  as a change to closed periods.

## 4. The acts

Writes: record_entry, void_entry, close_period (a person's act), reopen_period (a person's act).

Reads: checklist (what blocks a close through a date, and what is open but not blocking),
entries, closes, changes (the corrections, per account, since each close).

## 5. Invariants

- **GL-1** Money is integer cents; every entry balances, adjusting entries included.
- **GL-2** Closing and reopening are a person's acts, with a reason, refused to an agent
  whatever its role.
- **GL-3** A closed period's journal is what it was at close: the financials and hand-overs for
  it never change afterwards.
- **GL-4** A later change to a closed period lands as a correction on the first open day, per
  account, named; never a silent rewrite.
- **GL-5** Adjusting entries are dated in an open period, balance, carry a reason, and say what
  kind each account is, so the statements can place it.
- **GL-6** An accrual marked to reverse reverses itself on the first day of the next month.
- **GL-7** A close is refused while statement rows in the period are not reviewed or a bank or
  card account does not tie to its statement at the period's end; everything else open is
  listed, not blocking.
- **GL-8** Only the latest close can be reopened.
- **GL-9** Every write is a logged command with an actor; refusals are logged too.

## 6. Required read models

checklist (blocking and open items, each with what to do), entries, closes (through, by whom,
totals, hash, and whether the record has changed since), changes (per account, with the closes
they correct).

## 7. Contract vs freedom

Contract: closing as a person's act; frozen closed periods; corrections on the first open day;
balanced, reasoned adjusting entries. Freedom: how often to close, the account words.

## 8. Conformance (scenarios)

01 an adjusting entry posts and a reversing accrual reverses on the first of next month ·
02 an unbalanced entry and an entry dated in a closed period are refused · 03 the agent cannot
close or reopen · 04 the checklist blocks a close while statement rows are not reviewed.
The person's close, the frozen period and the correction for a late change are contract gate 19,
because scenarios run as an agent.

## 9. Deferred, with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Fixed asset register, depreciation schedules** | Depreciation is an adjusting entry today; a register with methods and lives is its own area. |
| **Recurring entries** | Record each month's entry; a schedule waits for a design partner's pattern. |
| **Year-end roll-forward** | Earnings to date carry on the balance sheet; closing the year into retained earnings comes with year-end. |
| **Budgets, consolidation** | Planning and groups of companies; not this calibration. |
| **Tax filings** | The accountant files; Saybooks gives them closed, tied numbers. |

---

*Change log: 0.1 (2026-10-24) — first version: checklist, adjusting entries with reversal,
closing and reopening, corrections on the first open day.*
