# o2c — Order to Cash · Area Specification

| | |
|---|---|
| **Version** | 0.1-draft |
| **Status** | curated draft — not yet frozen; implementation conformance not yet enforced |
| **Curator** | Peter Varga (single editor; changes arrive as spec PRs, separate from implementation PRs) |
| **Calibration** | between toy and SAP: usable by a real SMB, honest about what is deferred |

This document is the contract all implementations of the o2c area share. It specifies
**business acts, invariants, lifecycles, and required read models** — never screens, schemas,
or workflows. Anything two reasonable implementations might do differently is marked
**freedom**; everything else is contract. Scenario files under `scenarios/` are the executable
part: an implementation that passes them, provides the acts, and violates no invariant
conforms.

---

## 1. Calibration: who this is for

A company of roughly 5–200 people selling **goods and/or services on account**: distributors,
wholesalers, field-service firms, light assembly. One legal entity, one currency, one
warehouse. Customers buy on credit terms, pay by ACH/check/wire/card, sometimes short-pay,
sometimes return goods, occasionally never pay. The company has a bookkeeper or controller,
not an AR department.

The reference points, so the line is honest:

- **Above toy**: partial fulfilment and backorders, credit memos, returns with restocking,
  short-pay resolution, cash application with unapplied cash, write-offs, sales tax capture,
  customer statements, an aging that a controller would actually open. A system missing any
  of these gets replaced within a year of real use.
- **Below SAP/NetSuite**: no multi-entity, no multi-currency, no revenue recognition, no
  configurable approval workflows, no warehouse management (bins, waves, picks), no
  tax-jurisdiction engine, no EDI. These are named in §9 as *deferred* or *rejected*, each
  with a reason.

## 2. Scope

**In scope (contract):** quotation → order (credit-gated) → fulfilment (partial-friendly, for
goods and services) → billing (from fulfilment) → credits & returns → cash (receipt,
application, refund, write-off) → the read models a controller needs.

**Deferred** (§9): down payments/deposits, early-payment discounts, multi-currency,
recurring billing, consignment, drop-ship, price lists as first-class objects, promise-to-pay
tracking.

**Rejected — permanent non-goals for this area:**
- **Outbound side effects.** o2c records reality; it never emails an invoice, charges a card,
  or books a shipment. Rendering and dispatch belong to other modules/integrations.
- **Payment processing.** Money moves elsewhere; o2c records that it moved.
- **Tax determination.** o2c *captures and freezes* tax per line (§5 INV-14); computing the
  right rate for a jurisdiction is an integration's job.

## 3. Entities and lifecycles

Implementations own their schemas. The spec fixes only the entities' *existence*, their
lifecycle states, and the transitions — because acts and invariants are written against them.

| Entity | Lifecycle |
|---|---|
| quote | `draft → sent → accepted` (raises a draft order) — or `expired` (terminal) |
| order | `draft → confirmed → (partially fulfilled…) → closed` — or `cancelled` (terminal, only if nothing fulfilled) |
| fulfilment | immutable once recorded (a fact, not a workflow object) |
| invoice | `open → paid` — or `void` (terminal, only if nothing applied) |
| credit note | `open → settled` (fully applied and/or refunded) |
| payment | no states — a fact with a derived unapplied balance |
| return | immutable once recorded; linked to a credit note |

`closed` on an order is **derived**: every line fully fulfilled and fully billed (or closed
short). There is no "close order" act (INV-20).

**Master data** (customer, item, stock) is *expected from the environment* — in the reference
implementation, the `core` module. o2c requires: customers with terms, credit limit and hold
flag; items with list price and a stocked/service distinction; a stock quantity that o2c can
check and deplete only through the owner's API. Changing a credit limit and holding/releasing
a customer must themselves be logged acts of the environment.

## 4. The acts

Acts are named abstractly (`confirm_order`); an implementation exposes each as a command under
its own prefix (reference: `o2c_confirm_order`). A conforming module publishes a map
act → command. **Required arguments are contract** (agents and scenario files depend on them);
implementations may add optional arguments freely. Every act's refusals must satisfy INV-17
(name the numbers) and INV-18 (same sentence on every surface).

