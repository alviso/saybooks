'use strict';
const crypto = require('crypto');
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const LINE = {
  description: { ...f.text('What the work was, in your words. The first line prints as the title; further lines print smaller beneath it.'), required: true },
  qty: { type: 'number', description: 'Quantity or hours — 7.5 is fine. Defaults to 1.', ui: { widget: 'number', label: 'Qty' } },
  rate: { ...f.money('Rate per unit/hour.'), required: true },
  tax_rate_bp: f.int('Tax rate in basis points (1500 = 15%). Omit to use the company default when it is tax registered; 0 makes the line tax-free. An unregistered business cannot tax a line. Determining the rate is your job; capturing it is ours.'),
  ref: f.text('A reference for the line — ticket id, PO line — printed beside the description.', { label: 'Ref' }),
};
const NOT_REGISTERED = (loc) => `This business is not registered for ${loc.tax_label || 'tax'} — a line cannot carry tax. If that changed, the owner sets tax_registered (and the default rate) on the company profile; otherwise leave tax_rate_bp out.`;
const NOT_A_CURRENCY = (cur, loc) => `${cur} is not one of this business's currencies (${loc.currencies.join(', ')}). The owner adds it under Company (currencies) first — never bill in a currency the books do not know.`;
const pickCurrency = (given, loc) => {
  const cur = String(given || loc.currency).toUpperCase().trim();
  if (!H.CUR_RE.test(cur)) throw new Rejected(`${cur} is not a three-letter ISO 4217 currency code.`);
  if (!loc.currencies.includes(cur)) throw new Rejected(NOT_A_CURRENCY(cur, loc));
  return cur;
};
/** The next invoice number from the company's format: INV-{NNNN} by default, INV-{YYYY}-{NNN} restarts each year. */
function nextInvoiceId(db, loc, at) {
  const fmt = loc.number_format || 'INV-{NNNN}';
  const year = String(at).slice(0, 4);
  const m = /^(.*?)\{(N+)\}(.*)$/.exec(fmt.replace('{YYYY}', year).replace('{YY}', year.slice(2)));
  const before = m[1], width = m[2].length, after = m[3];
  let max = 0;
  for (const r of db.prepare('SELECT id FROM solo_invoice').all()) {
    if (!r.id.startsWith(before) || !r.id.endsWith(after)) continue;
    const mid = r.id.slice(before.length, r.id.length - after.length);
    if (/^\d+$/.test(mid)) max = Math.max(max, Number(mid));
  }
  return `${before}${String(max + 1).padStart(width, '0')}${after}`;
}

const NO_ADDRESS = (c) => `${c.name} has no billing address — the document needs a bill-to block. Ask for it (one question), call core_update_customer, and come back (S-3).`;
const NO_PROFILE = 'No company details yet — set whatever the person has already told you with core_set_company_profile, then ask for what is still missing one question at a time: the company name, the address as it should print, how clients pay; then come back (S-3).';
const profile = (db) => db.prepare('SELECT * FROM company_profile WHERE id = 1').get();

