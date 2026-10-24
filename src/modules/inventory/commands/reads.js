'use strict';
const { defineCommand, f } = require('../../../registry.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Inventory read', ...def });

read({ name: 'inv_stock', title: 'Stock', summary: 'Every stocked item: on hand, average cost and value, and any stock without a cost.', args: {}, handler: () => V.stock() });
read({ name: 'inv_item_stock', title: 'Item stock', summary: 'One item\'s stock moves, newest first, with the quantity, average cost and value after each.',
  args: { item_id: { ...f.ref('item', 'The item.'), required: true } }, handler: (a) => V.itemStock(a.item_id) });
read({ name: 'inv_moves', title: 'Stock moves', summary: 'Every change to stock, newest first: received, shipped, returned, counted, adjusted, opening.',
  args: { item_id: f.ref('item', 'Only this item.'), limit: f.int('How many. Defaults to 200.') }, handler: (a) => V.allMoves(a) });
read({ name: 'inv_valuation', title: 'Stock valuation', summary: 'What the stock was worth on a day, per item and in total, beside the Inventory balance the books derive for that day.',
  args: { as_of: f.date('The day. Defaults to today.') }, handler: (a) => V.valuation(a) });
read({ name: 'inv_cost_of_sales', title: 'Cost of sales', summary: 'Each shipment line in a period: what it sold for, what it cost at the moving average, and the margin.',
  args: { from: f.date('From this day.'), to: f.date('Up to and including this day.') }, handler: (a) => V.costOfSales(a) });