### 4.1 Quoting

**`create_quote`** (customer, lines[item, qty, unit_price?], valid_until?)
Commits nothing: no stock reserved, no credit consumed. Omitted `unit_price` takes the list
price; an explicit one is a visible discount (INV-2). *Freedom:* quote revisions/versions,
approval before send.

**`send_quote`** (quote) — records that it went out (no outbound side effect). Only from `draft`.

**`accept_quote`** (quote, po_ref?) — records the customer's acceptance and raises a **draft**
order carrying the quoted prices, frozen (INV-19). Refused for expired quotes and quotes
already accepted. Acceptance is the customer's act; confirmation (credit) is ours.

### 4.2 Orders

**`create_order`** (customer, lines, po_ref?) — direct order without a quote, for repeat and
phone business. Negotiated pricing should have gone through a quote.

**`amend_order`** (order, lines) — replace/add/remove lines **while draft only**. After
confirmation the only permitted shrink is `close_short`; growth is a new order. This keeps
"what was confirmed" a fixed fact the credit gate evaluated (INV-3).

**`confirm_order`** (order) — the credit gate, and the only one (INV-5). Exposure =
open AR + value confirmed-but-uninvoiced. Refused when the customer is on hold or the limit
is short — naming order value, limit, open AR, committed value, and the shortfall. *Freedom:*
whether unapplied cash/credits offset exposure; approval-override flows (which must themselves
be logged acts).

**`cancel_order`** (order, reason) — only while nothing has been fulfilled. After that, the
path is fulfil/bill/credit-note (INV-11).

**`close_short`** (order, lines?, reason) — cancel the *open remainder* of a partially
fulfilled order (all lines or named ones). This is how backorders die honestly: the customer
is no longer owed the difference, and the aging of open quantity stops. Releases committed
credit exposure.

### 4.3 Fulfilment

**`fulfil_order`** (order, lines?[order_line, qty], carrier?, tracking?)
Records fulfilment against a confirmed order; omitting lines fulfils everything open.
Goods lines deplete stock **through the stock owner's API** and are refused (per line, naming
on-hand vs needed) rather than going negative; service lines mark work performed and touch no
stock (INV-6). Partial fulfilment is normal and leaves the remainder open — never silently
reduce the ordered quantity (INV-7). Reference implementation calls this `ship`; the spec
name is `fulfil` because services never see a truck.

### 4.4 Billing

**`invoice_fulfilled`** (order) — one invoice for everything fulfilled and not yet billed on
the order. **We bill what was fulfilled, never what was ordered** (INV-4) — this is a spec
decision, not an Odoo-style policy toggle, because it is what keeps every invoice line
traceable to a fulfilment and AR reconcilable. Due date derives from the customer's terms at
issuance (INV-15). Tax per line is computed and frozen here (INV-14). *Freedom:* invoicing
cadence (per fulfilment, daily batch, monthly consolidated per customer) — provided each
invoice line still traces to fulfilment.

**`void_invoice`** (invoice, reason) — only while nothing is applied to it; releases the
billed quantities back to billable. Anything already paid against is corrected by credit note,
never voided (INV-10). The number is never reused (INV-9).

### 4.5 Credits and returns

**`record_return`** (order or invoice ref, lines[qty, restock: bool], reason)
Records goods coming back. Restocking increments stock through the owner's API **only for
lines flagged restock** — damaged goods physically exist but never re-enter sellable stock
(INV-12). Produces (or links to) a credit note for the returned value.

**`create_credit_note`** (customer, ref: invoice|return|none, lines or amount, reason,
kind: correction|return|goodwill|write_off)
The universal downward correction (INV-11): pricing errors, short-pay resolution, returns,
goodwill. A credit note is an AR instrument with its own open balance — it can be **applied**
to invoices like a payment, or **refunded**. Standalone credit notes (no invoice ref) are
allowed but require a reason; *freedom:* approval thresholds by kind and amount.

