'use strict';
const { defineCommand, f } = require('../../../registry.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Jobhunt read', ...def });

read({ name: 'hunt_due', title: 'Due', summary: 'What needs attention: overdue and upcoming next actions, follow-up nudges, suggest-ghosted, stale leads, missing end clients, upcoming interviews.',
  doctrine: 'Everything here is a suggestion (JH-7). The system never sends, submits, or clicks — it records and reports.',
  args: { horizon_days: f.int('Default 7.') },
  handler: (a) => V.due(a.horizon_days ?? 7) });

read({ name: 'hunt_pipeline', title: 'Pipeline', summary: 'The board: every non-terminal item with stage, last touch, open next action.',
  args: { status: f.text('Filter to one stage; "skipped" shows the skip list (pattern memory, JH-8).') },
  handler: (a) => V.pipeline(a.status) });

read({ name: 'hunt_get_posting', title: 'Posting', summary: 'One posting whole: facts, evaluation, application, interviews, touch history, open next action.',
  args: { posting_id: { ...f.text('e.g. JP-0001.'), required: true } },
  handler: (a) => V.postingView(a.posting_id) });

read({ name: 'hunt_get_contact', title: 'Contact', summary: 'One person whole: identity, provenance, relationship, the postings they touch, full touch history.',
  args: { contact_id: { ...f.text('e.g. HC-0001.'), required: true } },
  handler: (a) => V.contactView(a.contact_id) });

read({ name: 'hunt_get_resume', title: 'Resume version', summary: 'One resume version: what it says, every application it went out on, and the postings it is earmarked for.',
  args: { resume_id: { ...f.text('e.g. RV-0001.'), required: true } },
  handler: (a) => V.resumeView(a.resume_id) });

read({ name: 'hunt_contacts', title: 'Contacts', summary: 'People with relationship, source, and last touch.',
  args: { relationship: f.pick(['cold', 'contacted', 'responsive', 'warm_scout', 'dead'], '') },
  handler: (a) => V.contacts(a.relationship) });

read({ name: 'hunt_resume_versions', title: 'Resume versions', summary: 'The registry, with how many applications each version went out on.',
  args: {}, handler: () => V.resumeVersions() });

read({ name: 'hunt_check_duplicates', title: 'Check duplicates', summary: 'The duplicate guard as a pure read: check a JD before adding it. Records nothing.',
  doctrine: 'Warnings are for a person to weigh (JH-3). The same req via several agencies is normal; the double submission is the disqualifier.',
  args: {
    title: { ...f.text('Role title.'), required: true },
    end_client: f.text('Who the work is for.'),
    company: f.text('The hiring company or agency — for a direct posting the guard falls back to it as the end client.'),
    req_id: f.text(''), url: f.text(''),
    exclude_posting: f.text('Posting id to ignore when re-checking.'),
  },
  handler: (a) => {
    const H2 = require('../../../db.js');
    const byName2 = (n) => n ? H2.db().prepare('SELECT id FROM hunt_company WHERE lower(name) = lower(?)').get(n) : null;
    const ec = byName2(a.end_client), co = byName2(a.company);
    const warnings = V.duplicateWarnings({ title: a.title, end_client_id: ec && ec.id, company_id: co && co.id, req_id: a.req_id, url: a.url, exclude_id: a.exclude_posting });
    return { warnings, warning_count: warnings.length };
  } });
