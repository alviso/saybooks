'use strict';
/** crm read models. Generous on purpose: an agent that can see the whole account —
 *  gaps included — does not invent the parts it cannot see. */
const H = require('../../db.js');
const { db, need } = H;

function accountView(id) {
  const a = need('account', id, 'account');
  return {
    ...a,
    path_in: db().prepare('SELECT sort, bullet FROM account_path_in WHERE account_id = ? ORDER BY sort').all(id),
    contacts: db().prepare('SELECT * FROM contact WHERE account_id = ? ORDER BY id').all(id),
    gap_count: db().prepare("SELECT COUNT(*) c FROM contact WHERE account_id = ? AND status = 'gap'").get(id).c,
    activity: db().prepare('SELECT * FROM activity WHERE account_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 20').all(id),
  };
}

function contactView(id) {
  const c = need('contact', id, 'contact');
  return {
    ...c,
    account_name: H.get('account', c.account_id).name,
    activity: db().prepare('SELECT * FROM activity WHERE contact_id = ? ORDER BY occurred_at DESC LIMIT 20').all(id),
  };
}

/** Weighted where-are-we. Stage probabilities are reference data (freedom); this default
 *  maps the account lifecycle to plain numbers so the view exists from day one. */
const STAGE_P = { not_started: 0, researching: 0.05, approaching: 0.15, active: 0.4, won: 1, on_hold: 0.05, closed: 0, excluded: 0 };
const pipeline = () => db().prepare('SELECT * FROM account ORDER BY tier, name').all()
  .map(a => ({ id: a.id, name: a.name, tier: a.tier, vertical: a.vertical, status: a.status, probability: STAGE_P[a.status] ?? 0, customer_id: a.customer_id }));

/** CRM-2's worklist: what we verifiably do not know, with age. */
const gaps = () => db().prepare(`
  SELECT c.id, c.account_id, a.name AS account_name, c.role_type, c.gap_note, c.created_at,
         CAST(julianday('now') - julianday(c.created_at) AS INTEGER) AS age_days
  FROM contact c JOIN account a ON a.id = c.account_id
  WHERE c.status = 'gap' ORDER BY c.created_at`).all();

/** List health: staleness is visible, not discovered. */
function coverage() {
  const by = (col) => Object.fromEntries(db().prepare(`SELECT ${col} k, COUNT(*) c FROM account GROUP BY ${col}`).all().map(r => [r.k ?? '—', r.c]));
  return {
    accounts_by_status: by('status'),
    accounts_by_tier: by('tier'),
    open_gaps: gaps().length,
    stale_14d: db().prepare(`
      SELECT COUNT(*) c FROM account a
      WHERE a.status IN ('researching','approaching','active')
        AND NOT EXISTS (SELECT 1 FROM activity x WHERE x.account_id = a.id AND julianday('now') - julianday(x.occurred_at) <= 14)`).get().c,
  };
}

module.exports = { accountView, contactView, pipeline, gaps, coverage, STAGE_P };
