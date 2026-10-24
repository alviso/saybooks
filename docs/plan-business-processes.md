# Business processes: plan

Extend Saybooks into the logistics and finance processes a small business and its
accountant run every month. Each process is specified, built, proven by scenarios, written
up on the site, and shown in a short narrated video. Started 24 October 2026.

## The loop, per process

1. **Spec.** Update or write the area spec: acts, invariants, conformance scenarios. Open
   questions get a recommended answer before code.
2. **Build.** Commands, views and screens from the registry, as every module so far.
3. **Prove.** Scenarios replay on every build; the contract suite and the smoke test pass.
4. **Site.** Everything the site says stays complete and true (checklist below).
5. **Demo data.** Sam's Supply Co. gets the records the video needs.
6. **Video.** About two minutes, same voice and recorder as the first series.
7. **Review.** Peter watches and approves. Nothing deploys or publishes before that, and
   the next process starts after it, at whatever pace that review needs.

## Site checklist, per process

- Spec page: comes from `specs/<area>/spec.md` (check it renders, specs index included).
- Docs: the process in plain words, with what an agent may and may not do.
- Home page numbers: commands, modules, invariants, scenarios, contract gates.
- Module page, if the process belongs to one with its own page.
- Privacy page, when the process stores a new kind of data.
- README tool counts, sitemap for any new page.

## The processes, in order

| # | Process | What it adds | Why now |
|---|---|---|---|
| 1 | Purchase orders and receiving | POs, goods receipts, the 3-way match on bill approval, goods received not invoiced, item cost from receipts | The p2p spec exists as a draft; Puzzle doesn't serve stock businesses; Sam's Supply Co. buys stock |
| 2 | Inventory and stock value | Stock movements, counts and adjustments, stock valuation, cost of goods sold on each shipment | Completes the cost side of the books that process 1 starts |
| 3 | Month-end close | Posting and locking a period, adjusting entries (accruals, depreciation), a close checklist | The step toward carrying the ledger itself (Aryeh's QuickBooks preference) |
| 4 | Bank reconciliation | Statement against the books per period, open items, a signed-off reconciliation | What an accountant checks first; builds on statements already imported |
| 5 | Sales tax | Tax collected per period and jurisdiction, the liability, the filing recorded | Invoices already carry tax; this closes the loop |

Each row is one spec and one video. The order can change after any review.

## Process 1: purchase orders and receiving

Starts from `specs/p2p/spec.md` (0.1 draft, 24 August). Recommended answers to its open
questions:

- **One bill, not two.** The purchases module already records bills, approves them by a
  person only, and records payment against the statement row. p2p adds purchase orders and
  receipts, and a bill can point at a PO. A bill with PO lines must pass the 3-way match
  before a person can approve it; a bill without one works as today.
- **Approval stays a person's act** (as today), under the existing permission, not a new tag.
- **Goods received not invoiced always**, even for the smallest books: it is derived, and
  hiding it is how month-end surprises happen.
- **2-way match for unstocked lines**: services have no receipt.
- **Deferred as the spec says**: landed cost, FIFO, multi-currency, requisition chains.

Video outline: Sam orders shelving stock from a supplier through Claude; the PO is issued;
part of it arrives and is received; the bill comes in higher than the PO price; approval is
refused with the numbers; Sam settles it with the supplier, the corrected bill matches, Sam
approves; the ledger shows inventory and goods received not invoiced moving as they should.
