'use strict';
/**
 * Payment reminders for overdue invoices (S-13). The agent drafts the words; a person sends
 * them from their own mailbox and says when; the books keep both. Saybooks never sends (S-7).
 * The figures in a reminder are the invoice's own: the number and the open amount appear, and
 * no other amount does, so a reminder can never ask a client for money nobody agreed.
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const SPACING_DAYS = 7;
const PLACEHOLDER = /\[[^\]\n]{1,40}\]|\{\{|<[A-Z][A-Z _]{2,30}>|\bX{3,}\b|\bTBD\b/;

/** Every amount written with two decimals, as cents: "$1,250.00", "1 250,00 Kč", "1250.00". */
function amountsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\d[\d.,   ]*[.,]\d{2}(?!\d)/g)) {
    const raw = m[0].trim();
    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length < 3) continue;
    out.push({ raw, cents: Number(digits) });
  }
  return out;
}
/** The words around the facts are the agent's; the facts are the invoice's. */
function checkFacts(inv, subject, body) {
  const text = `${subject}\n${body}`;
  const ph = PLACEHOLDER.exec(text);
  if (ph) throw new Rejected(`The reminder still has a placeholder, "${ph[0]}". Write the real words, or leave that part out.`);
  if (!text.toLowerCase().includes(String(inv.id).toLowerCase())) throw new Rejected(`Name the invoice in the reminder: ${inv.id}. A client with several invoices needs to know which one.`);
  const amounts = amountsIn(text);
  const allowed = new Set([inv.open, inv.total, inv.paid].filter(n => n > 0));
  const stray = amounts.find(a => !allowed.has(a.cents));
  if (stray) throw new Rejected(`The reminder says ${stray.raw}, but ${inv.id} has ${H.money(inv.open, inv.currency)} open of ${H.money(inv.total, inv.currency)}. Use the invoice's own figures; never add a fee or interest the person has not told you was agreed.`);
  if (!amounts.some(a => a.cents === inv.open)) throw new Rejected(`Say what is owed: ${H.money(inv.open, inv.currency)} is open on ${inv.id}.`);
}

defineCommand({
  name: 'solo_draft_reminder',
  permission: 'billing.write',
  title: 'Draft a reminder', group: 'Invoicing', subject: 'solo_invoice',
  summary: 'Write a payment reminder for an overdue invoice. It is a draft the person sends from their own mailbox; Saybooks never sends it.',
  doctrine: `For an invoice past its due date with money still open (solo_outstanding lists
days_overdue, reminders_sent and next_stage). Write it in the person's voice, short and
specific: the invoice number, the amount open, the due date, and pdf_url from
solo_get_document so the client can pay without hunting. A first reminder assumes it slipped;
a second asks when to expect payment; a final one says plainly what happens next, but only
what the person has told you. Never mention a late fee, interest or a collections step that
was not agreed: the figures are checked, and an amount the invoice does not have is refused.
Show the person the draft. They send it themselves; when they say it went, record it with
solo_reminder_outcome and the date it went.`,
  effects: ['reminder drafted against the invoice'],
  guards: [
    (i) => i.status === 'issued' || `${i.id} is ${i.status}; only an issued invoice with money open gets a reminder.`,
    (i) => { const o = V.invOpen(i.id); return (o && o.open > 0) || `${i.id} is paid in full; nothing to remind about.`; },
    (i) => (i.due_at && i.due_at < H.today()) || `${i.id} is not overdue: it is due ${i.due_at || 'on terms not set'}. A reminder before the due date is a different message; send it yourself if the agreement allows.`,
  ],
  args: {
    invoice_id: { ...f.text('The overdue invoice, e.g. INV-0003.'), required: true },
    subject: { ...f.text('The email subject line.'), required: true },
    body: { ...f.note('The email body, in the person\'s voice, with the invoice number and the amount open.'), required: true },
    soon_because: f.text('Only when the last reminder went less than seven days ago: why another one now.'),
  },
  handler(a, { db, at, actor }) {
    const inv = V.invOpen(a.invoice_id);
    if (!inv) throw new Rejected(`Invoice ${a.invoice_id} does not exist.`);
    if (inv.status !== 'issued') throw new Rejected(`${inv.id} is ${inv.status}; only an issued invoice with money open gets a reminder.`);
    if (inv.open <= 0) throw new Rejected(`${inv.id} is paid in full; nothing to remind about.`);
    if (!(inv.due_at && inv.due_at < H.today())) throw new Rejected(`${inv.id} is not overdue: it is due ${inv.due_at || 'on terms not set'}. A reminder before the due date is a different message; send it yourself if the agreement allows.`);
    const subject = String(a.subject || '').trim(), body = String(a.body || '').trim();
    if (!subject || !body) throw new Rejected('A reminder needs a subject and a body.');
    const rs = V.remindersOf(inv.id);
    const waiting = rs.find(r => r.status === 'draft');
    if (waiting) throw new Rejected(`${waiting.id} is already waiting to be sent for ${inv.id}. Send it, or discard it with solo_reminder_outcome, before drafting another.`);
    const sent = rs.filter(r => r.status === 'sent');
    const last = sent.map(r => r.sent_at).sort().pop();
    if (last && H.addDays(last, SPACING_DAYS) > H.today() && !String(a.soon_because || '').trim())
      throw new Rejected(`The last reminder for ${inv.id} went on ${last}, less than ${SPACING_DAYS} days ago. Another so soon reads as pressure; if the person wants it anyway, pass soon_because with their reason.`);
    checkFacts(inv, subject, body);
    const id = H.nextId('REM', 'solo_reminder');
    db.prepare(`INSERT INTO solo_reminder (id,invoice_id,customer_id,stage,subject,body,open_at_draft,currency,due_at,days_overdue,status,soon_because,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?)`).run(id, inv.id, inv.customer_id, sent.length + 1, subject, body, inv.open, inv.currency || 'USD', inv.due_at, V.daysOver(inv.due_at),
      a.soon_because ? String(a.soon_because).trim() : null, actor || null, at);
    const r = V.reminderView(id);
    return { ...r, note: `Drafted the ${r.stage_name} reminder for ${inv.id} (${r.open_now_display} open, ${r.days_overdue} days overdue). Show it to the person; they send it from their own mailbox${r.mailto ? ' (mailto opens it addressed and filled in)' : ''}, then tell you when it went.` };
  },
});

