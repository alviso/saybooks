'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const { LINE } = require('./quote.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'o2c_create_order',
  title: 'New order', group: 'Order', subject: 'order', scope: 'collection',
  summary: 'Raise a sales order directly, without a quote.',
  doctrine: 'Use this for repeat business and phone orders. Anything the customer negotiated should go through a quote instead, so the agreed price has a document behind it.',
  effects: ['order created in draft'],
  args: {
    customer_id: { ...f.ref('customer', 'Who is buying.'), required: true },
    lines:       { ...f.lines(LINE, 'The ordered lines.'), required: true },
    po_ref:      f.text("The customer's own PO number."),
  },
  handler(a, { db, at }) {
    H.need('customer', a.customer_id, 'customer');
    if (!a.lines.length) throw new Rejected('An order needs at least one line.');
    const id = H.nextId('SO', 'order');
    db.prepare('INSERT INTO "order" (id,customer_id,status,po_ref,created_at) VALUES (?,?,?,?,?)')
      .run(id, a.customer_id, 'draft', a.po_ref || null, at);
    for (const l of a.lines) {
      const item = H.need('item', l.item_id, 'item');
      if (l.qty <= 0) throw new Rejected(`Line ${l.item_id}: qty must be positive.`);
      db.prepare('INSERT INTO order_line (order_id,item_id,qty,unit_price,list_price) VALUES (?,?,?,?,?)')
        .run(id, l.item_id, l.qty, l.unit_price ?? item.unit_price, item.unit_price);
    }
    return V.orderView(id);
  },
});

defineCommand({
  name: 'o2c_confirm_order',
  title: 'Confirm order', group: 'Order', subject: 'order',
  summary: 'Accept the order into the books. Runs the credit check.',
  doctrine: `This is the credit gate, and it is the only one. Exposure counts open AR *plus* the
uninvoiced value of everything already confirmed — a limit that only looks at issued invoices
lets a slow biller be robbed politely.

If the check fails, that is the answer. Do not confirm around it by splitting the order, raising
the limit, or invoicing early. Report the shortfall and let a human decide; a refusal recorded in
the log is worth more than an order.`,
  effects: ['order.status -> confirmed', 'value counts against the credit limit'],
  guards: [
    (o) => o.status === 'draft' || `Only a draft order can be confirmed; this one is ${o.status}.`,
    (o) => (o.lines && o.lines.length > 0) || 'The order has no lines.',
    (o, ctx) => !(ctx && ctx.customer && ctx.customer.on_hold) || `${ctx.customer.name} is on credit hold.`,
  ],
  args: { order_id: { ...f.ref('order', 'The order to confirm.'), required: true } },
  handler(a, { db }) {
    const o = V.orderView(a.order_id);
    if (o.status !== 'draft') throw new Rejected(`Only a draft order can be confirmed; this one is ${o.status}.`);
    if (!o.lines.length) throw new Rejected('The order has no lines.');
    const c = V.customerView(o.customer_id);
    if (c.on_hold) throw new Rejected(`${c.name} is on credit hold.`);
    if (c.credit_available < o.total) {
      throw new Rejected(
        `Credit check failed for ${c.name}. Order ${H.money(o.total)}; available ${c.credit_available_display} ` +
        `(limit ${c.credit_limit_display} less open AR ${c.open_balance_display} and committed ${c.committed_display}). ` +
        `Short by ${H.money(o.total - c.credit_available)}.`);
    }
    db.prepare("UPDATE \"order\" SET status = 'confirmed' WHERE id = ?").run(a.order_id);
    return V.orderView(a.order_id);
  },
});

defineCommand({
  name: 'o2c_cancel_order',
  title: 'Cancel order', group: 'Order', subject: 'order',
  summary: 'Cancel an order that has not shipped.',
  doctrine: 'Once anything has shipped the order cannot be cancelled — bill it and issue a credit instead. Cancellation is not a way to make a mistake disappear; the order stays visible as cancelled.',
  effects: ['order.status -> cancelled', 'committed value released'],
  guards: [
    (o) => o.status !== 'cancelled' || 'Already cancelled.',
    (o) => (o.lines || []).every(l => l.qty_shipped === 0) || 'Part of this order has already shipped. Invoice it and raise a credit note instead.',
  ],
  args: {
    order_id: { ...f.ref('order', 'The order.'), required: true },
    reason:   { ...f.note('Why it was cancelled. Kept as pattern memory.'), required: true },
  },
  handler(a, { db }) {
    const o = V.orderView(a.order_id);
    if (o.status === 'cancelled') throw new Rejected('Already cancelled.');
    if (o.lines.some(l => l.qty_shipped > 0)) throw new Rejected('Part of this order has already shipped. Invoice it and raise a credit note instead.');
    db.prepare("UPDATE \"order\" SET status = 'cancelled' WHERE id = ?").run(a.order_id);
    return V.orderView(a.order_id);
  },
});

