'use strict';
const crypto = require('crypto');
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const LINE = {
  description: { ...f.text('What the work was, in your words.'), required: true },
  qty: { type: 'number', description: 'Quantity or hours — 7.5 is fine. Defaults to 1.', ui: { widget: 'number', label: 'Qty' } },
  rate: { ...f.money('Rate per unit/hour.'), required: true },
  tax_rate_bp: f.int('Tax rate in basis points (875 = 8.75%). 0 or omitted = untaxed. Determining the rate is your job; capturing it is ours.'),
};

const NO_ADDRESS = (c) => `${c.name} has no billing address — the document needs a bill-to block. Ask for it (one question), call core_update_customer, and come back (S-3).`;
const NO_PROFILE = 'No company details yet — ask for the company name first (one question at a time), then the address as it should print, then how clients pay; then call core_set_company_profile and come back (S-3).';
const profile = (db) => db.prepare('SELECT * FROM company_profile WHERE id = 1').get();

function writeLines(db, invoiceId, lines) {
  db.prepare('DELETE FROM solo_invoice_line WHERE invoice_id = ?').run(invoiceId);
  let subtotal = 0, taxTotal = 0, pos = 0;
  for (const l of lines) {
    const qty = l.qty ?? 1;
    if (!(qty > 0)) throw new Rejected('A line quantity must be positive.');
    if (!Number.isInteger(l.rate) || l.rate <= 0) throw new Rejected('A line rate must be a positive whole number of cents.');
    const amount = Math.round(qty * l.rate);
    const tax = Math.round(amount * (l.tax_rate_bp || 0) / 10000);
    subtotal += amount; taxTotal += tax; pos++;
    db.prepare('INSERT INTO solo_invoice_line (invoice_id,pos,description,qty,rate,amount,tax_rate_bp,tax_amount) VALUES (?,?,?,?,?,?,?,?)')
      .run(invoiceId, pos, l.description, qty, l.rate, amount, l.tax_rate_bp || 0, tax);
  }
  return { subtotal, taxTotal };
}

defineCommand({
  name: 'solo_draft_invoice',
  permission: 'billing.write',
  title: 'Draft invoice', group: 'Invoicing', subject: 'solo_invoice', scope: 'collection',
  summary: 'Start an invoice as an editable draft. Nothing is final until you issue it.',
  doctrine: `Gather the lines as the person describes the work — description, quantity or
hours, rate — and SHOW them the numbers before issuing. Timing is their agreement with the
client: ahead of the work, partial, or after — never question it (S-5). Never invent an
amount or a rate (S-6). If there is no client yet, ask for the client's name, billing address,
email, and the agreed terms — one question at a time — and create the customer first. The draft
comes back with doc_url: a preview link that renders the real document marked DRAFT. Call
solo_get_document to see that render yourself and hand the person the link BEFORE asking whether
to issue; never hand-roll the document yourself.`,
  effects: ['draft created with computed totals', 'preview link minted'],
  args: {
    customer_id: { ...f.ref('customer', 'The client.'), required: true },
    lines: { ...f.lines(LINE, 'The work being billed.'), required: true },
    due_in_days: f.int('Days until due, from your agreement — 30 for net-30. Freezes into the due date at issue. Defaults to 30.'),
    notes: f.note('Printed on the document (project reference, thanks, PO number they gave you).'),
  },
  handler(a, { db, at }) {
    H.need('customer', a.customer_id, 'customer');
    if (!a.lines || !a.lines.length) throw new Rejected('An invoice needs at least one line.');
    const id = H.nextId('INV', 'solo_invoice');
    // The preview link exists from the first draft (S-7): the same token becomes the document at issue.
    db.prepare(`INSERT INTO solo_invoice (id,customer_id,status,due_in_days,notes,doc_token,created_at,updated_at)
                VALUES (?,?,'draft',?,?,?,?,?)`).run(id, a.customer_id, a.due_in_days ?? 30, a.notes || null, crypto.randomBytes(12).toString('hex'), at, at);
    const { subtotal, taxTotal } = writeLines(db, id, a.lines);
    db.prepare('UPDATE solo_invoice SET subtotal = ?, tax_total = ?, total = ?, updated_at = ? WHERE id = ?')
      .run(subtotal, taxTotal, subtotal + taxTotal, at, id);
    return V.invoiceView(id);
  },
});

