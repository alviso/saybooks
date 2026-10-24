'use strict';
const { defineCommand, f } = require('../../../registry.js');
const V = require('../views.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Purchasing read', ...def });

read({ name: 'p2p_pos', title: 'Purchase orders', summary: 'Orders by state, with what is still to arrive on each.',
  args: { state: f.pick(['draft', 'issued', 'partly received', 'received', 'closed_short', 'cancelled'], 'Only this state.') }, handler: (a) => V.pos(a) });
read({ name: 'p2p_po', title: 'Purchase order', summary: 'One order: each line with what was ordered, received and billed; its receipts and bills, and whether each bill matches.',
  args: { po_id: { ...f.ref('p2p_po', 'e.g. PO-0001.'), required: true } }, handler: (a) => V.poView(a.po_id) });
read({ name: 'p2p_goods_received', title: 'Goods received', summary: 'What arrived, against which order, when, at the order\'s prices. Newest first.',
  args: { po_id: f.ref('p2p_po', 'Only this order.') }, handler: (a) => V.goodsReceived(a) });
read({ name: 'p2p_unbilled_receipts', title: 'Received, not yet billed', summary: 'Goods received and not yet on an approved bill, line by line, with their value: what is owed for and not yet billed (GRNI).',
  args: {}, handler: () => V.unbilled() });
read({ name: 'p2p_bill_match', title: 'Bill match', summary: 'The 3-way match for one bill: each line against what was received (or ordered, for services) and against the order\'s price, with the tolerance that applies.',
  args: { bill_id: { ...f.text('The bill, e.g. B-0001.'), required: true } }, handler: (a) => V.billMatch(a.bill_id) });
