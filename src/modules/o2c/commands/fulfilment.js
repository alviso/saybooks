'use strict';
const R = require('../../../registry.js');
const { defineCommand, f, Rejected } = R;
const H = require('../../../db.js');
const V = require('../views.js');
// Stock belongs to core. Depletion goes through its api — the one door where the
// negative-stock rule lives. Looked up at call time to stay load-order agnostic.
const core = () => R.MODULES.find(m => m.name === 'core').api;

defineCommand({
  name: 'o2c_ship_order',
  permission: 'fulfil.write',
  title: 'Ship', group: 'Fulfilment', subject: 'order',
  summary: 'Record a shipment against a confirmed order. Partial shipments are normal.',
  doctrine: `Omit lines to ship everything still open. Pass lines to ship part of it — a short ship
is a fact, not a failure, and the order stays open for the rest.

Stock is checked per line and cannot go negative. If there is not enough, ship what there is and
say so; do not silently reduce the ordered quantity, because the customer is still owed the
difference and the open quantity is how anyone knows that.`,
  effects: ['delivery created', 'order_line.qty_shipped increased', 'item.on_hand decreased via core', 'order.status -> shipped when nothing remains'],
  guards: [
    (o) => o.status === 'confirmed' || (o.status === 'shipped' ? 'Fully shipped.' : `A ${o.status} order cannot ship; confirm it first.`),
    (o) => (o.open_qty || 0) > 0 || 'Nothing left to ship.',
  ],
  args: {
    order_id: { ...f.ref('order', 'The order being shipped.'), required: true },
    lines:    f.lines({
      order_line_id: { ...f.int('The order line id, from the order view.'), required: true },
      qty:           { ...f.int('Quantity shipping now. Never more than the open quantity.'), required: true },
    }, 'Leave empty to ship everything still open.'),
    carrier:  f.text('Carrier.'),
    tracking: f.text('Tracking number.'),
  },
  handler(a, { db, at }) {
    const o = V.orderView(a.order_id);
    if (o.status !== 'confirmed') throw new Rejected(`A ${o.status} order cannot ship; confirm it first.`);

    const requested = (a.lines && a.lines.length)
      ? a.lines
      : o.lines.filter(l => l.qty - l.qty_shipped > 0).map(l => ({ order_line_id: l.id, qty: l.qty - l.qty_shipped }));
    if (!requested.length) throw new Rejected('Nothing left to ship.');

    const id = H.nextId('D', 'delivery');
    db.prepare('INSERT INTO delivery (id,order_id,carrier,tracking,shipped_at) VALUES (?,?,?,?,?)')
      .run(id, a.order_id, a.carrier || null, a.tracking || null, at);

    for (const r of requested) {
      const line = o.lines.find(l => l.id === r.order_line_id);
      if (!line) throw new Rejected(`Order line ${r.order_line_id} is not on order ${a.order_id}.`);
      const open = line.qty - line.qty_shipped;
      if (r.qty <= 0) throw new Rejected(`Line ${line.id}: shipped quantity must be positive.`);
      if (r.qty > open) throw new Rejected(`Line ${line.id} (${line.item_name}): only ${open} of ${line.qty} is still open; you asked to ship ${r.qty}.`);
      const item = H.need('item', line.item_id, 'item');
      if (item.stocked && item.on_hand < r.qty) throw new Rejected(`${item.id} (${item.name}): ${item.on_hand} on hand, ${r.qty} needed. Ship ${item.on_hand} now and leave the rest open, or receive stock first.`);
      db.prepare('INSERT INTO delivery_line (delivery_id,order_line_id,qty) VALUES (?,?,?)').run(id, line.id, r.qty);
      db.prepare('UPDATE order_line SET qty_shipped = qty_shipped + ? WHERE id = ?').run(r.qty, line.id);
      core().adjustStock(db, line.item_id, -r.qty, `shipment ${id}`);
    }

    const after = V.orderView(a.order_id);
    if (after.open_qty === 0) db.prepare("UPDATE \"order\" SET status = 'shipped' WHERE id = ?").run(a.order_id);
    return { ...V.orderView(a.order_id), delivery_id: id };
  },
});
