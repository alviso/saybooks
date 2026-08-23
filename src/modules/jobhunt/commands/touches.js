'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'hunt_log_interaction',
  title: 'Log touch', group: 'Jobhunt', subject: 'posting', scope: 'collection',
  permission: 'sales.write',
  summary: 'The workhorse: record any touch, optionally with the next action and its due date.',
  doctrine: `Direction matters: follow-up nudges key on real outbound touches. A next_action
supersedes the posting's previous open one — history kept, because what you MEANT to do is
part of the record (JH-6). Facts in the summary come from real correspondence (JH-1);
interpretation is yours.`,
  effects: ['touch recorded', 'previous open next action superseded when a new one is given'],
  args: {
    direction: { ...f.pick(['in', 'out'], ''), required: true },
    summary: { ...f.note('What happened, in your own terms.'), required: true },
    posting_id: f.text('The posting, if about one.'),
    contact_id: f.text('The person, if with one.'),
    medium: f.pick(['email', 'linkedin', 'phone', 'portal', 'other'], ''),
    at: f.text('ISO timestamp. Defaults to now.'),
    next_action: f.text('The one thing to do next on this posting.'),
    next_action_due: f.date('When.'),
  },
  handler(a, { db, at }) {
    if (a.posting_id) H.need('hunt_posting', a.posting_id, 'posting');
    if (a.contact_id) H.need('hunt_contact', a.contact_id, 'contact');
    let superseded = 0;
    if (a.next_action && a.posting_id) {
      superseded = db.prepare("UPDATE hunt_interaction SET next_action_state = 'superseded' WHERE posting_id = ? AND next_action_state = 'open'").run(a.posting_id).changes;
    }
    db.prepare(`INSERT INTO hunt_interaction (posting_id,contact_id,at,direction,medium,summary,next_action,next_action_due,next_action_state,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(a.posting_id || null, a.contact_id || null, a.at || at, a.direction, a.medium || null, a.summary,
           a.next_action || null, a.next_action_due || null, a.next_action ? 'open' : null, at);
    const superseded_total = a.posting_id
      ? db.prepare("SELECT COUNT(*) n FROM hunt_interaction WHERE posting_id = ? AND next_action_state = 'superseded'").get(a.posting_id).n : 0;
    return a.posting_id
      ? { ...V.postingView(a.posting_id), superseded_now: superseded, superseded_count: superseded_total }
      : { logged: true };
  },
});

defineCommand({
  name: 'hunt_complete_next_action',
  title: 'Complete next action', group: 'Jobhunt', subject: 'posting', scope: 'collection',
  permission: 'sales.write',
  summary: 'Close the open next action once handled.',
  doctrine: 'With direction and medium it counts as a real touch; without them it is an internal note that triggers no follow-up nudge — the honest difference between "I emailed them" and "I decided it is done".',
  effects: ['open next action -> done', 'a touch logged'],
  args: {
    posting_id: f.text('The posting whose open next action is done.'),
    note: f.text('What actually happened. Defaults to "Done: <the action>".'),
    direction: f.pick(['in', 'out'], 'Pass with medium if it was a real touch.'),
    medium: f.pick(['email', 'linkedin', 'phone', 'portal', 'other'], ''),
  },
  handler(a, { db, at }) {
    if (!a.posting_id) throw new Rejected('Say which posting — pass posting_id.');
    const open = V.openAction(a.posting_id);
    if (!open) throw new Rejected('No open next action on this posting.');
    db.prepare("UPDATE hunt_interaction SET next_action_state = 'done' WHERE id = ?").run(open.id);
    db.prepare(`INSERT INTO hunt_interaction (posting_id,at,direction,medium,summary,created_at) VALUES (?,?,?,?,?,?)`)
      .run(a.posting_id, at, a.direction || 'out', a.direction ? (a.medium || 'other') : 'other',
           a.note || `Done: ${open.next_action}`, at);
    return V.postingView(a.posting_id);
  },
});

defineCommand({
  name: 'hunt_add_contact',
  title: 'Add contact', group: 'Jobhunt', subject: 'posting', scope: 'collection',
  permission: 'sales.write',
  summary: 'Add a person. A source is mandatory — how we know them.',
  doctrine: 'Never invent a contact (JH-2). The source is the answer to "how do we know this person" — a recruiter who reached out, a referral, a name from an email thread.',
  effects: ['contact created'],
  args: {
    name: { ...f.text('The person.'), required: true },
    source: { ...f.text('REQUIRED: where this person came from.'), required: true },
    company: f.text('Their company — created if new.'),
    company_kind: f.pick(['end_client', 'consultancy', 'staffing_agency', 'product_vendor', 'rpo'], ''),
    role: f.text(''), email: f.text(''), phone: f.text(''), linkedin_url: f.text(''),
    relationship: f.pick(['cold', 'contacted', 'responsive', 'warm_scout', 'dead'], ''),
    notes: f.note(''),
  },
  handler(a, { db, at }) {
    const co = a.company ? V.ensureCompany(db, a.company, a.company_kind, at) : null;
    const id = H.nextId('HC', 'hunt_contact');
    db.prepare(`INSERT INTO hunt_contact (id,company_id,name,role,email,phone,linkedin_url,relationship,source,notes,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, co ? co.id : null, a.name, a.role || null, a.email || null, a.phone || null, a.linkedin_url || null,
           a.relationship || 'cold', a.source, a.notes || null, at, at);
    return H.get('hunt_contact', id);
  },
});

