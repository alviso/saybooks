'use strict';
/** crm read models. Generous on purpose: an agent that can see the whole account —
 *  gaps included — does not invent the parts it cannot see. */
const H = require('../../db.js');
const { db, need } = H;

function accountView(id) {
  const a = need('account', id, 'account');
  const camp = a.campaign_id ? H.get('campaign', a.campaign_id) : null;
  const drafts = db().prepare(`SELECT d.*, c.name AS contact_name FROM crm_draft d
    LEFT JOIN contact c ON c.id = d.contact_id WHERE d.account_id = ? ORDER BY d.id DESC`).all(id);
  return {
    ...a,
    campaign_name: camp ? camp.name : null,
    parked: !!a.parked_at,
    path_in: db().prepare('SELECT sort, bullet FROM account_path_in WHERE account_id = ? ORDER BY sort').all(id),
    contacts: db().prepare('SELECT * FROM contact WHERE account_id = ? ORDER BY id').all(id),
    gap_count: db().prepare("SELECT COUNT(*) c FROM contact WHERE account_id = ? AND status = 'gap'").get(id).c,
    activity: db().prepare('SELECT * FROM activity WHERE account_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 20').all(id),
    drafts: drafts.map(d => ({ id: d.id, contact: d.contact_name, channel: d.channel, subject: d.subject,
      status: d.status, sent_at: d.sent_at, updated_at: d.updated_at })),
    events: db().prepare(`SELECT e.*, c.name AS contact_name FROM crm_event e LEFT JOIN contact c ON c.id = e.contact_id
      WHERE e.account_id = ? ORDER BY e.date DESC, e.time DESC, e.id DESC LIMIT 30`).all(id),
    state: derivedState(id),
  };
}

/**
 * What is actually going on with this account, computed on every read and stored nowhere.
 * A stored summary drifts, and the bug it causes is specific: an account gets reported as an
 * untouched door days after somebody wrote to it, because the only record of the approach sat
 * behind a filter on another screen. Everything a person would ask before touching an account
 * comes back inline with the account (CRM-19).
 */
function derivedState(id) {
  const last = db().prepare(`SELECT occurred_at, direction, medium FROM activity
    WHERE account_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`).get(id);
  const lastIn = db().prepare(`SELECT occurred_at FROM activity
    WHERE account_id = ? AND direction = 'inbound' ORDER BY occurred_at DESC LIMIT 1`).get(id);
  const lastOut = db().prepare(`SELECT occurred_at FROM activity
    WHERE account_id = ? AND direction = 'outbound' ORDER BY occurred_at DESC LIMIT 1`).get(id);
  const written = db().prepare(`SELECT c.id, c.name, MAX(d.sent_at) AS last_sent FROM crm_draft d
    JOIN contact c ON c.id = d.contact_id
    WHERE d.account_id = ? AND d.status = 'sent' GROUP BY c.id ORDER BY last_sent DESC`).all(id);
  const waiting = db().prepare("SELECT COUNT(*) c FROM crm_draft WHERE account_id = ? AND status = 'draft'").get(id).c;
  const days = (d) => d ? Math.floor((Date.now() - Date.parse(`${d}T00:00:00Z`)) / 86400000) : null;
  const a = H.get('account', id) || {};
  return {
    parked: !!a.parked_at, parked_reason: a.parked_reason || null,
    last_touch: last ? last.occurred_at : null,
    days_since_touch: last ? days(last.occurred_at) : null,
    last_outbound: lastOut ? lastOut.occurred_at : null,
    last_inbound: lastIn ? lastIn.occurred_at : null,
    // "Did they ever answer" is the question behind a pursuit, and it is not the same
    // question as "when did we last do something".
    ever_answered: !!lastIn,
    contacts_written_to: written.map(w => ({ contact_id: w.id, name: w.name, last_sent: w.last_sent })),
    drafts_waiting: waiting,
    // The next planned thing, and anything planned that already passed without an outcome.
    next_event: db().prepare(`SELECT id, title, date, time, kind FROM crm_event WHERE account_id = ? AND status = 'planned' AND date >= date('now')
      ORDER BY date, time LIMIT 1`).get(id) || null,
    events_awaiting_outcome: db().prepare(`SELECT COUNT(*) c FROM crm_event WHERE account_id = ? AND status = 'planned' AND date < date('now')`).get(id).c,
  };
}

