'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const CHANNELS = ['email', 'linkedin', 'letter', 'other'];

// One sentence per rule, written once: the greyed button's tooltip and the thrown refusal
// are the same string because they are the same string.
const SENT_IS_FINAL = (d) => `${d.id} was sent. Its words are the record of what reached a real person, and that record does not get rewritten (CRM-15). Write a follow-up.`;
const DISCARD_IS_FINAL = (d) => `${d.id} was discarded by a person. Reviving it would overturn their decision. Write a fresh draft and say what changed.`;
const CLOSED_ONCE = (d) => `${d.id} is already ${d.status}. A draft is closed once.`;

/**
 * The gate on what a draft may say. Two halves, and the split matters.
 *
 * STRUCTURAL, built in and true everywhere: a bracketed placeholder is an unfinished draft,
 * and a person who sends "Hi [Name]" has been let down by the tool, not by their own reading.
 *
 * CLAIMS, per campaign and written by a person: what this business may assert about itself.
 * An agent cannot be the one deciding which claims it is allowed to make, so the list is
 * human-only (CRM-17). A campaign with no list refuses nothing, and that is the honest
 * default — a built-in list of somebody else's sensitivities is not a safety feature.
 */
const PLACEHOLDER = /\[[^\]\n]{1,40}\]|\{\{[^}\n]{1,40}\}\}|<[A-Z][A-Za-z ]{1,30}>/;

function screen(db, campaign_id, parts) {
  const text = parts.filter(Boolean).join('\n');
  const ph = PLACEHOLDER.exec(text);
  if (ph) throw new Rejected(`The draft still has a placeholder in it: ${ph[0]}. Write the actual words, or leave the sentence out.`);
  const refused = db.prepare("SELECT text, note FROM campaign_claim WHERE campaign_id = ? AND kind = 'refused'").all(campaign_id);
  const low = text.toLowerCase();
  for (const r of refused) {
    if (low.includes(String(r.text).toLowerCase())) {
      throw new Rejected(`"${r.text}" cannot appear in a draft on this campaign.${r.note ? ` ${r.note}` : ''} Rewrite the sentence without it (CRM-17).`);
    }
  }
  return text;
}

defineCommand({
  name: 'crm_draft_message',
  permission: 'sales.write',
  title: 'Draft a message', group: 'CRM', subject: 'account', scope: 'collection',
  summary: 'Write a message to a contact for a person to read, edit and send from their own mailbox. Nothing is sent.',
  doctrine: `THIS SYSTEM HAS NO OUTBOUND CHANNEL (CRM-14). You write; a person reads it, edits
it, sends it themselves, and records that it went. Never tell anyone a message was sent.

USE ONLY WHAT IS IN THE RECORD (CRM-10). The account's hook, trigger_event and path_in
bullets; the contact's name and title. Never a fact about the person or the company that is
not on file. If the record is thin the draft is short, not padded.

READ THE CAMPAIGN'S CLAIMS FIRST (crm_get_campaign). They are the things this business has
decided it may assert about itself, written by a person. Anything beyond them is your
invention, and the refused list is checked against your words at write time — but the list
cannot catch an overstatement of a claim that is itself allowed, so stay inside what the
claim actually says.

RATIONALE IS FOR THE REVIEWER AND IS NEVER SENT (CRM-16): which hook or bullet the angle rests
on, why this contact rather than another at the same account, and anything you were unsure
about. A draft with no rationale is a draft nobody can check.

Only named, live contacts. A gap row has no name to write to, and a departed contact has left.
Check crm_drafts before writing a second message to someone who already has one waiting.`,
  effects: ['draft recorded against the contact, unsent'],
  guardless: true,
  args: {
    contact_id: { ...f.text('Who it is to, e.g. P-0001.'), required: true },
    body:       { ...f.note('The message. Write it as it would be sent, without a signature: it goes from somebody else\'s mailbox.'), required: true },
    rationale:  { ...f.note('For the person reviewing it: the angle, why this contact, what you were unsure about. Never sent.'), required: true },
    subject:    f.text('Subject line, where the channel has one.'),
    channel:    f.pick(CHANNELS, 'How it would go. Default email.'),
  },
  handler(a, { db, at, actor }) {
    const c = H.need('contact', a.contact_id, 'contact');
    if (c.status !== 'named') throw new Rejected(`${a.contact_id} is a ${c.status} row, not a person you can write to. A gap has no name; a departed contact has left (CRM-1).`);
    const acc = H.need('account', c.account_id, 'account');
    if (acc.parked_at) throw new Rejected(`${acc.name} is parked: ${acc.parked_reason} Unpark it first if that has changed.`);
    const channel = a.channel || 'email';
    if (!CHANNELS.includes(channel)) throw new Rejected(`channel must be one of ${CHANNELS.join(', ')}.`);
    if (!String(a.rationale || '').trim()) throw new Rejected('rationale is required: a draft nobody can check is a draft nobody should send (CRM-16).');
    screen(db, acc.campaign_id, [a.subject, a.body]);
    const waiting = db.prepare("SELECT id FROM crm_draft WHERE contact_id = ? AND status = 'draft'").get(a.contact_id);
    const id = H.nextId('D', 'crm_draft');
    db.prepare(`INSERT INTO crm_draft (id,account_id,contact_id,channel,subject,body,rationale,status,written_by,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?, 'draft', ?,?,?)`)
      .run(id, acc.id, a.contact_id, channel, a.subject || null, a.body, String(a.rationale).trim(), actor || 'unknown', at, at);
    return { draft: id, account: acc.name, contact: c.name, channel, status: 'draft',
      note: `Written, not sent — nothing here reaches ${c.name}. A person reads it and sends it themselves, then records it with crm_draft_outcome.${waiting ? ` Note that ${waiting.id} is also still waiting on this contact.` : ''}` };
  },
});

