'use strict';
/**
 * Bills (P-12): what a vendor says the person owes, prepared here and approved by a person.
 * Saybooks never pays anything. Approving payment is a person's act, refused to an agent
 * whatever its role; the payment happens in their bank and is recorded after the fact, linked
 * to the statement row that shows it when there is one. Bills stay on a cash basis: the
 * statement row is what reaches the books.
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ['bank_transfer', 'card', 'check', 'cash', 'direct_debit', 'other'];
const isDate = (k, v) => { if (v && !ISO.test(v)) throw new Rejected(`${k} must be a date as YYYY-MM-DD; got "${v}".`); };

defineCommand({
  name: 'purch_add_bill',
  permission: 'cash.write',
  title: 'Add a bill', group: 'Purchases', subject: 'purch_bill', scope: 'collection',
  summary: 'Record a bill a vendor sent: who, their number, the dates, the amount. It waits for a person to approve paying it; nothing is paid from here.',
  doctrine: `You were handed a vendor's invoice (a PDF, a photo, an email). Record what it says:
the vendor's name, their invoice number, the bill date, the due date (or the days they give),
the amount and currency as printed, and the category in the person's words. Never invent a
number or a date; empty beats guessed. The same vendor and number is refused a second time, so
a bill forwarded twice is caught. Then tell the person it is waiting for their approval: only
a person approves paying a bill (purch_approve_bill), and the payment itself happens in their
bank. purch_payables shows what is coming due against the cash on their latest statement.`,
  effects: ['bill recorded, waiting for approval'],
  args: {
    vendor: { ...f.text('The vendor\'s name as a person would say it (Acme Supply).'), required: true },
    number: f.text('The vendor\'s own invoice number, as printed.'),
    bill_date: { ...f.date('The date on the bill.'), required: true },
    due_date: f.date('When it is due, as printed.'),
    terms_days: f.int('Or the days the bill gives (30 for net 30), when it prints no due date.'),
    amount: { ...f.money('The total due, as printed.'), required: true },
    currency: f.text('ISO 4217, as printed. Defaults to the company currency.'),
    category: f.text('What it is for, in the person\'s words (supplies, contractor, rent).'),
    description: f.text('A line about it, if the bill has one.'),
    file_name: f.text('The file you were handed, for the record. The file itself stays with the person.'),
    file_hash: f.text('A hash of that file, if you have one.'),
    reason: f.text('Where it came from: "emailed by Acme on the 3rd".'),
  },
  handler(a, { db, at, actor }) {
    const name = String(a.vendor || '').trim(); if (!name) throw new Rejected('A bill needs the vendor\'s name.');
    isDate('bill_date', a.bill_date); isDate('due_date', a.due_date);
    if (!(a.amount > 0)) throw new Rejected('The amount is what the bill says is due, as a positive number of cents (125000 for $1,250.00).');
    let due = a.due_date || null;
    if (!due && a.terms_days != null) { if (a.terms_days < 0 || a.terms_days > 365) throw new Rejected('terms_days is 0 to 365.'); due = H.addDays(a.bill_date, a.terms_days); }
    if (!due) throw new Rejected('Say when it is due: due_date as printed, or terms_days when the bill gives days instead of a date. If it prints neither, ask the person rather than guess.');
    if (due < a.bill_date) throw new Rejected(`The bill is due (${due}) before its own date (${a.bill_date}). Read the dates again.`);
    const cur = (a.currency ? String(a.currency).trim().toUpperCase() : (H.locale().currency || 'USD'));
    if (!/^[A-Z]{3}$/.test(cur)) throw new Rejected(`"${a.currency}" is not a currency code; use three letters, as printed (USD, EUR).`);
    let v = db.prepare('SELECT * FROM purch_vendor WHERE name = ? COLLATE NOCASE').get(name);
    if (!v) { const vid = H.nextId('V', 'purch_vendor'); db.prepare('INSERT INTO purch_vendor (id,name,created_at) VALUES (?,?,?)').run(vid, name, at); v = { id: vid, name }; }
    const number = a.number && String(a.number).trim() ? String(a.number).trim() : null;
    if (number) {
      const dup = db.prepare('SELECT id, status FROM purch_bill WHERE vendor_id = ? AND number = ? COLLATE NOCASE').get(v.id, number);
      if (dup) throw new Rejected(`${v.name} ${number} is already on record as ${dup.id} (${dup.status}). A bill forwarded twice is still one bill.`);
    } else {
      const twin = db.prepare("SELECT id FROM purch_bill WHERE vendor_id = ? AND amount = ? AND bill_date = ? AND status <> 'rejected'").get(v.id, a.amount, a.bill_date);
      if (twin) throw new Rejected(`This looks like ${twin.id}: same vendor, amount and date. If it really is another bill, record its number.`);
    }
    const id = H.nextId('B', 'purch_bill');
    db.prepare(`INSERT INTO purch_bill (id,vendor_id,number,bill_date,due_date,amount,currency,category,description,file_name,file_hash,status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`).run(id, v.id, number, a.bill_date, due, a.amount, cur, a.category ? String(a.category).trim() : null,
      a.description || null, a.file_name || null, a.file_hash || null, actor || null, at, at);
    const b = V.billView(id);
    return { ...b, note: `Recorded ${b.name}: ${b.amount_display}, due ${b.due_date}. It waits for a person to approve paying it; nothing is paid from here.` };
  },
});

defineCommand({
  name: 'purch_approve_bill',
  permission: 'cash.write',
  title: 'Approve payment', group: 'Purchases', subject: 'purch_bill',
  human_only: 'Approving a payment is a person\'s decision about their own money.',
  summary: 'A person approves paying a bill, optionally by a date. Approval is not payment: the money moves in their bank.',
  doctrine: 'Refused to you whatever your role. Show the person the bill and what is due around it (purch_payables), and let them approve it in the app.',
  effects: ['bill approved for payment'],
  guards: [ (b) => b.status === 'open' || `${b.id} is ${b.status}; only an open bill waits for approval.` ],
  args: {
    bill_id: { ...f.text('The bill, e.g. B-0001.'), required: true },
    pay_by: f.date('When to pay it by. Defaults to its due date.'),
    note: f.text('Anything about it ("pay after the client\'s payment lands").'),
  },
  handler(a, { db, at, actor }) {
    const b = H.need('purch_bill', a.bill_id, 'bill');
    if (b.status !== 'open') throw new Rejected(`${b.id} is ${b.status}; only an open bill waits for approval.`);
    isDate('pay_by', a.pay_by);
    db.prepare("UPDATE purch_bill SET status = 'approved', approved_by = ?, approved_at = ?, pay_by = ?, approval_note = ?, updated_at = ? WHERE id = ?")
      .run(actor || null, at, a.pay_by || b.due_date, a.note || null, at, b.id);
    const v = V.billView(b.id);
    return { ...v, note: `Approved: ${v.name}, ${v.amount_display}, to pay by ${v.pay_by}. Pay it from your bank; then record the payment.` };
  },
});

defineCommand({
  name: 'purch_record_bill_payment',
  permission: 'cash.write',
  title: 'Record the payment', group: 'Purchases', subject: 'purch_bill',
  summary: 'Record that a bill was paid, after the fact: the day it went, how, and the statement row that shows it when there is one.',
  doctrine: `Only after the person paid it, and only with the day it actually went. An agent records
payments for approved bills only; a person recording one approves it in the same act. Link the
statement row (transaction_id) when the payment is on an imported statement: the amount and
currency must match and it must be money out. An unreviewed row is reviewed as the bill says
(purchase, its category and vendor), because the bill is the person's word for what it was.`,
  effects: ['bill marked paid', 'statement row linked and reviewed when given'],
  guards: [ (b) => ['open', 'approved'].includes(b.status) || `${b.id} is ${b.status}.` ],
  args: {
    bill_id: { ...f.text('The bill, e.g. B-0001.'), required: true },
    paid_at: { ...f.date('The day it was paid.'), required: true },
    method: f.pick(METHODS, 'How it was paid.'),
    reference: f.text('The bank\'s or the vendor\'s reference, if any.'),
    transaction_id: f.text('The statement row that shows the payment, e.g. T-0042.'),
  },
  handler(a, { db, at, actor, actor_kind }) {
    const b = H.need('purch_bill', a.bill_id, 'bill');
    if (!['open', 'approved'].includes(b.status)) throw new Rejected(`${b.id} is ${b.status}.`);
    if (b.status === 'open' && actor_kind === 'agent')
      throw new Rejected(`${b.id} is not approved. A person approves paying a bill (purch_approve_bill), or records the payment themselves; ask them.`);
    isDate('paid_at', a.paid_at);
    if (a.paid_at > H.today()) throw new Rejected(`${a.paid_at} has not happened yet. Record a payment once it has gone.`);
    let tx = null;
    if (a.transaction_id) {
      tx = H.get('purch_transaction', a.transaction_id);
      if (!tx) throw new Rejected(`Transaction ${a.transaction_id} does not exist.`);
      if (tx.currency !== b.currency) throw new Rejected(`${tx.id} is in ${tx.currency}; ${b.id} is in ${b.currency}.`);
      if (tx.amount >= 0) throw new Rejected(`${tx.id} is money in (${H.money(tx.amount, tx.currency)}); a bill is paid with money out.`);
      if (-tx.amount !== b.amount) throw new Rejected(`${tx.id} is ${H.money(-tx.amount, tx.currency)}; ${b.id} is ${H.money(b.amount, b.currency)}. A part payment is not supported yet; record it when the whole bill is paid.`);
      const other = db.prepare('SELECT id FROM purch_bill WHERE transaction_id = ? AND id <> ?').get(tx.id, b.id);
      if (other) throw new Rejected(`${tx.id} already pays ${other.id}.`);
    }
    if (b.status === 'open') db.prepare('UPDATE purch_bill SET approved_by = ?, approved_at = ?, approval_note = ? WHERE id = ?').run(actor || null, at, 'approved by recording the payment', b.id);
    db.prepare("UPDATE purch_bill SET status = 'paid', paid_at = ?, paid_method = ?, paid_reference = ?, transaction_id = ?, updated_at = ? WHERE id = ?")
      .run(a.paid_at, a.method || null, a.reference || null, tx ? tx.id : null, at, b.id);
    let reviewed = false;
    if (tx && tx.status === 'unreviewed') {
      db.prepare("UPDATE purch_transaction SET status = 'purchase', category = COALESCE(category, ?), vendor_id = COALESCE(vendor_id, ?), note = COALESCE(note, ?), reviewed_at = ? WHERE id = ?")
        .run(b.category, b.vendor_id, `paid ${b.id}${b.number ? ' (' + b.number + ')' : ''}`, at, tx.id);
      reviewed = true;
    }
    const v = V.billView(b.id);
    return { ...v, row_reviewed: reviewed, note: `${v.name} recorded as paid on ${a.paid_at}${tx ? `, shown by ${tx.id}${reviewed ? ', which is now reviewed as the bill says' : ''}` : ''}.` };
  },
});

defineCommand({
  name: 'purch_reject_bill',
  permission: 'cash.write',
  title: 'Reject the bill', group: 'Purchases', subject: 'purch_bill',
  summary: 'Record that a bill will not be paid as it stands: wrong, disputed, a duplicate, not theirs. With a reason.',
  doctrine: 'Rejecting is a decision about a vendor relationship: do it when the person says so, with their reason. The bill stays on the record.',
  effects: ['bill rejected'],
  guards: [ (b) => ['open', 'approved'].includes(b.status) || `${b.id} is ${b.status}.` ],
  args: { bill_id: { ...f.text('The bill, e.g. B-0001.'), required: true }, reason: { ...f.text('Why it will not be paid as it stands.'), required: true } },
  handler(a, { db, at }) {
    const b = H.need('purch_bill', a.bill_id, 'bill');
    if (!['open', 'approved'].includes(b.status)) throw new Rejected(`${b.id} is ${b.status}.`);
    if (!String(a.reason || '').trim()) throw new Rejected('Rejecting a bill needs a reason.');
    db.prepare("UPDATE purch_bill SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?").run(String(a.reason).trim(), at, b.id);
    return { ...V.billView(b.id), note: `${b.id} rejected; it stays on the record.` };
  },
});

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Purchases read', ...def });
read({ name: 'purch_bills', title: 'Bills', summary: 'Bills on record: open ones waiting for approval first, then approved, paid and rejected.',
  args: { status: f.pick(['open', 'approved', 'paid', 'rejected'], 'Only this status.') }, handler: (a) => V.bills(a) });
read({ name: 'purch_get_bill', title: 'Bill', summary: 'One bill with its approval and payment.', args: { bill_id: { ...f.text('e.g. B-0001.'), required: true } }, handler: (a) => V.billView(a.bill_id) });
read({ name: 'purch_payables', title: 'What is coming due', summary: 'Bills waiting to be paid by when they are due (overdue, next 7 days, next 30, later), set against the cash on the latest bank statements.',
  args: { as_of: f.date('Evaluate as of this date. Defaults to today.') }, handler: (a) => V.payables(a) });