function contactView(id) {
  const c = need('contact', id, 'contact');
  const acc = H.get('account', c.account_id) || {};
  // Everything written to this person, in every state. A draft waiting on somebody is a fact
  // about that person, and it belongs where you look them up, not only in a queue elsewhere.
  const drafts = db().prepare(`SELECT id, status, channel, subject, body, rationale, sent_at,
      status_reason, written_by, updated_at FROM crm_draft WHERE contact_id = ? ORDER BY id DESC`).all(id);
  return {
    ...c,
    account_name: acc.name || null,
    account_status: acc.status || null,
    account_parked: !!acc.parked_at,
    activity: db().prepare('SELECT * FROM activity WHERE contact_id = ? ORDER BY occurred_at DESC LIMIT 20').all(id),
    drafts,
    drafts_waiting: drafts.filter(d => d.status === 'draft').length,
    events: db().prepare('SELECT * FROM crm_event WHERE contact_id = ? ORDER BY date DESC, id DESC LIMIT 20').all(id),
    last_sent: drafts.filter(d => d.sent_at).map(d => d.sent_at).sort().pop() || null,
  };
}

/** Weighted where-are-we. Stage probabilities are reference data (freedom); this default
 *  maps the account lifecycle to plain numbers so the view exists from day one. */
const STAGE_P = { not_started: 0, researching: 0.05, approaching: 0.15, active: 0.4, won: 1, on_hold: 0.05, closed: 0, excluded: 0 };
const pipeline = (campaignId) => db().prepare(`SELECT a.*, c.name AS campaign_name FROM account a LEFT JOIN campaign c ON c.id = a.campaign_id
    WHERE (? IS NULL OR a.campaign_id = ?) ORDER BY a.tier, a.name`).all(campaignId || null, campaignId || null)
  .map(a => ({ id: a.id, name: a.name, tier: a.tier, vertical: a.vertical, status: a.status, probability: STAGE_P[a.status] ?? 0,
    customer_id: a.customer_id, campaign_id: a.campaign_id, campaign_name: a.campaign_name, why_them: a.why_them }));

/** CRM-2's worklist: what we verifiably do not know, with age. */
const gaps = (campaignId) => db().prepare(`
  SELECT c.id, c.account_id, a.name AS account_name, a.campaign_id, c.role_type, c.gap_note, c.created_at,
         CAST(julianday('now') - julianday(c.created_at) AS INTEGER) AS age_days
  FROM contact c JOIN account a ON a.id = c.account_id
  WHERE c.status = 'gap' AND (? IS NULL OR a.campaign_id = ?) ORDER BY c.created_at`).all(campaignId || null, campaignId || null);

/** List health: staleness is visible, not discovered. */
function coverage(campaignId) {
  const cid = campaignId || null;
  const by = (col) => Object.fromEntries(db().prepare(`SELECT ${col} k, COUNT(*) c FROM account WHERE (? IS NULL OR campaign_id = ?) GROUP BY ${col}`).all(cid, cid).map(r => [r.k ?? '—', r.c]));
  return {
    accounts_by_status: by('status'),
    accounts_by_tier: by('tier'),
    open_gaps: gaps(cid).length,
    stale_14d: db().prepare(`
      SELECT COUNT(*) c FROM account a
      WHERE a.status IN ('researching','approaching','active') AND (? IS NULL OR a.campaign_id = ?)
        AND NOT EXISTS (SELECT 1 FROM activity x WHERE x.account_id = a.id AND julianday('now') - julianday(x.occurred_at) <= 14)`).get(cid, cid).c,
  };
}

function campaignView(id) {
  const c = need('campaign', id, 'campaign');
  // The claim lists come back with the campaign because an agent is told to read them before
  // drafting, and a rule kept on a screen nobody opens is a rule nobody follows (CRM-17).
  const claims = db().prepare('SELECT kind, text, note FROM campaign_claim WHERE campaign_id = ? ORDER BY kind, id').all(id);
  return { ...c, ...coverage(id),
    claims_allowed: claims.filter(x => x.kind === 'allowed').map(({ text, note }) => ({ text, note })),
    claims_refused: claims.filter(x => x.kind === 'refused').map(({ text, note }) => ({ text, note })) };
}

/** Every campaign with its goal, status, and health — the per-goal Today (spec §6). */
const campaignsView = () => db().prepare('SELECT * FROM campaign ORDER BY status = \'active\' DESC, created_at').all()
  .map(c => ({ ...c, ...coverage(c.id) }));

module.exports = { accountView, contactView, derivedState, drafts, calendar, pipeline, gaps, coverage, campaignView, campaignsView, STAGE_P };