defineCommand({
  name: 'crm_update_draft',
  permission: 'sales.write',
  title: 'Rewrite a draft', group: 'CRM', subject: 'crm_draft',
  summary: 'Rewrite a draft that has not been sent. Pass only what changes.',
  doctrine: `USE THIS WHEN THE ANGLE CHANGES rather than discarding and starting again: a better
hook turns up, the trigger event moves on, your human asks for a different opening. Discarding
loses the rationale and the record of what was already tried on this contact.

A SENT DRAFT CANNOT BE TOUCHED (CRM-15). Its text was copied onto the activity trail as the
record of what actually reached a real person, and rewriting it would leave these books
describing a message nobody sent. Write a follow-up instead.

A DISCARDED DRAFT CANNOT BE REVIVED. A person read it and rejected it; bringing it back would
quietly overturn that decision. Write a fresh one and say in the rationale what changed.

An edit goes through the same claim gate as a new draft: an edit cannot smuggle in what the
first write would have stopped. The draft stays a draft, so a person still reads it.`,
  effects: ['draft text replaced; it remains unsent'],
  guards: [
    (d) => d.status === 'draft' || (d.status === 'sent' ? SENT_IS_FINAL(d) : DISCARD_IS_FINAL(d)),
  ],
  args: {
    draft_id:  { ...f.text('The draft, e.g. D-0001.'), required: true },
    body:      f.note('The new message.'),
    subject:   f.text('The new subject line.'),
    rationale: f.note('The new note to the reviewer.'),
  },
  handler(a, { db, at }) {
    const d = H.need('crm_draft', a.draft_id, 'draft');
    if (d.status === 'sent') throw new Rejected(SENT_IS_FINAL(d));
    if (d.status === 'discarded') throw new Rejected(DISCARD_IS_FINAL(d));
    const acc = H.need('account', d.account_id, 'account');
    const body = a.body === undefined ? d.body : a.body;
    const subject = a.subject === undefined ? d.subject : a.subject;
    if (!String(body || '').trim()) throw new Rejected('A draft with no body is not a draft.');
    screen(db, acc.campaign_id, [subject, body]);
    db.prepare('UPDATE crm_draft SET body = ?, subject = ?, rationale = COALESCE(?, rationale), updated_at = ? WHERE id = ?')
      .run(body, subject || null, a.rationale === undefined ? null : String(a.rationale).trim(), at, d.id);
    return { draft: d.id, status: 'draft', note: `${d.id} rewritten and still unsent. A person reads it again before anything goes.` };
  },
});