**`write_off`** (invoice, reason) — closes an uncollectible open balance as a visible,
reasoned credit act (kind `write_off`) — never a deletion, never silent (INV-16). *Freedom:*
the small-balance auto-threshold; who may write off above it.

### 4.6 Cash

**`record_payment`** (customer, amount, method?, reference?, received_at?)
Records money received. Recording and applying are separate acts (INV-8): a payment with no
remittance advice sits as **unapplied cash**, a correct and visible state. Never guess an
application to tidy the aging.

**`apply_payment`** (payment, invoice, amount?) / **`apply_credit`** (credit_note, invoice, amount?)
Bounded on both sides — never more than the instrument has left, never more than the invoice
still owes — with refusals naming both numbers (INV-17). Cross-customer application is
refused (INV-13). Omitted amount applies the smaller remaining side. A short-paid invoice
stays open for the difference; the difference is *resolved* (credit note if justified,
dunning if not), never fudged.

**`refund`** (payment or credit_note, amount, method?, reference?) — records money returned
against an unapplied balance. Records the fact; moving the money is out of scope.

### Act count and module budget

18 write acts + 7 read models ≈ the 25-tool budget. That is deliberate pressure: an
implementation adding many extension commands should split (e.g. sales vs AR) into two
modules mounted together, rather than breach the budget.

## 5. Invariants

The heart of the spec. Doctrine strings in implementations should *quote* these.

1. **INV-1 Money** is integer minor units, everywhere. A float is a bug, not a rounding choice.
2. **INV-2 Both prices survive.** Every document line preserves list price *and* charged
   price; a discount is always derivable, never implicit.
3. **INV-3 Documents don't mutate past draft** except through defined acts. There is no
   "edit" on a confirmed order or issued invoice.
4. **INV-4 Bill what was fulfilled, never what was ordered.** Every invoice line traces to a
   fulfilment line.
5. **INV-5 One credit gate**, at confirmation. Exposure counts open AR **plus**
   confirmed-but-uninvoiced value. Routing around a refusal (splitting, early invoicing,
   quiet limit raises) is a human decision, logged as its own act.
6. **INV-6 Stock never goes negative**, and only the stock owner's API changes it. Service
   lines never touch stock.
7. **INV-7 Short fulfilment leaves the remainder open.** The open quantity *is* the record
   that the customer is still owed; only `close_short` may extinguish it, with a reason.
8. **INV-8 Recording cash ≠ applying cash.** Unapplied cash is a valid, visible, first-class
   state.
9. **INV-9 Document numbers are sequential and never reused.** A void keeps its number and
   its lines. Nothing is ever deleted.
10. **INV-10 Void only when untouched.** An invoice with any application is corrected by
    credit note, because the money moved and the record must keep saying so.
11. **INV-11 The credit note is the only downward correction** for anything past draft.
12. **INV-12 Restock only what physically returns sellable.** Damaged returns are recorded
    but never re-enter stock.
13. **INV-13 Cash is not transferable between customers.** Applications stay within one
    customer's instruments and invoices.
14. **INV-14 Tax is frozen at issuance.** Each invoice line carries rate and amount as
    charged; later rate changes never touch issued documents. (Rate *determination* is
    freedom; capture is contract.)
15. **INV-15 Due dates derive from terms at issuance**; changing a customer's terms never
    retro-adjusts issued invoices.
16. **INV-16 Write-offs are reasoned, visible credit acts** — never deletions, never silent.
17. **INV-17 Refusals name the numbers.** "Short by $1,500 (limit … less …)" — written to be
    shown to a person, verbatim.
18. **INV-18 One sentence per rule.** The greyed button's tooltip, the next-actions reason,
    and the thrown refusal are the same string.
19. **INV-19 Prices freeze when a document is raised from another** (quote → order); list
    price changes never rewrite live documents.
20. **INV-20 Closure is derived, not declared.** Orders close when fully fulfilled+billed
    (or closed short); invoices become paid when fully applied. No manual "mark as done".
