'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const LINE = {
  item_id:    { ...f.ref('item', 'What is being sold.'), required: true },
  qty:        { ...f.int('Quantity.'), required: true },
  unit_price: f.money('Override the list price. Omit to use the item list price.'),
};

defineCommand({
  name: 'o2c_create_quote',
  title: 'New quote', group: 'Quote', subject: 'quote', scope: 'collection',
  summary: 'Draft a quote for a customer.',
  doctrine: `A quote commits nothing: no stock is reserved, no credit is consumed. Omit unit_price
to take the list price — that is the honest default. A discount is an explicit unit_price and
shows up as a discount in the log, which is the point.`,
  effects: ['quote created in draft'],
  args: {
    customer_id: { ...f.ref('customer', 'Who we are quoting.'), required: true },
    lines:       { ...f.lines(LINE, 'The quoted lines.'), required: true },
    valid_until: f.date('Expiry.'),
  },
  handler(a, { db, at }) {
    H.need('customer', a.customer_id, 'customer');
    if (!a.lines.length) throw new Rejected('A quote needs at least one line.');
    const id = H.nextId('Q', 'quote');
    db.prepare('INSERT INTO quote (id,customer_id,status,valid_until,created_at) VALUES (?,?,?,?,?)')
      .run(id, a.customer_id, 'draft', a.valid_until || null, at);
    for (const l of a.lines) {
      const item = H.need('item', l.item_id, 'item');
      if (l.qty <= 0) throw new Rejected(`Line ${l.item_id}: qty must be positive.`);
      db.prepare('INSERT INTO quote_line (quote_id,item_id,qty,unit_price,list_price) VALUES (?,?,?,?,?)')
        .run(id, l.item_id, l.qty, l.unit_price ?? item.unit_price, item.unit_price);
    }
    return V.quoteView(id);
  },
});

defineCommand({
  name: 'o2c_send_quote',
  title: 'Send quote', group: 'Quote', subject: 'quote',
  summary: 'Mark a quote as sent to the customer.',
  doctrine: 'This records that it went out. It does not send anything — this system has no outbound channel, by design.',
  effects: ['quote.status -> sent'],
  guards: [ (q) => q.status === 'draft' || `A ${q.status} quote cannot be sent again.` ],
  args: { quote_id: { ...f.ref('quote', 'The quote.'), required: true } },
  handler(a, { db }) {
    const q = H.need('quote', a.quote_id, 'quote');
    if (q.status !== 'draft') throw new Rejected(`A ${q.status} quote cannot be sent again.`);
    db.prepare("UPDATE quote SET status = 'sent' WHERE id = ?").run(a.quote_id);
    return V.quoteView(a.quote_id);
  },
});

defineCommand({
  name: 'o2c_accept_quote',
  title: 'Customer accepted', group: 'Quote', subject: 'quote',
  summary: 'Record customer acceptance and raise the sales order from the quoted lines.',
  doctrine: `Prices copy across at acceptance and are then frozen on the order. If the list price
moves tomorrow, this order keeps what was quoted — that is the whole reason the quote existed.
The order arrives in draft: acceptance is the customer's act, confirmation is ours.`,
  effects: ['quote.status -> accepted', 'draft order created with the quoted prices'],
  guards: [
    (q) => q.status !== 'expired' || 'This quote has expired. Re-quote rather than reviving it.',
    (q) => !q.order_id || `Already accepted — it produced order ${q.order_id}.`,
  ],
  args: {
    quote_id: { ...f.ref('quote', 'The accepted quote.'), required: true },
    po_ref:   f.text("The customer's own PO number, if they gave one."),
  },
  handler(a, { db, at }) {
    const q = H.need('quote', a.quote_id, 'quote');
    if (q.order_id) throw new Rejected(`Already accepted — it produced order ${q.order_id}.`);
    if (q.status === 'expired') throw new Rejected('This quote has expired. Re-quote rather than reviving it.');
    const lines = db.prepare('SELECT * FROM quote_line WHERE quote_id = ?').all(a.quote_id);
    const id = H.nextId('SO', 'order');
    db.prepare('INSERT INTO "order" (id,customer_id,status,quote_id,po_ref,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, q.customer_id, 'draft', q.id, a.po_ref || null, at);
    for (const l of lines) {
      db.prepare('INSERT INTO order_line (order_id,item_id,qty,unit_price,list_price) VALUES (?,?,?,?,?)')
        .run(id, l.item_id, l.qty, l.unit_price, l.list_price);
    }
    db.prepare("UPDATE quote SET status = 'accepted', order_id = ? WHERE id = ?").run(id, a.quote_id);
    return V.orderView(id);
  },
});

module.exports = { LINE };
