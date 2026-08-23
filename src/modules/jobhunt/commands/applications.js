'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const logTouch = (db, at, { posting_id, contact_id, direction, medium, summary }, created = at) =>
  db.prepare(`INSERT INTO hunt_interaction (posting_id,contact_id,at,direction,medium,summary,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(posting_id || null, contact_id || null, at, direction, medium || null, summary, created);

defineCommand({
  name: 'hunt_apply',
  title: 'Apply', group: 'Jobhunt', subject: 'posting',
  permission: 'sales.write',
  summary: 'Record an application actually submitted. One per posting.',
  doctrine: `One application per posting (JH-4) — the duplicate guard exists so the SAME role
through two agencies gets a decision, not two submissions. applied_at accepts the literal
"unknown" when the submission is real but the date was never recorded — never guess a date
(JH-1). Record the resume version that actually went out (JH-10).`,
  effects: ['application created', 'posting -> applied', 'submission logged as a touch'],
  guards: [ (p) => !(p.application) || `Already applied (${p.application.id}) — one application per posting (JH-4).` ],
  args: {
    posting_id: { ...f.text('The posting.'), required: true },
    resume_version: f.text('What was actually sent — label or id (JH-10).'),
    channel: f.pick(['easy_apply', 'portal', 'email', 'agency_submission'], ''),
    via_contact: f.text('Recruiter who submitted, e.g. HC-0001 — for the double-submission audit.'),
    applied_at: f.text('ISO date, or the literal "unknown" — never a guess (JH-1).'),
  },
  handler(a, { db, at }) {
    const p = V.postingView(a.posting_id);
    if (p.application) throw new Rejected(`Already applied (${p.application.id}) — one application per posting (JH-4).`);
    let rvId = null;
    if (a.resume_version) {
      const rv = db.prepare('SELECT id FROM hunt_resume_version WHERE label = ? OR id = ?').get(a.resume_version, a.resume_version);
      if (!rv) throw new Rejected(`No resume version "${a.resume_version}" — register it first (JH-10).`);
      rvId = rv.id;
    }
    if (a.via_contact) H.need('hunt_contact', a.via_contact, 'contact');
    if (a.applied_at && a.applied_at !== 'unknown' && !/^\d{4}-\d{2}-\d{2}/.test(a.applied_at)) {
      throw new Rejected('applied_at must be an ISO date or the literal "unknown" — never a guess (JH-1).');
    }
    const id = H.nextId('APP', 'hunt_application');
    db.prepare(`INSERT INTO hunt_application (id,posting_id,resume_version_id,channel,via_contact_id,applied_at,status,status_changed_at,created_at,updated_at)
                VALUES (?,?,?,?,?,?,'submitted',?,?,?)`)
      .run(id, a.posting_id, rvId, a.channel || null, a.via_contact || null, a.applied_at || null, at, at, at);
    db.prepare("UPDATE hunt_posting SET status = 'applied', updated_at = ? WHERE id = ?").run(at, a.posting_id);
    // The touch is dated when the submission happened, not when it was typed (JH-1);
    // created_at keeps the recording time.
    const touchAt = (a.applied_at && a.applied_at !== 'unknown') ? a.applied_at : at;
    logTouch(db, touchAt, { posting_id: a.posting_id, contact_id: a.via_contact, direction: 'out', medium: a.channel === 'email' ? 'email' : 'portal', summary: `Application submitted${a.channel ? ' via ' + a.channel : ''}.` }, at);
    return V.postingView(a.posting_id);
  },
});

defineCommand({
  name: 'hunt_correct_application',
  title: 'Correct record', group: 'Jobhunt', subject: 'application', guardless: true,
  permission: 'sales.write',
  summary: 'Correct applied_at when the true date surfaces. The reason is part of the record.',
  doctrine: `A correction replaces "unknown" or a wrong date with a sourced fact — never a guess
(JH-1). Say where the date came from; the submission touch is re-dated to match.`,
  effects: ['applied_at corrected', 'submission touch re-dated'],
  args: {
    application_id: { ...f.text('The application, e.g. APP-0008.'), required: true },
    applied_at: { ...f.text('ISO date, or the literal "unknown" — never a guess (JH-1).'), required: true },
    reason: { ...f.text('Where the date came from — part of the record.'), required: true },
  },
  handler(a, { db, at }) {
    const app = H.need('hunt_application', a.application_id, 'application');
    if (a.applied_at !== 'unknown' && !/^\d{4}-\d{2}-\d{2}/.test(a.applied_at)) {
      throw new Rejected('applied_at must be an ISO date or the literal "unknown" — never a guess (JH-1).');
    }
    db.prepare('UPDATE hunt_application SET applied_at = ?, updated_at = ? WHERE id = ?').run(a.applied_at, at, a.application_id);
    // The submission touch is derived from this fact — hunt_apply wrote it — so it moves too.
    if (a.applied_at !== 'unknown') {
      db.prepare("UPDATE hunt_interaction SET at = ? WHERE posting_id = ? AND direction = 'out' AND summary LIKE 'Application submitted%'").run(a.applied_at, app.posting_id);
    }
    return { ...H.get('hunt_application', a.application_id), posting: V.postingView(app.posting_id).title };
  },
});

defineCommand({
  name: 'hunt_set_application_status',
  title: 'Move application', group: 'Jobhunt', subject: 'application',
  permission: 'sales.write',
  summary: 'Move an application along the pipeline. Logs a touch.',
  doctrine: 'Ghosted is a status, not a deletion (JH-9): silence is an outcome, and which companies go silent is pattern knowledge. Terminal states stay on the books.',
  effects: ['application status moved', 'touch logged'],
  guards: [ (app) => !['accepted', 'rejected', 'withdrawn', 'ghosted'].includes(app.status) || `${app.status} is terminal — the record stands.` ],
  args: {
    application_id: { ...f.text('The application, e.g. APP-0001.'), required: true },
    status: { ...f.pick(['submitted', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted'], ''), required: true },
    note: f.note('What actually happened.'),
  },
  handler(a, { db, at }) {
    const app = H.need('hunt_application', a.application_id, 'application');
    if (['accepted', 'rejected', 'withdrawn', 'ghosted'].includes(app.status)) throw new Rejected(`${app.status} is terminal — the record stands.`);
    db.prepare('UPDATE hunt_application SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?').run(a.status, at, at, a.application_id);
    logTouch(db, at, { posting_id: app.posting_id, direction: 'in', medium: 'other', summary: a.note || `Status → ${a.status}.` });
    return { ...H.get('hunt_application', a.application_id), posting: V.postingView(app.posting_id).title };
  },
});

defineCommand({
  name: 'hunt_add_interview',
  title: 'Add interview', group: 'Jobhunt', subject: 'application',
  permission: 'sales.write',
  summary: 'Record a scheduled round. Moves the application to interviewing.',
  doctrine: 'Rounds are facts with outcomes (JH-12). The round number defaults to the next.',
  effects: ['interview round recorded', 'application -> interviewing'],
  guards: [ (app) => !['accepted', 'rejected', 'withdrawn', 'ghosted'].includes(app.status) || `${app.status} is terminal.` ],
  args: {
    application_id: { ...f.text('The application.'), required: true },
    kind: f.pick(['recruiter_screen', 'technical', 'hiring_manager', 'panel', 'final'], ''),
    round: f.int('Defaults to the next round number.'),
    scheduled_at: f.text('ISO timestamp.'),
    interviewer: f.text('As they were introduced — a fact, not a guess (JH-1).'),
    notes: f.note(''),
  },
  handler(a, { db, at }) {
    const app = H.need('hunt_application', a.application_id, 'application');
    if (['accepted', 'rejected', 'withdrawn', 'ghosted'].includes(app.status)) throw new Rejected(`${app.status} is terminal.`);
    const round = a.round ?? ((db.prepare('SELECT MAX(round) m FROM hunt_interview WHERE application_id = ?').get(a.application_id).m || 0) + 1);
    const id = H.nextId('IV', 'hunt_interview');
    db.prepare(`INSERT INTO hunt_interview (id,application_id,round,kind,scheduled_at,interviewer,notes,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, a.application_id, round, a.kind || null, a.scheduled_at || null, a.interviewer || null, a.notes || null, at, at);
    db.prepare("UPDATE hunt_application SET status = 'interviewing', status_changed_at = ?, updated_at = ? WHERE id = ? AND status IN ('submitted','screening')").run(at, at, a.application_id);
    return { ...H.get('hunt_interview', id), application_status: H.get('hunt_application', a.application_id).status };
  },
});