21. **INV-21 Every write is a logged command with an actor**; refusals are logged too. Reads
    are never logged.

## 6. Required read models

Named views the area must answer without the caller assembling rows. Shapes are freedom;
*content* is contract.

| Read model | Must answer |
|---|---|
| `order` | lines with ordered/fulfilled/billed quantities, linked fulfilments & invoices, open + unbilled value, available next actions with refusal reasons |
| `customer_position` | credit limit, open AR, committed (confirmed-unbilled), unapplied cash & credits, available credit, hold state |
| `invoice` | lines with tax, applications received, open balance |
| `backorders` | all open confirmed quantities, by item and by customer — the "what do we owe whom" view |
| `ar_aging` | open balances bucketed current/1-30/31-60/61-90/90+ by due date, with invoice-level detail — net of nothing (unapplied cash shown separately, INV-8) |
| `unapplied_cash` | payments and credit notes with remaining balances |
| `customer_statement` | one customer, period-bounded: opening balance, invoices, credits, payments, closing balance — the document a controller sends monthly (rendering is out of scope; content is not) |

The **dunning worklist** is `ar_aging` detail sorted by overdue severity with contact data —
a view over required data, listed here so no implementation forgets why aging exists.

## 7. Contract vs freedom — summary

| Contract | Freedom |
|---|---|
| the 18 acts, their required args, their refusal semantics | extension commands (own prefix), extra optional args |
| lifecycles in §3, all 21 invariants | schema, storage, id formats (prefixes) |
| read model *content* (§6) | read model shape, pagination, extra views |
| credit gate exists at confirm; exposure ≥ open AR + committed | exact formula extras (offsets), override/approval flows |
| tax captured & frozen per line | tax rate determination |
| bill-from-fulfilment | invoicing cadence/consolidation |
| refusal text = one sentence, with numbers | wording style beyond that |

## 8. Conformance

An implementation conforms when:

1. **Acts** — it publishes an act → command map covering §4, each with the required args.
2. **Scenarios** — it passes every file under `scenarios/`. Scenario steps name *acts*, not
   commands; the runner resolves them through the map. Steps assert `ok` (with expected
   fields) or `refused` (with a substring the message must contain — refusals are contract).
3. **Invariants** — the area contract test asserts what is mechanically checkable (INV-1, 9,
   18, 21 and the parity/ownership/namespace gates already in `test/contract.test.js`); the
   rest are enforced by scenarios and review.

Scenario file shape (executable; see `scenarios/*.json`):

```json
{ "name": "…", "spec": "o2c@0.1",
  "steps": [
    { "act": "confirm_order", "args": { "order": "SO-0001" },
      "expect": { "ok": true, "include": { "status": "confirmed" } } },
    { "act": "confirm_order", "args": { "order": "SO-0002" },
      "expect": { "refused": "Short by" } }
  ] }
```

## 9. Deferred — with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Down payments / deposits** | Real SMB need (50% upfront is common), but it drags in liability semantics — money held against undelivered goods — and collides with INV-4. Even Odoo's model (deposit as a pseudo-product, reconciled by credit note) is notoriously messy. Needs its own design pass; a workaround exists today (record_payment → unapplied cash, applied at invoicing). |
| **Early-payment discounts** (2/10 net 30) | Doubles cash-application complexity (settlement below face value is *correct*, not short-pay). Add only with real demand. |
| **Multi-currency** | Column exists; the hard part is revaluation and realized FX on application. Whole-area concern, own spec revision. |
| **Price lists / customer pricing** | Today: freedom (implementations may resolve prices however they like; INV-2 keeps discounts visible). First-class price objects only when rules need sharing across surfaces. |
| **Recurring billing** | Different vertical (subscription), different lifecycle. |
| **Consignment, drop-ship** | Stock-ownership semantics beyond one-warehouse calibration. |
| **Promise-to-pay / collections notes** | Valuable, but it is CRM-on-AR; the dunning worklist (§6) is the hook it will hang from. |
| **Per-line delivery trace on the document** | Invoice lines carry `order_line_id`; the delivery linkage that PROVES "we bill what shipped" exists in the data flow but is not yet printed on the document. Needs invoice_line → delivery_line, a schema change with backfill questions. |
| **Item cost / COGS entries** | The journal is revenue-side by design until items carry cost. Costing method choice (FIFO vs average) is a real design decision, not a column. |