/** Drafts on file, with the contact they are for and the account behind them. */
function drafts({ status = 'draft', account_id, contact_id, limit = 50 } = {}) {
  const where = []; const args = [];
  if (status) { where.push('d.status = ?'); args.push(status); }
  if (account_id) { where.push('d.account_id = ?'); args.push(account_id); }
  if (contact_id) { where.push('d.contact_id = ?'); args.push(contact_id); }
  const sql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const n = Math.max(1, Math.min(200, limit | 0 || 50));
  const total = db().prepare(`SELECT COUNT(*) n FROM crm_draft d${sql}`).get(...args).n;
  const rows = db().prepare(`SELECT d.*, c.name AS contact_name, c.title AS contact_title, c.email AS contact_email,
      c.phone AS contact_phone, c.linkedin_url AS contact_linkedin_url, c.linkedin_path AS contact_linkedin_path,
      c.mutual_via AS contact_mutual_via, c.status AS contact_status,
      a.name AS account_name, a.status AS account_status, a.parked_at
    FROM crm_draft d JOIN contact c ON c.id = d.contact_id JOIN account a ON a.id = d.account_id${sql}
    ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`).all(...args, n);
  return {
    drafts: rows.map(d => ({ id: d.id, status: d.status, channel: d.channel, subject: d.subject, body: d.body,
      rationale: d.rationale, account: d.account_name, account_id: d.account_id, account_status: d.account_status,
      account_parked: !!d.parked_at, contact: d.contact_name, contact_id: d.contact_id, contact_title: d.contact_title,
      contact_status: d.contact_status,
      // The reach, carried with the draft: whoever sends it should not have to go and look
      // the address up somewhere else and risk pasting the wrong one.
      contact_email: d.contact_email, contact_phone: d.contact_phone,
      contact_linkedin_url: d.contact_linkedin_url, contact_linkedin_path: d.contact_linkedin_path,
      contact_mutual_via: d.contact_mutual_via,
      sent_at: d.sent_at, status_reason: d.status_reason,
      written_by: d.written_by, updated_at: d.updated_at })),
    total_matching: total, returned: rows.length, has_more: rows.length < total,
    note: 'Nothing here has been sent by this system, which has no way to send anything. A person sends, then records it.',
  };
}

/**
 * What is coming, by day, and what already passed without anyone saying what came of it.
 * The second list is the one that matters on a Monday: a planned event whose date has gone
 * by is either done, cancelled, or forgotten, and only the third is a problem.
 */
function calendar({ from, to, account_id, status } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const start = from || today;
  const end = to || new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const where = ['e.date >= ?', 'e.date <= ?']; const args = [start, end];
  if (account_id) { where.push('e.account_id = ?'); args.push(account_id); }
  if (status) { where.push('e.status = ?'); args.push(status); }
  const sel = `SELECT e.*, a.name AS account_name, a.status AS account_status, c.name AS contact_name, c.email AS contact_email
    FROM crm_event e JOIN account a ON a.id = e.account_id LEFT JOIN contact c ON c.id = e.contact_id`;
  const rows = db().prepare(`${sel} WHERE ${where.join(' AND ')} ORDER BY e.date, e.time, e.id`).all(...args);
  const overdue = account_id ? [] : db().prepare(`${sel} WHERE e.status = 'planned' AND e.date < ? ORDER BY e.date DESC`).all(today);
  const days = [];
  for (const r of rows) {
    let d = days[days.length - 1];
    if (!d || d.date !== r.date) { d = { date: r.date, events: [] }; days.push(d); }
    d.events.push(r);
  }
  return { from: start, to: end, today, days, count: rows.length,
    awaiting_outcome: overdue,
    note: overdue.length
      ? `${overdue.length} planned event${overdue.length === 1 ? ' has' : 's have'} passed with no outcome recorded. Done, cancelled, or forgotten: only the third is a problem, and crm_update_event settles it.`
      : `${rows.length} event${rows.length === 1 ? '' : 's'} between ${start} and ${end}.` };
}

/**
 * Owner's API: the one way another module creates an account here, mirroring the way crm
 * reaches core to promote a won account (CRM-8). The gate stays the gate — why_them and
 * source_url are still mandatory and a concluded campaign still takes no new targets — so a
 * row arriving from the holding area is held to exactly what a hand-added account is held to.
 */
function createAccount(db, a, at) {
  const H2 = require('../../db.js');
  const { Rejected } = require('../../registry.js');
  const camp = H2.need('campaign', a.campaign_id, 'campaign');
  if (camp.status === 'concluded') throw new Rejected(`${camp.name} is concluded — it takes no new targets. A new pursuit is a new campaign.`);
  const why = String(a.why_them || '').trim();
  const src = String(a.source_url || '').trim();
  if (!why || !src) throw new Rejected('An account needs why_them and source_url, whoever creates it (CRM-3).');
  if (db.prepare('SELECT id FROM account WHERE campaign_id = ? AND lower(name) = lower(?)').get(a.campaign_id, a.name)) {
    throw new Rejected(`${a.name} is already on ${camp.name}'s list. Update it rather than adding a twin.`);
  }
  const id = H2.nextId('A', 'account');
  db.prepare(`INSERT INTO account (id,campaign_id,name,tier,vertical,why_them,trigger_event,hook,source_url,status,owner_note,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,'not_started',?,?,?)`)
    .run(id, a.campaign_id, a.name, a.tier || null, a.vertical || null, why, a.trigger_event || null, a.hook || null, src, a.owner_note || null, at, at);
  return { id, name: a.name, campaign_id: a.campaign_id, status: 'not_started' };
}

module.exports.createAccount = createAccount;
