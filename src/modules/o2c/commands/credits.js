'use strict';
const R = require('../../../registry.js');
const { defineCommand, f, Rejected } = R;
const H = require('../../../db.js');
const V = require('../views.js');
const core = () => R.MODULES.find(m => m.name === 'core').api;

/** Shared: raise a credit note row. Total is tax-inclusive; the credit relieves AR gross. */
function raiseCreditNote(db, at, { customer_id, kind, invoice_id = null, return_id = null, total, reason }) {
  if (total <= 0) throw new Rejected('A credit note must be for a positive amount.');
  const id = H.nextId('CN', 'credit_note');
  db.prepare('INSERT INTO credit_note (id,customer_id,kind,invoice_id,return_id,total,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, customer_id, kind, invoice_id, return_id, total, reason, 'open', at);
  return id;
}

defineCommand({
  name: 'o2c_record_return',
  title: 'Record return', group: 'Credits', subject: 'order',
  summary: 'Record goods coming back against an order; restock the sellable part; raise the credit note.',
  doctrine: `Restock only what physically returns sellable (INV-12): lines flagged restock go back
to stock through core; damaged goods are recorded but never re-enter it. You can never return
more than was fulfilled, less what already came back. The credit note is valued at the charged
price plus the tax as invoiced — the customer gets back what they were billed, not the list price.`,
  effects: ['return recorded', 'sellable qty restocked via core', 'credit note (kind return) raised'],
  guards: [ (o) => (o.lines || []).some(l => l.qty_shipped > 0) || 'Nothing on this order has been fulfilled, so nothing can come back.' ],
  args: {
    order_id: { ...f.ref('order', 'The order the goods belong to.'), required: true },
    lines:    { ...f.lines({
      order_line_id: { ...f.int('The order line id.'), required: true },
      qty:           { ...f.int('Units coming back on this row.'), required: true },
      restock:       f.bool('True if sellable — goes back to stock. False for damaged.'),
    }, 'What came back, row per disposition.'), required: true },
    reason:   { ...f.note('Why. Kept on the return and the credit note.'), required: true },
  },
  handler(a, { db, at }) {
    const o = V.orderView(a.order_id);
    if (!o.lines.some(l => l.qty_shipped > 0)) throw new Rejected('Nothing on this order has been fulfilled, so nothing can come back.');
    if (!a.lines.length) throw new Rejected('A return needs at least one line.');

    const id = H.nextId('R', 'return');
    db.prepare('INSERT INTO "return" (id,order_id,reason,recorded_at) VALUES (?,?,?,?)').run(id, a.order_id, a.reason, at);

    let creditTotal = 0, restocked = 0;
    // Validate per order line against fulfilled-less-already-returned, summing rows first
    // so two rows against one line cannot each pass alone and jointly overdraw.
    const byLine = new Map();
    for (const r of a.lines) {
      if (r.qty <= 0) throw new Rejected('Returned qty must be positive.');
      byLine.set(r.order_line_id, (byLine.get(r.order_line_id) || 0) + r.qty);
    }
    for (const [lineId, qty] of byLine) {
      const line = o.lines.find(l => l.id === lineId);
      if (!line) throw new Rejected(`Order line ${lineId} is not on order ${a.order_id}.`);
      const returnable = line.qty_shipped - V.returnedQty(lineId);
      if (qty > returnable) throw new Rejected(`Line ${lineId} (${line.item_name}): ${line.qty_shipped} fulfilled, ${V.returnedQty(lineId)} already returned — only ${returnable} can come back; you recorded ${qty}.`);
    }
    for (const r of a.lines) {
      const line = o.lines.find(l => l.id === r.order_line_id);
      db.prepare('INSERT INTO return_line (return_id,order_line_id,qty,restock) VALUES (?,?,?,?)')
        .run(id, r.order_line_id, r.qty, r.restock ? 1 : 0);
      if (r.restock) { core().adjustStock(db, line.item_id, r.qty, `return ${id}`); restocked += r.qty; }
      // Credit at the price the customer was actually billed: charged price + invoiced tax rate.
      const il = db.prepare('SELECT tax_rate_bp FROM invoice_line WHERE order_line_id = ? ORDER BY id DESC LIMIT 1').get(r.order_line_id);
      const rate = il ? il.tax_rate_bp : (H.get('item', line.item_id).tax_rate_bp || 0);
      const net = r.qty * line.unit_price;
      creditTotal += net + Math.round(net * rate / 10000);
    }

    const cnId = raiseCreditNote(db, at, { customer_id: o.customer_id, kind: 'return', return_id: id, total: creditTotal, reason: a.reason });
    return { return_id: id, order_id: a.order_id, restocked_qty: restocked, credit_note_id: cnId,
      credit_total: creditTotal, credit_total_display: H.money(creditTotal) };
  },
});

defineCommand({
  name: 'o2c_create_credit_note',
  title: 'Credit note', group: 'Credits', subject: 'credit_note', scope: 'collection',
  summary: 'Raise a credit note: the universal downward correction.',
  doctrine: `Pricing errors, short-pay resolution, goodwill — anything past draft is corrected
downward this way and only this way (INV-11). A credit note has its own open balance: apply it
to invoices like a payment, or refund it. Standalone credits (no invoice reference) are allowed
but the reason is mandatory and it will be read back.`,
  effects: ['credit note raised as unapplied credit'],
  args: {
    customer_id: { ...f.ref('customer', 'Whose balance this relieves.'), required: true },
    amount:      { ...f.money('Credit amount, tax-inclusive.'), required: true },
    kind:        { ...f.pick(['correction', 'goodwill'], 'What kind of correction this is. Returns and write-offs have their own commands.'), required: true },
    invoice_id:  f.ref('invoice', 'The invoice being corrected, when there is one.'),
    reason:      { ...f.note('Why. Mandatory — this is money.'), required: true },
  },
  handler(a, { db, at }) {
    H.need('customer', a.customer_id, 'customer');
    if (a.invoice_id) {
      const inv = H.need('invoice', a.invoice_id, 'invoice');
      if (inv.customer_id !== a.customer_id) throw new Rejected(`Invoice ${inv.id} does not belong to ${a.customer_id}.`);
    }
    const id = raiseCreditNote(db, at, { customer_id: a.customer_id, kind: a.kind, invoice_id: a.invoice_id || null, total: a.amount, reason: a.reason });
    return V.creditNoteView(id);
  },
});

defineCommand({
  name: 'o2c_write_off',
  title: 'Write off', group: 'Credits', subject: 'invoice',
  summary: 'Close an uncollectible open invoice balance as a visible, reasoned credit act.',
  doctrine: `A write-off is a credit note of kind write_off, raised for the open balance and
applied to the invoice in the same act — never a deletion, never silent (INV-16). The threshold
for who may write off how much is yours to police; the record that it happened is not.`,
  effects: ['credit note (kind write_off) raised and applied', 'invoice.status -> paid'],
  guards: [
    (inv) => inv.status === 'open' || `Only an open invoice can be written off; this one is ${inv.status}.`,
    (inv) => (inv.total - V.invoiceApplied(inv.id)) > 0 || 'Nothing is open on this invoice.',
  ],
  args: {
    invoice_id: { ...f.ref('invoice', 'The invoice.'), required: true },
    reason:     { ...f.note('Why it will not be collected.'), required: true },
  },
  handler(a, { db, at }) {
    const inv = H.need('invoice', a.invoice_id, 'invoice');
    if (inv.status !== 'open') throw new Rejected(`Only an open invoice can be written off; this one is ${inv.status}.`);
    const open = inv.total - V.invoiceApplied(inv.id);
    if (open <= 0) throw new Rejected('Nothing is open on this invoice.');
    const cnId = raiseCreditNote(db, at, { customer_id: inv.customer_id, kind: 'write_off', invoice_id: inv.id, total: open, reason: a.reason });
    db.prepare('INSERT INTO credit_application (credit_note_id,invoice_id,amount) VALUES (?,?,?)').run(cnId, inv.id, open);
    db.prepare("UPDATE credit_note SET status = 'settled' WHERE id = ?").run(cnId);
    db.prepare("UPDATE invoice SET status = 'paid' WHERE id = ?").run(inv.id);
    return { credit_note_id: cnId, written_off: H.money(open), invoice_status: 'paid', invoice: V.invoiceView(inv.id) };
  },
});
