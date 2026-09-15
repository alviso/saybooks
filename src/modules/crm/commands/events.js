'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const KINDS = ['meeting', 'call', 'workshop', 'deadline', 'other'];
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// One sentence per rule, written once (gate 8).
const CLOSED = (e) => `${e.id} is ${e.status}${e.status_reason ? ` (${e.status_reason})` : ''}. A closed event stays closed; add a new one if it is happening after all.`;

defineCommand({
  name: 'crm_add_event',
  permission: 'sales.write',
  title: 'Add event', group: 'CRM', subject: 'account',
  summary: 'Put something that is going to happen on an account: a workshop, a call, a deadline. With the source the date came from.',
  doctrine: `NEVER INVENT A DATE (CRM-20). The date on an event comes from the source, and the
source is a field here because it will be read back by the person deciding whether to turn up.

A page that lists dates in one column and topics in another, without pairing them, HAS NOT
GIVEN YOU A DATE for any topic. Reading one off by position is how a first approach ends: a
message to the person who owns the curriculum, naming a day they never published. If the
source does not pin the date, there is no event; tell your human what you found and where,
and let them decide.

The source is a URL when you found it, or "told by <name> on <date>" when a person told you.
An event nobody can trace is a diary entry, not a record.

Use contact_id when the event is with, or run by, a specific person on the account. The
account is enough for a public workshop. The note is why this is worth their time: what it
opens, who will be there, what to do about it beforehand.`,
  effects: ['event recorded as planned, with its source'],
  guardless: true,
  args: {
    account_id: { ...f.ref('account', 'The account this concerns.'), required: true },
    title:      { ...f.text('What it is, as the source names it.'), required: true },
    date:       { ...f.date('When, from the source.'), required: true },
    source:     { ...f.text('The page the date is on, or "told by <name> on <date>".'), required: true },
    time:       f.text('HH:MM, local to the place, if the source gives one. Empty otherwise: a time is a fact too.'),
    kind:       f.pick(KINDS, 'meeting, call, workshop, deadline or other.'),
    contact_id: f.text('The person it is with or run by, e.g. P-0001, if there is one.'),
    location:   f.text('Where, as the source puts it.'),
    url:        f.text('A registration or event page, if it differs from the source.'),
    note:       f.note('Why this is worth their time, and what to do about it beforehand.'),
  },
  handler(a, { db, at, actor }) {
    const acc = H.need('account', a.account_id, 'account');
    if (!DATE.test(a.date)) throw new Rejected('date must be an ISO date, YYYY-MM-DD.');
    if (a.time && !TIME.test(a.time)) throw new Rejected('time must be HH:MM, 24-hour. Leave it empty if the source gives none.');
    if (a.kind && !KINDS.includes(a.kind)) throw new Rejected(`kind must be one of ${KINDS.join(', ')}.`);
    const source = String(a.source || '').trim();
    if (source.length < 8) throw new Rejected('source: the page the date is on, or "told by <name> on <date>" (CRM-20). A date with no source is a date somebody made up.');
    if (a.contact_id) {
      const c = H.need('contact', a.contact_id, 'contact');
      if (c.account_id !== acc.id) throw new Rejected(`${a.contact_id} is on ${c.account_id}, not ${acc.id}.`);
    }
    const id = H.nextId('EV', 'crm_event');
    db.prepare(`INSERT INTO crm_event (id,account_id,contact_id,title,kind,date,time,location,url,source,note,status,created_by,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,'planned',?,?,?)`)
      .run(id, acc.id, a.contact_id || null, String(a.title).trim(), a.kind || 'other', a.date, a.time || null,
           a.location || null, a.url || null, source, a.note || null, actor || 'unknown', at, at);
    const past = a.date < at.slice(0, 10);
    return { event: id, account: acc.name, title: a.title, date: a.date, time: a.time || null, status: 'planned',
      note: `${id} on ${a.date}${a.time ? ` at ${a.time}` : ''} for ${acc.name}.${past ? ' That date has already passed; record what came of it with crm_update_event.' : ''}` };
  },
});