---

## 10. 0.2 additions — documents and the journal

Three gaps between "the books are correct" and "a business can run its month on them".

**Company profile (environment obligation, §3 family).** An invoice document needs a seller.
`set_company_profile` records the business's own identity — name, address, tax id, payment
instructions, a footer note — as a logged environment act with patch semantics. One profile
per workspace; it is master data, not configuration.

**The invoice is the document (read model, extends §6 `invoice`).** The `invoice` read model
now carries everything a printable document needs: the seller block, the bill-to identity,
lines with both prices and tax, application state, and the seller's payment instructions.
There is no separate "render" act — reading the invoice IS obtaining the document, on every
surface. The seller block is FROZEN onto the invoice at issuance (INV-19's spirit): changing
the company profile never reprints history — the document forever shows the identity and bank
details in force when it was issued (`seller_as_issued: true`). Only invoices issued before a
profile existed fall back to the live profile, and say so.

- **Logo (0.2.1).** The company profile may carry a logo, printed at the head of every
document. It is branding, not a fact: it is **not** part of the frozen seller block, so
re-branding re-brands past documents while their names, addresses and amounts stay exactly as
issued. Stored as the image itself (PNG/JPEG/SVG/WebP, 300 KB cap), never hotlinked; set from a
file or fetched once from a public https URL.

- **INV-22 — The books produce documents; they never send them.** Rendering an invoice, a
  statement, or an export is a read. Transmitting it to a customer is the operator's act, done
  outside the system, on purpose. No implementation may email, post, or push a document at a
  third party.

**The journal (read model).** `journal` derives double-entry lines from the books over a date
range — nothing is posted, nothing is stored; it is a projection for handing to the ledger
system of record (QuickBooks/Xero import, or an accountant's CSV). Fixed account names:
Accounts Receivable, Sales Revenue, Service Revenue, Sales Tax Payable, Cash, Customer
Deposits, Customer Credits, Sales Returns & Allowances, Bad Debt Expense.

| Event | Entry |
|---|---|
| invoice issued | DR Accounts Receivable · CR Sales Revenue (goods net) · CR Service Revenue (services net, by the item's stocked flag) · CR Sales Tax Payable (tax) |
| payment received | DR Cash · CR Customer Deposits |
| payment applied | DR Customer Deposits · CR Accounts Receivable |
| credit note issued (return/correction/goodwill) | DR Sales Returns & Allowances · CR Customer Credits |
| credit note issued (write_off) | DR Bad Debt Expense · CR Accounts Receivable |
| credit applied | DR Customer Credits · CR Accounts Receivable |
| refund recorded | DR Customer Deposits or Customer Credits (by source) · CR Cash |

- **INV-23 — Every journal entry balances.** Debits equal credits on every entry and in total,
  by construction from the event tables — never entered, never adjustable. A voided invoice
  contributes nothing (the journal is a derivation of the current books, not a posting log);
  an implementation that exports incrementally must state that re-derivation is the truth.

Known limit, stated plainly: this is a projection, not a general ledger, and it is the
REVENUE SIDE of the books only. Items carry no cost, so there are no COGS or inventory
entries — margin and the inventory account belong to the ledger of record. No chart of
accounts, no manual journals, no close. The ledger of record stays wherever it is; Saybooks
is the operating layer in front of it.

---

*Change log: 0.1-draft (2026-08-22) — initial curation, extracted from the reference
implementation and calibrated against SMB practice (QuickBooks-class gaps, Odoo invoicing
policies, standard AR/dunning/write-off practice). 0.2 (2026-08-23) — company profile environment act, invoice-as-document read model, derived journal read model; INV-22, INV-23. 0.2.1 (2026-09-04) — company logo: branding, not frozen.*
