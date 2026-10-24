'use strict';
/**
 * inventory — what the stock is worth. Core keeps every stock move (its single stock door);
 * this area replays them into a moving average cost, costs every shipment at it, records
 * physical counts, and values the stock on any day so it ties to the books. The only cost a
 * person states is the opening cost of stock that came in without one.
 */
const R = require('../../registry.js');
const V = require('./views.js');

const mod = R.defineModule({
  name: 'inventory', prefix: 'inv',
  tables: ['inv_opening_cost'],
  lifecycles: {
    move: 'core\'s stock move: written once by the stock door, never edited',
    opening_cost: 'stated per item with a reason; changing it re-derives everything after it',
    count: 'what was counted on a day; the difference becomes a count move valued at the average',
  },
  rules: [
    'Cost is derived from what was paid (the moving average), never typed; the one stated cost is the opening cost of stock that came in without one.',
    'Each unit leaves at the average of that moment; cost of goods sold is that cost.',
    'Stock without a cost is named with its quantity, never valued at zero in silence.',
    'A count needs a reason; the difference is valued at the average and posted to Inventory Adjustments.',
    'Valuation on a day ties to the Inventory balance the books derive for that day.',
  ],
  doctrine: `Inventory: what the stock is worth. Every change to stock is already a move (receipts on
purchase orders, shipments, returns, counts); this area derives the moving average cost from them.
inv_stock lists every item with on hand, average cost and value. When the person counts a shelf,
record what they counted with inv_count_stock and a reason; the difference posts at the average.
Stock that came in without a cost (on hand before these books) has no cost until a person gives
its opening cost from a record (inv_set_opening_cost); never estimate it, never use the selling
price. inv_cost_of_sales shows what each shipment sold for, what it cost and the margin;
inv_valuation shows the stock's value on a day beside the books' Inventory balance.`,
  implements: {
    area: 'inventory', spec: '0.1',
    argmap: { item: 'item_id' },
    acts: {
      set_opening_cost: 'inv_set_opening_cost', count_stock: 'inv_count_stock',
      stock: 'inv_stock', item_stock: 'inv_item_stock', valuation: 'inv_valuation', cost_of_sales: 'inv_cost_of_sales',
    },
  },
  api: { views: V, journalLines: V.journalLines, derivationAccounts: V.DERIVATION_ACCOUNTS },
});

R.defineSubject('inv_item', { load: (id) => V.itemStock(id) });

R.inModule(mod, () => {
  require('./commands/stock.js');
  require('./commands/reads.js');
});

module.exports = mod;