defineCommand({
  name: 'hunt_update_contact',
  title: 'Update contact', group: 'Jobhunt', subject: 'contact', scope: 'instance', guardless: true,
  permission: 'sales.write',
  summary: 'Patch a contact. The source is never cleared.',
  doctrine: 'Relationships move (cold → contacted → responsive → warm_scout, or dead); provenance does not (JH-2).',
  effects: ['contact updated'],
  args: {
    contact_id: { ...f.text('The contact, e.g. HC-0001.'), required: true },
    name: f.text(''), role: f.text(''), email: f.text(''), phone: f.text(''), linkedin_url: f.text(''),
    relationship: f.pick(['cold', 'contacted', 'responsive', 'warm_scout', 'dead'], ''),
    source: f.text('Correctable, never removable.'), notes: f.note(''),
  },
  handler(a, { db, at }) {
    H.need('hunt_contact', a.contact_id, 'contact');
    if (a.source === '') throw new Rejected('The source can be corrected, never removed (JH-2).');
    if (a.name === '') throw new Rejected('A contact keeps a name.');
    const fields = ['name', 'role', 'email', 'phone', 'linkedin_url', 'relationship', 'source', 'notes'];
    for (const k of fields) if (a[k] !== undefined) db.prepare(`UPDATE hunt_contact SET ${k} = ?, updated_at = ? WHERE id = ?`).run(a[k] === '' ? null : a[k], at, a.contact_id);
    return H.get('hunt_contact', a.contact_id);
  },
});

defineCommand({
  name: 'hunt_add_resume_version',
  title: 'Register resume version', group: 'Jobhunt', subject: 'posting', scope: 'collection',
  permission: 'sales.write',
  summary: 'Register a resume version so applications can point at what was actually sent.',
  doctrine: 'When a recruiter says "the resume you sent", there must be exactly one answer (JH-10).',
  effects: ['resume version registered'],
  args: {
    label: { ...f.text('Short unique name, e.g. "AI & Integration".'), required: true },
    platform: f.pick(['resume.io', 'file'], ''),
    external_id: f.text(''), headline: f.text(''), focus: f.text(''), file_path: f.text(''), notes: f.note(''),
  },
  handler(a, { db, at }) {
    if (db.prepare('SELECT id FROM hunt_resume_version WHERE label = ?').get(a.label)) throw new Rejected(`Version "${a.label}" already exists.`);
    const id = H.nextId('RV', 'hunt_resume_version');
    db.prepare(`INSERT INTO hunt_resume_version (id,label,platform,external_id,headline,focus,file_path,notes,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, a.label, a.platform || null, a.external_id || null, a.headline || null, a.focus || null, a.file_path || null, a.notes || null, at);
    return H.get('hunt_resume_version', id);
  },
});