defineCommand({
  name: 'crm_draft_outcome',
  permission: 'sales.write',
  title: 'What happened to a draft', group: 'CRM', subject: 'crm_draft',
  summary: 'Record that a person sent a draft, or that they rejected it. Sending happens in their mailbox; this records it.',
  doctrine: `SENT: the person sent it themselves and is telling you so. sent_at is when it
actually went, which is not when this got typed (CRM-5). The draft's exact text is copied onto
the activity trail as the record of what reached a real person, and the draft becomes
immutable from that moment (CRM-15). An account still sitting at not_started or researching
moves to approaching, because it has now been approached — that is a fact, not a forecast.

DISCARDED: a person read it and said no. The reason is for whoever writes the next one, so
"too long, and it opened on us rather than on them" is worth typing and "no" is not.

Never record a send you were told about by nobody. If you did not hear it from your human,
ask; a send that did not happen is the one fact in this system that can embarrass a person in
front of a stranger.`,
  effects: ['draft closed as sent or discarded', 'a sent draft is copied onto the activity trail', 'account moved to approaching on first send'],
  guards: [ (d) => d.status === 'draft' || CLOSED_ONCE(d) ],
  args: {
    draft_id: { ...f.text('The draft, e.g. D-0001.'), required: true },
    outcome:  { ...f.pick(['sent', 'discarded'], 'What the person did with it.'), required: true },
    sent_at:  f.date('When it actually went. Required when sent.'),
    reason:   f.note('For discarded: why, so the next draft is better.'),
  },
  handler(a, { db, at }) {
    const d = H.need('crm_draft', a.draft_id, 'draft');
    if (d.status !== 'draft') throw new Rejected(CLOSED_ONCE(d));
    const acc = H.need('account', d.account_id, 'account');
    if (a.outcome === 'discarded') {
      if (!String(a.reason || '').trim()) throw new Rejected('A discard needs a reason — it is the only thing the next draft has to go on.');
      db.prepare("UPDATE crm_draft SET status = 'discarded', status_reason = ?, updated_at = ? WHERE id = ?").run(String(a.reason).trim(), at, d.id);
      return { draft: d.id, status: 'discarded', note: `${d.id} rejected: ${String(a.reason).trim()} Write a fresh one; this one cannot be revived.` };
    }
    if (!a.sent_at) throw new Rejected('sent_at is required: when it actually went, not when this was typed (CRM-5).');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.sent_at)) throw new Rejected('sent_at must be an ISO date, YYYY-MM-DD.');
    if (a.sent_at > at.slice(0, 10)) throw new Rejected(`sent_at is ${a.sent_at}, which is in the future. Record it when it has happened.`);
    const summary = `${d.channel} sent${d.subject ? `: ${d.subject}` : ''}\n\n${d.body}`;
    const act = db.prepare(`INSERT INTO activity (account_id,contact_id,direction,medium,summary,occurred_at,recorded_at)
                            VALUES (?,?,'outbound',?,?,?,?)`)
      .run(d.account_id, d.contact_id, d.channel === 'email' ? 'email' : d.channel === 'linkedin' ? 'linkedin' : 'other', summary, a.sent_at, at);
    db.prepare("UPDATE crm_draft SET status = 'sent', sent_at = ?, activity_id = ?, updated_at = ? WHERE id = ?")
      .run(a.sent_at, act.lastInsertRowid, at, d.id);
    let moved = null;
    if (acc.status === 'not_started' || acc.status === 'researching') {
      db.prepare("UPDATE account SET status = 'approaching', updated_at = ? WHERE id = ?").run(at, acc.id);
      moved = 'approaching';
    }
    return { draft: d.id, status: 'sent', sent_at: a.sent_at, activity: act.lastInsertRowid,
      account: acc.name, account_status: moved || acc.status,
      note: `Recorded as sent on ${a.sent_at}, and its exact words are now on ${acc.name}'s trail. The draft is immutable from here.${moved ? ` ${acc.name} moves ${acc.status} → approaching: it has been approached.` : ''}` };
  },
});