defineCommand({
  name: 'crm_update_event',
  permission: 'sales.write',
  title: 'Update event', group: 'CRM', subject: 'crm_event',
  summary: 'Reschedule, correct, close as done with what came of it, or cancel with a reason.',
  doctrine: `A move of the date needs a reason and a source, the same as the date did the first
time: "the venue page now says the 14th" is a reason; "moved" is not. Done takes an outcome,
because an event with no outcome is an intention that went stale. Cancelled takes a reason.
Neither is undone here (CRM-21): if a cancelled thing is happening after all, that is a new
event with a new source.`,
  effects: ['event rescheduled, corrected, done or cancelled; the reason kept'],
  guards: [ (e) => e.status === 'planned' || CLOSED(e) ],
  args: {
    event_id: { ...f.text('The event, e.g. EV-0001.'), required: true },
    status:   f.pick(['done', 'cancelled'], 'Close it. done needs an outcome; cancelled needs a reason.'),
    outcome:  f.note('For done: what came of it.'),
    reason:   f.note('Why it moved, or why it was cancelled.'),
    date:     f.date('New date, with its reason and source.'),
    time:     f.text('New time, HH:MM, or empty string to clear.'),
    source:   f.text('Where the new date came from, when the date changes.'),
    title:    f.text(''), location: f.text(''), url: f.text(''), note: f.note(''),
    contact_id: f.text('Who it is with, e.g. P-0001.'),
  },
  handler(a, { db, at }) {
    const e = H.need('crm_event', a.event_id, 'event');
    if (e.status !== 'planned') throw new Rejected(CLOSED(e));
    if (a.date !== undefined) {
      if (!DATE.test(a.date)) throw new Rejected('date must be an ISO date, YYYY-MM-DD.');
      if (a.date !== e.date && !String(a.reason || '').trim()) throw new Rejected('Moving the date needs a reason: what changed, and where you saw it.');
      if (a.date !== e.date && !String(a.source || '').trim()) throw new Rejected('A new date needs its source, the same as the first one did (CRM-20).');
    }
    if (a.time !== undefined && a.time !== '' && !TIME.test(a.time)) throw new Rejected('time must be HH:MM, or an empty string to clear it.');
    if (a.contact_id) {
      const c = H.need('contact', a.contact_id, 'contact');
      if (c.account_id !== e.account_id) throw new Rejected(`${a.contact_id} is on ${c.account_id}, not ${e.account_id}.`);
    }
    for (const k of ['date', 'time', 'source', 'title', 'location', 'url', 'note', 'contact_id']) {
      if (a[k] === undefined) continue;
      db.prepare(`UPDATE crm_event SET ${k} = ?, updated_at = ? WHERE id = ?`).run(a[k] === '' ? null : a[k], at, e.id);
    }
    if (a.status === 'done') {
      if (!String(a.outcome || '').trim()) throw new Rejected('done needs an outcome: what came of it. An event with no outcome is an intention that went stale.');
      db.prepare("UPDATE crm_event SET status = 'done', outcome = ?, status_reason = ?, updated_at = ? WHERE id = ?").run(String(a.outcome).trim(), a.reason || null, at, e.id);
    } else if (a.status === 'cancelled') {
      if (!String(a.reason || '').trim()) throw new Rejected('cancelled needs a reason (CRM-21).');
      db.prepare("UPDATE crm_event SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE id = ?").run(String(a.reason).trim(), at, e.id);
    } else if (a.status !== undefined) throw new Rejected('status closes an event: done or cancelled.');
    const now = H.get('crm_event', e.id);
    return { event: now.id, title: now.title, date: now.date, time: now.time, status: now.status,
      note: now.status === 'planned' ? `${now.id} now on ${now.date}${now.time ? ` at ${now.time}` : ''}.`
          : now.status === 'done' ? `${now.id} done: ${now.outcome}` : `${now.id} cancelled: ${now.status_reason}` };
  },
});