function writeLines(db, invoiceId, lines, loc) {
  db.prepare('DELETE FROM solo_invoice_line WHERE invoice_id = ?').run(invoiceId);
  let subtotal = 0, taxTotal = 0, pos = 0;
  for (const l of lines) {
    const qty = l.qty ?? 1;
    if (!(qty > 0)) throw new Rejected('A line quantity must be positive.');
    if (!Number.isInteger(l.rate) || l.rate <= 0) throw new Rejected('A line rate must be a positive whole number of cents.');
    // Tax: the company's scheme decides. Registered -> the default rate unless the line says
    // otherwise (0 = tax-free line). Unregistered -> no line may carry tax, full stop.
    const bp = (l.tax_rate_bp === undefined || l.tax_rate_bp === null) ? (loc.tax_registered ? loc.tax_rate_bp : 0) : l.tax_rate_bp;
    if (!Number.isInteger(bp) || bp < 0 || bp > 10000) throw new Rejected('A line tax rate is a whole number of basis points between 0 and 10000.');
    if (bp > 0 && !loc.tax_registered) throw new Rejected(NOT_REGISTERED(loc));
    const amount = Math.round(qty * l.rate);
    const tax = Math.round(amount * bp / 10000);
    subtotal += amount; taxTotal += tax; pos++;
    db.prepare('INSERT INTO solo_invoice_line (invoice_id,pos,description,qty,rate,amount,tax_rate_bp,tax_amount,ref) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(invoiceId, pos, l.description, qty, l.rate, amount, bp, tax, l.ref || null);
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
    currency: f.text('Currency of this invoice, ISO 4217. Defaults to the company default; must be one of the company\'s currencies.'),
    subject: f.text('One line above the table — project, period. Printed on the document.'),
    notes: f.note('Printed on the document (project reference, thanks, PO number they gave you).'),
  },
  handler(a, { db, at }) {
    H.need('customer', a.customer_id, 'customer');
    if (!a.lines || !a.lines.length) throw new Rejected('An invoice needs at least one line.');
    const loc = H.locale();
    const currency = pickCurrency(a.currency, loc);
    const id = nextInvoiceId(db, loc, at);
    // The preview link exists from the first draft (S-7): the same token becomes the document at issue.
    db.prepare(`INSERT INTO solo_invoice (id,customer_id,status,due_in_days,notes,currency,subject,doc_token,created_at,updated_at)
                VALUES (?,?,'draft',?,?,?,?,?,?,?)`).run(id, a.customer_id, a.due_in_days ?? 30, a.notes || null, currency, a.subject || null, crypto.randomBytes(12).toString('hex'), at, at);
    const { subtotal, taxTotal } = writeLines(db, id, a.lines, loc);
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
    currency: f.text('Change the currency of the draft (one of the company\'s currencies).'),
    subject: f.text('One line above the table — project, period.'),
    notes: f.note(''),
  },
  handler(a, { db, at }) {
    const inv = H.need('solo_invoice', a.invoice_id, 'invoice');
    if (inv.status !== 'draft') throw new Rejected(`Only a draft can be edited; ${inv.id} is ${inv.status}. Mistakes on an issued invoice are void-and-reissue (S-2).`);
    const loc = H.locale();
    if (a.currency !== undefined) db.prepare('UPDATE solo_invoice SET currency = ? WHERE id = ?').run(pickCurrency(a.currency, loc), inv.id);
    if (a.subject !== undefined) db.prepare('UPDATE solo_invoice SET subject = ? WHERE id = ?').run(a.subject || null, inv.id);
    if (a.lines) {
      if (!a.lines.length) throw new Rejected('An invoice needs at least one line.');
      const { subtotal, taxTotal } = writeLines(db, inv.id, a.lines, loc);
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
           JSON.stringify({ name: seller.name, address: seller.address, tax_id: seller.tax_id, payment_instructions: seller.payment_instructions, footer_note: seller.footer_note, updated_at: seller.updated_at,
                            country: seller.country || null, tax_label: seller.tax_label || null, tax_registered: !!seller.tax_registered, tax_id_label: seller.tax_id_label || null }),
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
    currency: f.text('Currency the money arrived in, ISO 4217. Defaults to the company default; a payment only ever settles invoices in its own currency.'),
  },
  handler(a, { db, at }) {
    H.need('customer', a.customer_id, 'customer');
    if (a.amount <= 0) throw new Rejected('A payment must be positive.');
    const currency = pickCurrency(a.currency, H.locale());
    const id = H.nextId('P', 'solo_payment');
    db.prepare('INSERT INTO solo_payment (id,customer_id,amount,method,reference,received_at,currency,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, a.customer_id, a.amount, a.method || null, a.reference || null, a.received_at || at.slice(0, 10), currency, at);
    return { ...H.get('solo_payment', id), amount_display: H.money(a.amount, currency) };
  },
});

defineCommand({
  name: 'solo_apply_payment',
  permission: 'cash.write',
  title: 'Apply to invoice', group: 'Cash', subject: 'solo_payment',
  summary: 'Settle an invoice (or part of it) with a recorded payment.',
  doctrine: 'Bounded on both sides — never more than the payment has left, never more than the invoice still owes; refusals name the numbers.',
  effects: ['application recorded', 'invoice -> paid when fully settled'],
  guards: [ (p) => V.paymentUnapplied(p) > 0 || `${p.id} is fully applied — ${H.money(p.amount, p.currency)} received, ${H.money(p.amount, p.currency)} applied, ${H.money(0, p.currency)} left.` ],
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
    if ((inv.currency || 'USD') !== (p.currency || 'USD')) throw new Rejected(`${p.id} is in ${p.currency || 'USD'} but ${inv.id} is in ${inv.currency || 'USD'}. Cash cannot cross currencies — record the ${inv.currency || 'USD'} amount that actually arrived, or leave this payment unapplied.`);
    if (inv.customer_id !== p.customer_id) throw new Rejected(`${p.id} is from ${H.get('customer', p.customer_id).name} but ${inv.id} belongs to ${H.get('customer', inv.customer_id).name}. Cash is not transferable between clients.`);
    const payLeft = V.paymentUnapplied(p);
    const invLeft = inv.total - V.invoiceApplied(inv.id);
    const cur = p.currency || 'USD';
    if (payLeft <= 0) throw new Rejected(`${p.id} is fully applied — ${H.money(p.amount, cur)} received, ${H.money(p.amount, cur)} applied, ${H.money(0, cur)} left.`);
    if (invLeft <= 0) throw new Rejected(`${inv.id} is already settled.`);
    const amount = a.amount ?? Math.min(payLeft, invLeft);
    if (amount <= 0) throw new Rejected('Applied amount must be positive.');
    if (amount > payLeft) throw new Rejected(`${p.id} has only ${H.money(payLeft, cur)} left; you asked for ${H.money(amount, cur)}.`);
    if (amount > invLeft) throw new Rejected(`${inv.id} owes only ${H.money(invLeft, cur)}; you asked to apply ${H.money(amount, cur)}. The remainder stays unapplied.`);
    db.prepare('INSERT INTO solo_payment_application (payment_id,invoice_id,amount,applied_at) VALUES (?,?,?,?)').run(p.id, inv.id, amount, at);
    if (V.invoiceApplied(inv.id) >= inv.total) db.prepare("UPDATE solo_invoice SET status = 'paid', updated_at = ? WHERE id = ?").run(at, inv.id);
    return { applied: H.money(amount, cur), payment_unapplied: H.money(V.paymentUnapplied(H.get('solo_payment', p.id)), cur), invoice: V.invoiceView(inv.id) };
  },
});
