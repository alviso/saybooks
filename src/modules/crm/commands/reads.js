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

read({ name: 'crm_pipeline', title: 'Pipeline', summary: 'Accounts by status and tier with stage probabilities — the weighted where-are-we view.',
  args: {}, handler: () => V.pipeline() });

read({ name: 'crm_gaps', title: 'Gaps', summary: 'Every unresolved gap with its note and age — what we verifiably do not know, as a worklist.',
  doctrine: 'This view existing is the point of CRM-2: the unknowns are work items, not blank cells nobody looks at.',
  args: {}, handler: () => V.gaps() });

read({ name: 'crm_coverage', title: 'Coverage', summary: 'List health: accounts by status and tier, open gaps, and accounts going stale (no activity in 14 days).',
  args: {}, handler: () => V.coverage() });
