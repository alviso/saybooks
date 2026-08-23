'use strict';
/** crm read models. Generous on purpose: an agent that can see the whole account —
 *  gaps included — does not invent the parts it cannot see. */
const H = require('../../db.js');
const { db, need } = H;

function accountView(id) {
  const a = need('account', id, 'account');
  const camp = a.campaign_id ? H.get('campaign', a.campaign_id) : null;
  return {
    ...a,
    campaign_name: camp ? camp.name : null,
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
  return { ...c, ...coverage(id) };
}

/** Every campaign with its goal, status, and health — the per-goal Today (spec §6). */
const campaignsView = () => db().prepare('SELECT * FROM campaign ORDER BY status = \'active\' DESC, created_at').all()
  .map(c => ({ ...c, ...coverage(c.id) }));

module.exports = { accountView, contactView, pipeline, gaps, coverage, campaignView, campaignsView, STAGE_P };
