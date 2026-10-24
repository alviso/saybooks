# inventory — Stock and What It Is Worth · Area Specification

**Status: 0.1.** What the stock on hand is worth and what each sale cost: every stock move
kept, the moving average cost derived from what was paid, cost of goods sold on each shipment,
physical counts with reasons, and a valuation that ties to the books. It completes the cost
side that the p2p area's receipts start (P2P-5, P2P-13).

## 1. Calibration: who this is for

The same small business as o2c and p2p: one stockroom, one currency, a few hundred items at
most, stock bought on purchase orders and sold on orders. The owner wants to know what the
shelves are worth, what a sale actually earned, and where the missing units went. Their
accountant wants the inventory balance and cost of goods sold to come from the record, not from
a spreadsheet at year end.

## 2. Scope

In: the stock move record, the moving average cost, the cost of opening stock, physical counts,
cost of goods sold per shipment, valuation as of a date, and their postings.

Out (§9): FIFO and specific identification, landed cost, several stockrooms, lots and serial
numbers, reorder points, and standard costing.

## 3. Entities and lifecycles

- **stock move** (core's): every change to the quantity on hand, as a row: the item, the day,
  the signed quantity, what it was (opening, receipt, shipment, return, count, adjustment), its
  reference (GR-0001, D-0003) and, when the move itself knows it, the unit cost. Only core's
  stock door writes moves, so they always add up to what is on hand. A move is never edited.
- **moving average cost**: derived per item by replaying its moves: a costed inflow updates the
  average; an outflow leaves at the average of that moment; a count difference is valued at it.
  Never typed.
- **opening cost**: what one unit of stock that came in without a cost was worth (stock on hand
  before the record, or a correction received by hand). Stated once per item, with a reason;
  the record then derives everything after it.
- **count**: what a person counted on the shelf for one item on a day, with a reason. The
  difference from the record becomes a count move.

## 4. The acts

Writes: set_opening_cost, count_stock.

Reads: stock (every item: on hand, average cost, value), item_stock (one item's moves with
the running quantity, average and value), valuation (as of a date, tied to the books),
cost_of_sales (each shipment line in a period: sold at, cost, margin).

Moves themselves are written by the acts that move stock: p2p's receive_goods, o2c's
ship_order and record_return, core's receive_stock, and count_stock here.

## 5. Invariants

- **STK-1** Money is integer cents; one currency.
- **STK-2** Every change to the quantity on hand is a stock move, written by core's stock door;
  the moves of an item add up to its quantity on hand.
- **STK-3** Cost is derived, never typed: the moving average from costed inflows. The only cost a
  person or agent states is the opening cost of stock that came in without one, with a reason.
- **STK-4** Each unit leaves at the average of that moment; cost of goods sold is that cost, per
  shipment line.
- **STK-5** Stock without a cost is named, with its quantity, never valued at zero in silence.
  Its sales are left out of cost of goods sold and listed as left out.
- **STK-6** A count records what was counted, with a reason; the difference is a move valued at
  the average, posted to Inventory Adjustments.
- **STK-7** Valuation as of a date equals the Inventory balance the journal derives for that
  date.
- **STK-8** The journal derives balanced: a shipment debits Cost of Goods Sold and credits
  Inventory; a return reverses it; a count difference moves between Inventory and Inventory
  Adjustments; costed opening stock debits Inventory and credits Opening Balance Equity. Goods
  received on an order are posted by the p2p area (P2P-13), never twice.
- **STK-9** Every write is a logged command with an actor; refusals are logged too.

## 6. Required read models

stock (with the uncosted quantity per item), item_stock, valuation (per item and in total, with
the journal's Inventory balance beside it), cost_of_sales (per shipment line, with the totals).

## 7. Contract vs freedom

Contract: moves only through core; the moving average; costs derived except the opening cost;
uncosted stock named; valuation ties to the journal. Freedom: how a count is reported, how the
pages sort.

## 8. Conformance (scenarios)

01 the average moves with receipts and shipments leave at it · 02 opening stock without a cost
is named and left out until its cost is stated, then everything derives · 03 a count records
the shrinkage at the average · 04 a return comes back at the average · 05 valuation ties to the
journal's Inventory balance.

## 9. Deferred, with reasons

| Item | Why deferred, not rejected |
|---|---|
| **FIFO, specific identification** | Moving average first; a method choice needs a design partner with a reason (tax or industry). |
| **Landed cost** | Freight allocated across items needs its own design; freight posts as a service line today. |
| **Several stockrooms** | Transfers and per-location stock; one stockroom fits the calibration. |
| **Lots, serial numbers, expiry** | Traceability for regulated goods; a different customer. |
| **Reorder points** | Advice, not record. The record says what is on hand and on order. |
| **Standard costing** | A manufacturer's tool; the calibration buys and resells. |

---

*Change log: 0.1 (2026-10-24) — first version: stock moves, moving average, opening cost,
counts, cost of goods sold, valuation tied to the books.*