defineCommand({
  name: 'solo_update_draft',
  permission: 'billing.write',
  title: 'Update draft', group: 'Invoicing', subject: 'solo_invoice',
  summary: 'Change a draft: lines, due days, notes. Drafts are the only editable state.',
  doctrine: 'Once issued, an invoice is immutable (S-2) — corrections after that are void-and-reissue, on the record.',
  effects: ['draft updated, totals recomputed'],
  guards: [ (i) => i.status === 'draft' || `Only a draft can be edited; ${i.id} is ${i.status}. Mistakes on an issued invoice are void-and-reissue (S-2).` ],
  args: {
    invoice_id: { ...f.text('The draft, e.g. INV-0001.'), required: true },
    lines: f.lines(LINE, 'The new full set of lines (replaces all).'),
    due_in_days: f.int('Days until due.'),
    notes: f.note(''),
  },
  handler(a, { db, at }) {
    const inv = H.need('solo_invoice', a.invoice_id, 'invoice');
    if (inv.status !== 'draft') throw new Rejected(`Only a draft can be edited; ${inv.id} is ${inv.status}. Mistakes on an issued invoice are void-and-reissue (S-2).`);
    if (a.lines) {
      if (!a.lines.length) throw new Rejected('An invoice needs at least one line.');
      const { subtotal, taxTotal } = writeLines(db, inv.id, a.lines);
      db.prepare('UPDATE solo_invoice SET subtotal = ?, tax_total = ?, total = ? WHERE id = ?').run(subtotal, taxTotal, subtotal + taxTotal, inv.id);
    }
    if (a.due_in_days !== undefined) db.prepare('UPDATE solo_invoice SET due_in_days = ? WHERE id = ?').run(a.due_in_days, inv.id);
    if (a.notes !== undefined) db.prepare('UPDATE solo_invoice SET notes = ? WHERE id = ?').run(a.notes || null, inv.id);
    db.prepare('UPDATE solo_invoice SET updated_at = ? WHERE id = ?').run(at, inv.id);
    return V.invoiceView(inv.id);
  },
});

defineCommand({
  name: 'solo_issue_invoice',
  permission: 'billing.write',
  title: 'Issue', group: 'Invoicing', subject: 'solo_invoice',
  summary: 'Make it real: freeze the seller and bill-to blocks, set the due date; the preview link becomes the document.',
  doctrine: `Issuing is the point of no return (S-2): the seller block freezes from your
company profile and the bill-to block from the customer (S-3), the due date is computed from
the draft's terms, and the preview link becomes the document. Show the person the preview
(doc_path) and the full numbers and get their confirmation BEFORE calling this. Refused
without a company profile or a customer billing address — the refusal says what to gather.
After: call solo_get_document and hand the person pdf_url — a direct download of the finished PDF; they
send it themselves (S-7). Do not relay the bytes.`,
  effects: ['invoice issued and immutable', 'seller and bill-to blocks frozen', 'document link final', 'PDF available'],
  guards: [
    (i) => i.status === 'draft' || `${i.id} is already ${i.status}.`,
    (i, ctx) => !!(ctx && ctx.has_profile) || NO_PROFILE,
    (i) => !!(i.customer && i.customer.address) || NO_ADDRESS(i.customer || { name: i.customer_name }),
  ],
  args: { invoice_id: { ...f.text('The draft to issue.'), required: true } },
  handler(a, { db, at }) {
    const inv = H.need('solo_invoice', a.invoice_id, 'invoice');
    if (inv.status !== 'draft') throw new Rejected(`${inv.id} is already ${inv.status}.`);
    const seller = profile(db);
    if (!seller) throw new Rejected(NO_PROFILE);
    const cust = H.need('customer', inv.customer_id, 'customer');
    if (!cust.address) throw new Rejected(NO_ADDRESS(cust));
    if (!db.prepare('SELECT COUNT(*) n FROM solo_invoice_line WHERE invoice_id = ?').get(inv.id).n) {
      throw new Rejected('An invoice needs at least one line.');
    }
    const issued = at.slice(0, 10);
    const due = H.addDays(issued, inv.due_in_days ?? 30);
    const token = inv.doc_token || crypto.randomBytes(12).toString('hex');   // drafts from before previews existed
    db.prepare(`UPDATE solo_invoice SET status = 'issued', issued_at = ?, due_at = ?, seller_json = ?, customer_json = ?, doc_token = ?, updated_at = ? WHERE id = ?`)
      .run(issued, due,
           JSON.stringify({ name: seller.name, address: seller.address, tax_id: seller.tax_id, payment_instructions: seller.payment_instructions, footer_note: seller.footer_note, updated_at: seller.updated_at }),
           JSON.stringify({ name: cust.name, email: cust.email, address: cust.address, tax_id: cust.tax_id }),
           token, at, inv.id);
    return V.invoiceView(inv.id);
  },
});

defineCommand({
  name: 'solo_void_invoice',
  permission: 'billing.write',
  title: 'Void', group: 'Invoicing', subject: 'solo_invoice',
  summary: 'Kill an invoice, on the record. The number stays burned (S-4).',
  doctrine: `Void is for mistakes and cancellations; the reason is part of the record. The
document stays readable and printable, stamped VOID, at the same link — a record you cannot
read is not a record. Nothing on it is collectible: open drops to 0. An invoice with payments
applied cannot be voided at 0.1 — unwinding applied cash needs its own design (see the spec's
deferred list). Reissue corrected work as a fresh draft.`,
  effects: ['invoice void', 'number burned', 'open = 0', 'document stays readable, stamped VOID'],
  guards: [
    (i) => i.status !== 'void' || `${i.id} is already void.`,
    (i) => (i.applied || 0) === 0 || `${i.id} has ${i.applied_display} applied — applied cash cannot be unwound at 0.1; the record stands.`,
  ],
  args: {
    invoice_id: { ...f.text('The invoice.'), required: true },
    reason: { ...f.text('Why — part of the record, forever.'), required: true },
  },
  handler(a, { db, at }) {
    const inv = V.invoiceView(a.invoice_id);
    if (inv.status === 'void') throw new Rejected(`${inv.id} is already void.`);
    if (inv.applied > 0) throw new Rejected(`${inv.id} has ${inv.applied_display} applied — applied cash cannot be unwound at 0.1; the record stands.`);
    // The link survives: the document is part of the record, stamped VOID from here on.
    db.prepare("UPDATE solo_invoice SET status = 'void', void_reason = ?, updated_at = ? WHERE id = ?").run(a.reason, at, a.invoice_id);
    return V.invoiceView(a.invoice_id);
  },
});

