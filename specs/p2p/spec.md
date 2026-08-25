# p2p — Procure to Pay · Area Specification

**Status: 0.1-draft SKELETON — curated before implementation, on purpose.**
This is the artifact to argue with: every section below is a claim about how SMB purchasing
should work under governed agents, written down so a design partner can tell us where it is
wrong before a line of the module exists. Open questions are marked ⚑.

o2c's mirror image: o2c is money coming in for things we sell; p2p is money going out for
things we buy. Same doctrine — one definition per act, agent and UI on the same guards, one
audit trail, refusals that name their numbers.

## 1. Calibration: who this is for

Same band as o2c: 5–200 people, one legal entity, one currency, one warehouse. Businesses
that BUY stocked goods on terms — distributors, wholesalers, light manufacturers — plus the
service bills every business has. Between a toy and SAP MM: no requisition chains, no RFQ
tournaments, no consignment; a real match gate, real receipt discipline, real AP.

## 2. Scope

In: vendors, purchase orders, goods receipts, vendor bills, the 3-way match, AP aging,
payment RECORDING, debit notes, duplicate-bill guard, GRNI visibility, item cost from
receipts.

Out (see §9): payment EXECUTION (no rails, ever — INV-22 family), landed cost,
multi-currency, FIFO/specific-identification costing, requisitions and approval chains,
drop-ship, consignment, recurring bills.

## 3. Entities and lifecycles

- **vendor** — core-owned master data, like customer. Terms, default currency. Bank/remit
  details are **human-only fields**: an agent can record any bill, an agent can never change
  where money goes. This is the invoice-fraud invariant and it is not negotiable.
- **purchase_order** — draft → issued → (partially received) → received | cancelled |
  closed_short. Prices freeze at issue (INV-19 family). Amend before issue is free; after
  issue, amendment is its own logged act.
- **receipt** — an immutable fact: what physically arrived, when, at what unit cost. Stock
  enters ONLY through a receipt (core's single stock door). Cost enters here and only here;
  item cost is derived (moving average), never typed.
- **vendor_bill** — recorded → matched | disputed → approved → paid | void. Recording is
  cheap and unguarded (the bill exists whether we like it or not); APPROVAL is where the
  3-way match gate lives. A disputed bill blocks payment, not recording.
- **bill_payment** — recorded against approved bills; unapplied balances are real, like
  unapplied cash in o2c. Recording is not execution; nothing here moves money.
- **debit_note** — the vendor owes us (returns to vendor, overbilling). Mirrors o2c's
  credit note: applied to bills or refunded; closure derived, never declared.

## 4. The acts (draft list — names are the contract, counts are not)

Writes (~15): create_po, issue_po, amend_po, cancel_po, close_po_short, receive_goods,
record_vendor_bill, dispute_bill, approve_bill, void_bill, record_bill_payment,
apply_bill_payment, record_debit_note, apply_debit_note, return_to_vendor.

Reads (~6): po, vendor_position, bill (the match report rides on it), ap_aging,
unbilled_receipts (the GRNI list), payment_worklist (approved bills by due date).

Environment acts (core): create_vendor, update_vendor (banking fields human-only),
set_match_tolerance.

⚑ Open: does approve_bill need its own permission tag (`ap.approve`) or does o2c's
credit.authority pattern generalize to a shared "money authority" tag?

## 5. Invariants (P2P-n, namespaced like CRM-n/JH-n)

- **P2P-1** Money is integer cents, everywhere.
- **P2P-2** Nothing is paid without an approved bill; nothing is approved without a match
  evaluation on the record.
- **P2P-3** The 3-way match names its numbers: billed qty vs received qty, billed price vs
  PO price, each with the tolerance that applied. Tolerance is workspace config; a breach is
  a one-sentence refusal, not a warning.
- **P2P-4** Stock enters only through a receipt; receipts are immutable facts.
- **P2P-5** Item cost is derived from receipts (moving average), never entered directly.
- **P2P-6** Vendor bank details are human-only: entered by a person, never an agent,
  whatever the role. Changes are logged acts with a mandatory reason.
- **P2P-7** A disputed bill cannot be paid; disputing and resolving are logged acts with
  reasons.
- **P2P-8** PO prices freeze at issue; bill variances are shown against them, never
  averaged away.
- **P2P-9** The system records payments; it never executes them. No rails, no files for
  the bank, no outbound anything.
- **P2P-10** Duplicate-bill guard: same vendor + same bill number (or same amount within a
  window) is a surfaced warning, never auto-resolved (JH-3 spirit).
- **P2P-11** Over-receipt and over-billing against a PO are refusals naming the quantities,
  bounded by tolerance config.
- **P2P-12** Every write is a logged command with an actor; refusals are logged; reads are
  not (INV-21 family).
- **P2P-13** Journal derivation balances by construction (INV-23 family):
  receipt → DR Inventory / CR Goods Received Not Invoiced;
  bill approved → DR GRNI (+ price variance to its own account) / CR Accounts Payable;
  payment → DR Accounts Payable / CR Cash;
  debit note → mirrors o2c's credit note.
  Once receipts carry cost, o2c shipment gains DR COGS / CR Inventory — the missing cost
  side of the journal arrives HERE, not from a GL.
- **P2P-14** GRNI is visible, always: goods received and not yet billed is a real liability
  a person can list, not a residue between systems.

⚑ Open: is GRNI accrual right for the smallest books, or should sub-N-employee mode
expense-on-receipt? (Lean: GRNI always — it is derivable, and hiding it is how month-end
surprises happen. A design partner may prove us wrong.)

## 6. Required read models

vendor_position (open POs, unbilled receipts, open AP, next payments due), ap_aging
(mirror of AR aging), unbilled_receipts, payment_worklist, and the bill read carrying its
full match evidence — the artifact you hand an auditor.

## 7. Contract vs freedom

Contract: the match gate at approval; receipt-only stock entry; human-only banking; derived
cost; payment recording only. Freedom: tolerance values, PO numbering, whether service bills
2-way match (no receipt) — ⚑ likely contract as "2-way for unstocked lines," to be argued.

## 8. Conformance (planned scenarios)

01 happy path PO→receipt→bill→approve→pay · 02 the match gate refuses (price high, qty over,
then tolerance raised with reason — the credit-gate story, mirrored) · 03 partial receipts
and GRNI · 04 dispute → resolve → pay · 05 duplicate bill guard · 06 debit note and
return-to-vendor · 07 the agent tries to change vendor banking (refused, logged) ·
08 costing: two receipts at different costs → moving average → COGS on next o2c shipment.

## 9. Deferred — with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Payment execution / bank files** | The system records; it never moves money. Anything else changes what Saybooks is. |
| **Landed cost** | Real for importers; drags freight allocation design. Own pass. |
| **Multi-currency** | Same whole-area concern as o2c §9. |
| **FIFO / specific identification** | Moving average first; method choice needs a design partner with a reason. |
| **Requisitions & approval chains** | SMB calibration: one approval act with a permission tag. Chains are enterprise theater until someone proves otherwise. |
| **Drop-ship / consignment** | Stock-ownership semantics beyond one warehouse. |
| **Recurring bills** | Subscription lifecycle, different vertical. |

---

*Change log: 0.1-draft skeleton (2026-08-24) — curated before implementation; written for
design partners to mark up. No module claims this spec yet; the conformance machinery
ignores it until one does.*
