'use strict';
/**
 * crm — relationship pursuit: a curated target list, contacts with provenance or as gaps,
 * and the bridge into trading (promotion creates a core customer, once).
 * Extracted from a production single-tenant CRM; the extraction record is specs/crm/spec.md §9.
 */
const R = require('../../registry.js');
const V = require('./views.js');
const H = require('../../db.js');

const mod = R.defineModule({
  name: 'crm', prefix: 'crm',
  tables: ['account', 'account_path_in', 'contact', 'activity'],
  ids: { account: 'A-0001', contact: 'P-0001', campaign: 'CAM-0001' },
  lifecycles: {
    account: 'not_started -> researching -> approaching -> active -> won (terminal, promotable) | on_hold (re-enterable) | closed / excluded (terminal, reasoned)',
    contact: 'gap -> named (via resolve_gap only) -> departed; never deleted',
  },
  rules: [
    'Never invent a person: a named contact requires a source. Empty beats guessed.',
    'A gap is a finding: a role with no publicly named holder is recorded as exactly that.',
    'Every account earned its place: why_them and source_url are mandatory.',
    'Relationship-graph fields are human-only, whatever the role.',
    'Won accounts promote to a core customer, once — pursuit ends where trading begins.',
  ],
  doctrine: `Campaigns first: before adding any account, read crm_campaigns and match the ask
to an existing goal — if one fits, work under it and argue its goal in every why_them. If none
fits, a new campaign needs a stated goal; derive it from what your human asked for, and confirm
the goal with them before filling the list — every account you add will be judged against it.
Never park accounts in a mismatched campaign because it was there.

This is a curated list, not a funnel: its value is that every row earned its place.
NEVER INVENT A NAME — a named contact needs a source and a confidence note; a role with no
publicly named holder is a gap row with a gap_note, and that is a finding, not a failure. You
may interpret and summarize freely in narrative fields; facts trace to sources. mutual_via,
mutual_url and linkedin_path are entered by a person, never by you — asking your human to fill
them in is correct behavior.`,
  implements: {
    area: 'crm', spec: '0.2',
    argmap: { account: 'account_id', contact: 'contact_id', campaign: 'campaign_id' },
    acts: {
      create_campaign: 'crm_create_campaign', update_campaign: 'crm_update_campaign',
      set_campaign_status: 'crm_set_campaign_status', campaigns: 'crm_campaigns',
      add_account: 'crm_add_account', update_account: 'crm_update_account',
      set_account_status: 'crm_set_account_status', set_path_in: 'crm_set_path_in',
      add_contact: 'crm_add_contact', resolve_gap: 'crm_resolve_gap', update_contact: 'crm_update_contact',
      log_activity: 'crm_log_activity', promote_to_customer: 'crm_promote_to_customer',
      account: 'crm_get_account', contact: 'crm_get_contact',
      pipeline: 'crm_pipeline', gaps: 'crm_gaps', coverage: 'crm_coverage',
    },
  },
  search: (like) => ({
    campaigns: H.db().prepare('SELECT id, name, status FROM campaign WHERE id LIKE ? OR name LIKE ? OR goal LIKE ? LIMIT 10').all(like, like, like),
    accounts: H.db().prepare(`SELECT id, name, status, tier FROM account WHERE id LIKE ? OR name LIKE ? OR why_them LIKE ? OR trigger_event LIKE ? OR hook LIKE ? OR owner_note LIKE ? LIMIT 10`).all(like, like, like, like, like, like),
    crm_contacts: H.db().prepare(`SELECT id, account_id, name, role_type, status FROM contact WHERE id LIKE ? OR name LIKE ? OR role_type LIKE ? OR title LIKE ? OR notes LIKE ? OR gap_note LIKE ? LIMIT 10`).all(like, like, like, like, like, like),
    activities: H.db().prepare('SELECT id, account_id, occurred_at, summary FROM activity WHERE summary LIKE ? LIMIT 10').all(like),
  }),
  api: { views: V },
});

R.defineSubject('account', { load: V.accountView });
R.defineSubject('campaign', { load: V.campaignView });
R.defineSubject('crm_contact', { load: V.contactView });

R.inModule(mod, () => {
  require('./commands/campaigns.js');
  require('./commands/accounts.js');
  require('./commands/contacts.js');
  require('./commands/pursuit.js');
  require('./commands/reads.js');
});

module.exports = mod.api;
