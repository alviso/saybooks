'use strict';
const { defineCommand, f, nextActions } = require('../../../registry.js');
const V = require('../views.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'CRM read', ...def });

read({ name: 'crm_get_account', title: 'Account', summary: 'Full account: narrative with sources, path-in plan, contacts including gaps, recent activity, and what can be done next.',
  args: { account_id: { ...f.ref('account', 'The account.'), required: true } },
  handler: (a) => ({ ...V.accountView(a.account_id), next_actions: nextActions('account', a.account_id).actions }) });

read({ name: 'crm_get_contact', title: 'Contact', summary: 'One person: identity, provenance, gap state, the activity that touched them.',
  args: { contact_id: { ...f.text('The contact, e.g. P-0001.'), required: true } },
  handler: (a) => V.contactView(a.contact_id) });

read({ name: 'crm_pipeline', title: 'Pipeline', summary: 'Accounts by status and tier with stage probabilities — the weighted where-are-we view. Filter by campaign or see everything.',
  args: { campaign_id: f.ref('campaign', 'Only this campaign.') }, handler: (a) => V.pipeline(a.campaign_id) });

read({ name: 'crm_get_campaign', title: 'Campaign', summary: 'One campaign: goal, status, and health.',
  args: { campaign_id: { ...f.ref('campaign', 'The campaign.'), required: true } },
  handler: (a) => V.campaignView(a.campaign_id) });

read({ name: 'crm_campaigns', title: 'Campaigns', summary: 'Every campaign with its goal, status, and health: accounts by status, open gaps, staleness — the per-goal Today.',
  doctrine: 'Read the goal before adding accounts to a campaign — every why_them argues against it (CRM-13).',
  args: {}, handler: () => V.campaignsView() });

read({ name: 'crm_gaps', title: 'Gaps', summary: 'Every unresolved gap with its note and age — what we verifiably do not know, as a worklist.',
  doctrine: 'This view existing is the point of CRM-2: the unknowns are work items, not blank cells nobody looks at.',
  args: { campaign_id: f.ref('campaign', 'Only this campaign.') }, handler: (a) => V.gaps(a.campaign_id) });

read({ name: 'crm_coverage', title: 'Coverage', summary: 'List health: accounts by status and tier, open gaps, and accounts going stale (no activity in 14 days).',
  args: { campaign_id: f.ref('campaign', 'Only this campaign.') }, handler: (a) => V.coverage(a.campaign_id) });

// Extension reads (beyond the spec's act surface — allowed, own prefix, still read-only).
read({ name: 'crm_today', title: 'Today', summary: 'The CRM work queue: open gaps, accounts going stale, and what happened lately.',
  doctrine: 'Three lists, one question: what deserves attention today. Gaps are research work; stale active accounts are follow-up work; recent activity is context.',
  args: {},
  handler: () => {
    const H2 = require('../../../db.js');
    return {
      open_gaps: V.gaps(),
      stale_accounts: H2.db().prepare(`
        SELECT a.id, a.name, a.status, a.tier,
               (SELECT MAX(occurred_at) FROM activity x WHERE x.account_id = a.id) AS last_activity
        FROM account a
        WHERE a.status IN ('researching','approaching','active')
          AND NOT EXISTS (SELECT 1 FROM activity x WHERE x.account_id = a.id AND julianday('now') - julianday(x.occurred_at) <= 14)
        ORDER BY a.tier, a.name`).all(),
      recent_activity: H2.db().prepare(`
        SELECT x.*, a.name AS account_name, c.name AS contact_name
        FROM activity x JOIN account a ON a.id = x.account_id LEFT JOIN contact c ON c.id = x.contact_id
        ORDER BY x.occurred_at DESC, x.id DESC LIMIT 50`).all(),
    };
  } });

read({ name: 'crm_list_contacts', title: 'Contacts', summary: 'Every contact across accounts — named and gaps — with provenance and the human-entered network fields.',
  args: { status: f.pick(['named', 'gap', 'departed'], 'Filter by state.') },
  handler: (a) => {
    const H2 = require('../../../db.js');
    return H2.db().prepare(`
      SELECT c.*, acc.name AS account_name FROM contact c JOIN account acc ON acc.id = c.account_id
      WHERE (? IS NULL OR c.status = ?) ORDER BY acc.name, c.id`).all(a.status || null, a.status || null);
  } });