defineCommand({
  name: 'hunt_interview_outcome',
  title: 'Interview outcome', group: 'Jobhunt', subject: 'application', scope: 'collection',
  permission: 'sales.write',
  summary: 'Close a round. The outcome is a touch in the history (JH-12).',
  doctrine: 'Outcomes are facts: passed, failed, rescheduled, or their no-show. Close the round when you know; the notes carry the interpretation.',
  effects: ['interview outcome set', 'touch logged'],
  args: {
    interview_id: { ...f.text('The round, e.g. IV-0001.'), required: true },
    outcome: { ...f.pick(['passed', 'failed', 'rescheduled', 'no_show_theirs'], ''), required: true },
    notes: f.note(''),
  },
  handler(a, { db, at }) {
    const iv = H.need('hunt_interview', a.interview_id, 'interview');
    db.prepare('UPDATE hunt_interview SET outcome = ?, notes = coalesce(?, notes), updated_at = ? WHERE id = ?').run(a.outcome, a.notes ?? null, at, a.interview_id);
    const app = H.get('hunt_application', iv.application_id);
    logTouch(db, at, { posting_id: app.posting_id, direction: 'in', medium: 'other', summary: `Interview round ${iv.round || ''} ${a.outcome}${a.notes ? ': ' + a.notes : '.'}` });
    return H.get('hunt_interview', a.interview_id);
  },
});
module.exports = { logTouch };
