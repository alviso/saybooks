'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'o2c_invoice_shipped',
  permission: 'billing.write',
  title: 'Invoice shipped', group: 'Billing', subject: 'order',
  summary: 'Issue an invoice for everything shipped on this order and not yet billed.',
  doctrine: `We bill what shipped, never what was ordered. That single rule is what keeps AR
reconcilable: every invoice line traces to a delivery line, and an order that shipped in three
parts produces three invoices, not one guess.

The due date comes from the customer's terms. Do not pass a due date; if the terms are wrong,
fix the terms.`,
  effects: ['invoice created', 'order_line.qty_invoiced increased', 'order.status -> closed when fully billed'],
  guards: [
    (o) => (o.uninvoiced_qty || 0) > 0 || (o.status === 'closed' ? 'Fully invoiced.' : 'Nothing has shipped yet that is not already invoiced.'),
  ],
  args: { order_id: { ...f.ref('order', 'The order to bill.'), required: true } },
  handler(a, { db, at }) {
    const o = V.orderView(a.order_id);
    const billable = o.lines.filter(l => l.qty_shipped > l.qty_invoiced);
    if (!billable.length) throw new Rejected('Nothing has shipped yet that is not already invoiced.');

    const c = H.need('customer', o.customer_id, 'customer');
    const issued = at.slice(0, 10);
    const id = H.nextId('INV', 'invoice');
    // INV-14: the rate is snapshotted per line at issuance. Determination is freedom — here,
    // the item's default rate at the moment of billing.
    let subtotal = 0, taxTotal = 0;
    const computed = billable.map(l => {
      const qty = l.qty_shipped - l.qty_invoiced;
      const rate = H.need('item', l.item_id, 'item').tax_rate_bp || 0;
      const net = qty * l.unit_price;
      const tax = Math.round(net * rate / 10000);
      subtotal += net; taxTotal += tax;
      return { l, qty, rate, tax };
    });
    // The seller block freezes here (INV-19's spirit): the document must forever show the
    // identity and bank details in force at issuance, whatever the profile says later.
    const seller = db.prepare('SELECT name,address,tax_id,payment_instructions,footer_note,updated_at FROM company_profile WHERE id = 1').get() || null;
    db.prepare('INSERT INTO invoice (id,customer_id,order_id,status,total,subtotal,tax_total,issued_at,due_at,seller_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, o.customer_id, o.id, 'open', subtotal + taxTotal, subtotal, taxTotal, issued, H.addDays(issued, H.TERMS[c.terms] ?? 30), seller ? JSON.stringify(seller) : null);

    for (const { l, qty, rate, tax } of computed) {
      db.prepare('INSERT INTO invoice_line (invoice_id,order_line_id,item_id,qty,unit_price,list_price,tax_rate_bp,tax_amount) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, l.id, l.item_id, qty, l.unit_price, l.list_price ?? l.unit_price, rate, tax);
      db.prepare('UPDATE order_line SET qty_invoiced = qty_invoiced + ? WHERE id = ?').run(qty, l.id);
    }

    const after = V.orderView(a.order_id);
    if (after.lines.every(l => l.qty_invoiced === l.qty)) db.prepare("UPDATE \"order\" SET status = 'closed' WHERE id = ?").run(a.order_id);
    return { ...V.invoiceView(id), order_status: H.get('order', a.order_id).status };
  },
});

defineCommand({
  name: 'o2c_void_invoice',
  permission: 'billing.write',
  title: 'Void invoice', group: 'Billing', subject: 'invoice',
  summary: 'Void an invoice that should never have been issued.',
  doctrine: `Only an invoice with no cash applied to it can be voided, and voiding puts the
quantities back to uninvoiced so the order can be billed correctly. An invoice the customer has
already paid against is corrected with a credit note, never voided — the money moved, and the
record has to keep saying so.`,
  effects: ['invoice.status -> void', 'order_line.qty_invoiced released'],
  guards: [
    (inv) => inv.status !== 'void' || 'Already void.',
    (inv) => V.invoiceApplied(inv.id) === 0 || `${H.money(V.invoiceApplied(inv.id))} has been applied to this invoice. Raise a credit note instead.`,
  ],
  args: {
    invoice_id: { ...f.ref('invoice', 'The invoice.'), required: true },
    reason:     { ...f.note('Why it is being voided.'), required: true },
  },
  handler(a, { db }) {
    const inv = H.need('invoice', a.invoice_id, 'invoice');
    if (inv.status === 'void') throw new Rejected('Already void.');
    const applied = V.invoiceApplied(inv.id);
    if (applied > 0) throw new Rejected(`${H.money(applied)} has been applied to this invoice. Raise a credit note instead.`);
    for (const l of db.prepare('SELECT * FROM invoice_line WHERE invoice_id = ?').all(inv.id)) {
      db.prepare('UPDATE order_line SET qty_invoiced = qty_invoiced - ? WHERE id = ?').run(l.qty, l.order_line_id);
    }
    db.prepare("UPDATE invoice SET status = 'void' WHERE id = ?").run(inv.id);
    db.prepare("UPDATE \"order\" SET status = 'confirmed' WHERE id = ? AND status = 'closed'").run(inv.order_id);
    return V.invoiceView(inv.id);
  },
});