defineCommand({
  name: 'solo_reminder_outcome',
  permission: 'billing.write',
  title: 'What happened to a reminder', group: 'Invoicing', subject: 'solo_reminder',
  summary: 'Record that the person sent a reminder, and when, or that they discarded it, and why.',
  doctrine: `SENT: the person sent it from their own mailbox and is telling you so. sent_at is the
day it actually went, not today by default. Never record a send nobody told you about: a
reminder that did not go is the one fact here that can embarrass a person in front of a client.
DISCARDED: they decided against it; the reason is for whoever drafts the next one.`,
  effects: ['reminder closed as sent or discarded'],
  guards: [ (r) => r.status === 'draft' || `${r.id} is already ${r.status}.` ],
  args: {
    reminder_id: { ...f.text('The reminder, e.g. REM-0001.'), required: true },
    outcome: { ...f.pick(['sent', 'discarded'], 'What the person did with it.'), required: true },
    sent_at: f.date('When it actually went. Required when sent.'),
    reason: f.text('For discarded: why.'),
  },
  handler(a, { db, at }) {
    const r = H.need('solo_reminder', a.reminder_id, 'reminder');
    if (r.status !== 'draft') throw new Rejected(`${r.id} is already ${r.status}.`);
    if (a.outcome === 'discarded') {
      if (!String(a.reason || '').trim()) throw new Rejected('A discard needs a reason, for whoever drafts the next one.');
      db.prepare("UPDATE solo_reminder SET status = 'discarded', discard_reason = ?, closed_at = ? WHERE id = ?").run(String(a.reason).trim(), at, r.id);
      return { ...V.reminderView(r.id), note: `${r.id} discarded.` };
    }
    if (!a.sent_at) throw new Rejected('Say when it went: sent_at, the day the person sent it.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.sent_at)) throw new Rejected(`sent_at must be a date as YYYY-MM-DD; got "${a.sent_at}".`);
    if (a.sent_at > H.today()) throw new Rejected(`${a.sent_at} has not happened yet. Record a send once it has gone.`);
    if (a.sent_at < String(r.created_at).slice(0, 10)) throw new Rejected(`${r.id} was drafted on ${String(r.created_at).slice(0, 10)}; it cannot have gone on ${a.sent_at}.`);
    db.prepare("UPDATE solo_reminder SET status = 'sent', sent_at = ?, closed_at = ? WHERE id = ?").run(a.sent_at, at, r.id);
    const v = V.reminderView(r.id);
    return { ...v, note: `${r.id} recorded as sent on ${a.sent_at}.${v.stale ? ' The invoice is no longer open; the record keeps it anyway.' : ''}` };
  },
});

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Invoicing read', ...def });
read({ name: 'solo_reminders', title: 'Reminders', summary: 'Payment reminders: drafts waiting to be sent first, then what went and when, with a mailto link that opens each draft addressed and filled in.',
  args: { status: f.pick(['draft', 'sent', 'discarded'], 'Only this status.') }, handler: (a) => V.reminders(a) });
read({ name: 'solo_get_reminder', title: 'Reminder', summary: 'One reminder with its invoice\'s open amount now.', args: { reminder_id: { ...f.text('e.g. REM-0001.'), required: true } }, handler: (a) => V.reminderView(a.reminder_id) });