defineCommand({
  name: 'o2c_amend_order',
  title: 'Amend order', group: 'Order', subject: 'order',
  summary: 'Replace the lines of a DRAFT order.',
  doctrine: `Amendment exists only while the order is draft. After confirmation "what was
confirmed" is a fixed fact the credit gate evaluated: the only permitted shrink is
o2c_close_short, and growth is a new order. The passed lines replace all existing lines.`,
  effects: ['order lines replaced'],
  guards: [ (o) => o.status === 'draft' || `Only a draft order can be amended; this one is ${o.status}. Shrink with close-short or raise a new order.` ],
  args: {
    order_id: { ...f.ref('order', 'The draft order.'), required: true },
    lines:    { ...f.lines(LINE, 'The new full set of lines.'), required: true },
  },
  handler(a, { db }) {
    const o = V.orderView(a.order_id);
    if (o.status !== 'draft') throw new Rejected(`Only a draft order can be amended; this one is ${o.status}. Shrink with close-short or raise a new order.`);
    if (!a.lines.length) throw new Rejected('An order needs at least one line — cancel it instead of emptying it.');
    db.prepare('DELETE FROM order_line WHERE order_id = ?').run(a.order_id);
    for (const l of a.lines) {
      const item = H.need('item', l.item_id, 'item');
      if (l.qty <= 0) throw new Rejected(`Line ${l.item_id}: qty must be positive.`);
      db.prepare('INSERT INTO order_line (order_id,item_id,qty,unit_price,list_price) VALUES (?,?,?,?,?)')
        .run(a.order_id, l.item_id, l.qty, l.unit_price ?? item.unit_price, item.unit_price);
    }
    return V.orderView(a.order_id);
  },
});

defineCommand({
  name: 'o2c_close_short',
  title: 'Close short', group: 'Order', subject: 'order',
  summary: 'Cancel the open remainder of a partially fulfilled order.',
  doctrine: `This is how backorders die honestly: the customer is no longer owed the difference,
committed credit exposure is released, and the reason is kept. Pass line ids to close only some
lines; omit to close every open remainder. The fulfilled part stays exactly as it is.`,
  effects: ['open quantities reduced to shipped', 'committed exposure released', 'order may derive closed'],
  guards: [
    (o) => ['confirmed'].includes(o.status) || `A ${o.status} order has no open remainder to close.`,
    (o) => (o.open_qty || 0) > 0 || 'Nothing is open on this order.',
  ],
  args: {
    order_id: { ...f.ref('order', 'The order.'), required: true },
    lines:    f.lines({ order_line_id: { ...f.int('The order line id.'), required: true } }, 'Only these lines. Omit to close all open remainders.'),
    reason:   { ...f.note('Why the remainder is being abandoned.'), required: true },
  },
  handler(a, { db }) {
    const o = V.orderView(a.order_id);
    if (o.status !== 'confirmed') throw new Rejected(`A ${o.status} order has no open remainder to close.`);
    if ((o.open_qty || 0) === 0) throw new Rejected('Nothing is open on this order.');
    const targets = a.lines && a.lines.length
      ? a.lines.map(l => { const line = o.lines.find(x => x.id === l.order_line_id);
          if (!line) throw new Rejected(`Order line ${l.order_line_id} is not on order ${a.order_id}.`); return line; })
      : o.lines.filter(l => l.qty - l.qty_shipped > 0);
    for (const line of targets) {
      db.prepare('UPDATE order_line SET qty = qty_shipped WHERE id = ?').run(line.id);
    }
    const after = V.orderView(a.order_id);
    if (after.open_qty === 0 && after.lines.length && after.lines.every(l => l.qty_invoiced === l.qty)) {
      db.prepare("UPDATE \"order\" SET status = 'closed' WHERE id = ?").run(a.order_id);
    } else if (after.open_qty === 0) {
      db.prepare("UPDATE \"order\" SET status = 'shipped' WHERE id = ?").run(a.order_id);
    }
    return V.orderView(a.order_id);
  },
});
