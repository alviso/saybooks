# p2p — Procure to Pay · Area Specification

**Status: 0.2.** The first implemented slice of the 0.1 draft (24 August): purchase orders,
goods received against them, vendor bills recorded against an order, and the 3-way match a
bill must pass before a person can approve paying it. Debit notes, returns, amendments and
item costing wait for later versions (§9). Open questions from 0.1 are answered in §10.

o2c's mirror image: o2c is money coming in for things we sell; p2p is money going out for
things we buy. Same doctrine: one definition per act, agent and UI on the same guards, one
audit trail, refusals that name their numbers.

## 1. Calibration: who this is for

Same band as o2c: a small business with one legal entity, one currency and one stockroom,
that BUYS stocked goods on terms (distributors, wholesalers, shops, light manufacturers), plus
the services bought alongside them (freight, installation). Between a spreadsheet and SAP MM:
no requisition chains, no RFQs, no consignment; a real match gate and real receipt discipline.

## 2. Scope

In (0.2): purchase orders, issuing them, goods received against them, closing an order short,
cancelling one, vendor bills recorded against an order, the 3-way match at approval, the match
tolerance, goods received not invoiced (GRNI) as a list and in the journal.

Out (§9): paying anything (ever), debit notes and returns to vendor, amending an issued order,
item costing and stock valuation (the inventory process), landed cost, multi-currency,
requisitions and approval chains, drop-ship, consignment.

## 3. Entities and lifecycles

- **vendor**: the purchases area's vendor, by name. One vendor list for bills with and
  without an order.
- **purchase_order**: draft → issued → received (every stocked line in full) | closed_short
  (stop waiting, with a reason) | cancelled (nothing received yet, with a reason). Partly
  received is a fact derived from the receipts, never a stored state. Prices freeze at issue:
  a draft can be cancelled and raised again; an issued order cannot be edited.
- **goods receipt**: an immutable fact: what arrived against which order, when, under which
  packing slip. Stock enters through it, by core's single stock door. Its unit cost is the
  order's frozen price.
- **vendor bill on an order**: the purchases area's bill (B-0001), recorded with its lines
  against the order's lines: item, quantity, unit price, as printed. The bill's total is the
  sum of its lines. Recording is not gated: the bill exists whether we like it or not.
  Approval is where the match gate lives, and approval stays a person's act (purchases P-12).
- **match tolerance**: how far a bill may stray before approval is refused: a price
  percentage and a quantity percentage, both 0 by default. Set by a person, with a reason.

## 4. The acts

Writes: create_po, issue_po, cancel_po, close_po_short, receive_goods, record_vendor_bill,
set_match_tolerance (a person's act).

Reads: pos, po, goods_received, unbilled_receipts (the GRNI list), bill_match (the match
report for one bill, the artifact you hand an auditor).

Approval and payment are the purchases area's acts (approve_bill, record_bill_payment,
reject_bill); a bill on an order passes this area's match before a person can approve it.

## 5. Invariants

- **P2P-1** Money is integer cents, everywhere; one currency per order.
- **P2P-2** Nothing is paid without an approved bill, and a bill on an order is approved only
  when it passes the match on the record at that moment.
- **P2P-3** The match names its numbers: billed quantity against received quantity (stocked
  lines) or ordered quantity (service lines), billed price against the order's price, each
  with the tolerance that applied. A breach is a one-sentence refusal, never a warning.
- **P2P-4** Stock enters only through a goods receipt, by core's stock door; receipts are
  immutable facts.
- **P2P-6** Loosening the match is a person's act: an agent can never change the tolerance,
  whatever its role.
- **P2P-8** Order prices freeze at issue; a bill's price differences are shown against them
  and posted to their own account, never averaged away.
- **P2P-9** The system records payments; it never executes them.
- **P2P-10** The same vendor's same bill number is one bill (purchases P-12's guard).
- **P2P-11** Receiving more than is still open on a line is a refusal naming the quantities,
  bounded by the quantity tolerance; services are never received.
- **P2P-12** Every write is a logged command with an actor; refusals are logged too.
- **P2P-13** The journal derives balanced: a receipt debits Inventory and credits Goods
  Received Not Invoiced at the order's price; an approved bill debits GRNI at the order's
  price (service lines debit their category), posts any price difference to Purchase Price
  Variance, and credits Accounts Payable; its payment debits Accounts Payable and credits the
  account it was paid from. A bill without an order stays on the cash basis it has today.
- **P2P-14** Goods received and not yet on an approved bill are always listable, line by
  line, with their value.

P2P-5 (item cost from receipts) and P2P-7 (disputes) are carried by the inventory process and
a later version; the numbers stay reserved so references do not move.

## 6. Required read models

pos (by state, with what is still to arrive), po (lines with ordered, received and billed
quantities; its receipts and bills), goods_received, unbilled_receipts with value, and the
bill_match report.

## 7. Contract vs freedom

Contract: the match gate at approval; receipt-only stock entry; tolerance as a person's act;
recording, never paying. Freedom: tolerance values, order numbering, the expected date.

## 8. Conformance (scenarios)

01 the whole path: order, issue, receive, bill, match passes, approval left to a person ·
02 the match refuses a bill priced over the order, then the corrected bill passes ·
03 partial receipt, GRNI, close the rest short · 04 receiving more than is open is refused;
services are not received · 05 a draft is cancelled; an order with receipts is not ·
06 the agent cannot loosen the match. The person's approval, refused and then allowed by the
match, is a contract gate, because scenarios run as an agent.

## 9. Deferred, with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Payment execution, bank files** | The system records; it never moves money. Anything else changes what Saybooks is. |
| **Debit notes, returns to vendor** | Real, and o2c's credit note shows the shape. Their own version. |
| **Amending an issued order** | Cancel a draft and raise it again; after issue, a change is a conversation with the vendor first. |
| **Item cost and stock valuation** | Moving average from receipts and cost of goods sold on shipment: the inventory process. |
| **Disputes** | Rejecting a bill with a reason covers it for now; a dispute state needs a design partner's workflow. |
| **Landed cost** | Real for importers; drags freight allocation design. |
| **Multi-currency** | Same whole-area concern as o2c §9. |
| **Requisitions and approval chains** | One approval act by a person. Chains are enterprise theater until someone proves otherwise. |
| **Drop-ship, consignment** | Stock ownership beyond one stockroom. |

## 10. Answers to 0.1's open questions

- **Approval permission**: approval stays the purchases area's person-only act under its
  existing permission. The match is the new condition, not a new tag.
- **GRNI for the smallest books**: always. It is derived, and hiding it is how month-end
  surprises happen.
- **Service lines**: 2-way match (billed against ordered); there is nothing to receive.
- **Vendors in core**: not yet. The purchases area already keeps the vendor list bills use;
  one list beats two.

---

*Change log: 0.2 (2026-10-24) — first implemented slice: orders, receipts, bills on orders,
the 3-way match, GRNI; open questions answered. 0.1-draft (2026-08-24) — skeleton curated
before implementation, written for design partners to mark up.*