defineCommand({
  name: 'solo_record_payment',
  permission: 'cash.write',
  title: 'Record payment', group: 'Cash', subject: 'solo_payment', scope: 'collection',
  summary: 'Money arrived. Recording it and deciding what it settles are two acts.',
  doctrine: 'Never guess which invoice a payment is for — unapplied is a valid, visible state. Ask, or leave it unapplied.',
  effects: ['payment recorded as unapplied'],
  args: {
    customer_id: { ...f.ref('customer', 'Who paid.'), required: true },
    amount: { ...f.money('Amount received.'), required: true },
    method: f.pick(['bank', 'paypal', 'stripe', 'check', 'cash', 'other'], 'How it arrived.'),
    reference: f.text('Transfer reference, check number — exactly as shown.'),
    received_at: f.date('Value date. Defaults to today.'),
  },
  handler(a, { db, at }) {
    H.need('customer', a.customer_id, 'customer');
    if (a.amount <= 0) throw new Rejected('A payment must be positive.');
    const id = H.nextId('P', 'solo_payment');
    db.prepare('INSERT INTO solo_payment (id,customer_id,amount,method,reference,received_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, a.customer_id, a.amount, a.method || null, a.reference || null, a.received_at || at.slice(0, 10), at);
    return { ...H.get('solo_payment', id), amount_display: H.money(a.amount) };
  },
});

defineCommand({
  name: 'solo_apply_payment',
  permission: 'cash.write',
  title: 'Apply to invoice', group: 'Cash', subject: 'solo_payment',
  summary: 'Settle an invoice (or part of it) with a recorded payment.',
  doctrine: 'Bounded on both sides — never more than the payment has left, never more than the invoice still owes; refusals name the numbers.',
  effects: ['application recorded', 'invoice -> paid when fully settled'],
  guards: [ (p) => V.paymentUnapplied(p) > 0 || `${p.id} is fully applied — ${H.money(p.amount)} received, ${H.money(p.amount)} applied, $0.00 left.` ],
  args: {
    payment_id: { ...f.text('The payment, e.g. P-0001.'), required: true },
    invoice_id: { ...f.text('The invoice it settles.'), required: true },
    amount: f.money('How much to apply. Omit for the smaller of what is left on each side.'),
  },
  handler(a, { db, at }) {
    const p = H.need('solo_payment', a.payment_id, 'payment');
    const inv = H.need('solo_invoice', a.invoice_id, 'invoice');
    if (inv.status === 'void') throw new Rejected(`${inv.id} is void.`);
    if (inv.status === 'draft') throw new Rejected(`${inv.id} is still a draft — issue it first.`);
    if (inv.customer_id !== p.customer_id) throw new Rejected(`${p.id} is from ${H.get('customer', p.customer_id).name} but ${inv.id} belongs to ${H.get('customer', inv.customer_id).name}. Cash is not transferable between clients.`);
    const payLeft = V.paymentUnapplied(p);
    const invLeft = inv.total - V.invoiceApplied(inv.id);
    if (payLeft <= 0) throw new Rejected(`${p.id} is fully applied — ${H.money(p.amount)} received, ${H.money(p.amount)} applied, $0.00 left.`);
    if (invLeft <= 0) throw new Rejected(`${inv.id} is already settled.`);
    const amount = a.amount ?? Math.min(payLeft, invLeft);
    if (amount <= 0) throw new Rejected('Applied amount must be positive.');
    if (amount > payLeft) throw new Rejected(`${p.id} has only ${H.money(payLeft)} left; you asked for ${H.money(amount)}.`);
    if (amount > invLeft) throw new Rejected(`${inv.id} owes only ${H.money(invLeft)}; you asked to apply ${H.money(amount)}. The remainder stays unapplied.`);
    db.prepare('INSERT INTO solo_payment_application (payment_id,invoice_id,amount,applied_at) VALUES (?,?,?,?)').run(p.id, inv.id, amount, at);
    if (V.invoiceApplied(inv.id) >= inv.total) db.prepare("UPDATE solo_invoice SET status = 'paid', updated_at = ? WHERE id = ?").run(at, inv.id);
    return { applied: H.money(amount), payment_unapplied: H.money(V.paymentUnapplied(H.get('solo_payment', p.id))), invoice: V.invoiceView(inv.id) };
  },
});
