'use strict';
/**
 * jobhunt — one person's search, run as a record of reality. Extracted from huntctrl.
 * A deliberately PERSONAL area: Saybooks modules are not limited to corporate functions.
 */
const R = require('../../registry.js');
const V = require('./views.js');
const H = require('../../db.js');

const mod = R.defineModule({
  name: 'jobhunt', prefix: 'hunt',
  tables: ['hunt_company', 'hunt_contact', 'hunt_resume_version', 'hunt_posting', 'hunt_application', 'hunt_interaction', 'hunt_interview', 'hunt_config'],
  ids: { posting: 'JP-0001', application: 'APP-0001', contact: 'HC-0001', company: 'CO-0001', interview: 'IV-0001', resume_version: 'RV-0001' },
  lifecycles: {
    posting: 'lead -> evaluated -> applied | skipped (reasoned, kept)',
    application: 'submitted -> screening -> interviewing -> offer -> accepted | rejected / withdrawn / ghosted (terminal, honest)',
    interview: 'pending -> passed / failed / rescheduled / no_show_theirs',
  },
  rules: [
    'Facts come only from the JD or actual correspondence; unknown beats guessed.',
    'Duplicate warnings are surfaced, never auto-resolved — a double submission can disqualify.',
    'One application per posting; one open next action per posting.',
    'Every contact has a source. Ghosted is a status. Skips carry reasons.',
  ],
  doctrine: `A record of reality, not a workspace for guesses. Facts — names, comp, req ids,
dates — come only from the JD or actual correspondence; interpret freely in fit notes and
summaries, never invent a fact to fill a field, and pass "unknown" rather than guessing a
date. Duplicate warnings returned by hunt_add_posting must be SHOWN to your human — the same
req via four agencies is normal, and silently merging or dropping invites the double
submission that can disqualify them. Everything hunt_due surfaces is a suggestion: this
system never sends an email, never submits an application, never clicks anything.`,
  implements: {
    area: 'jobhunt', spec: '0.1',
    argmap: { posting: 'posting_id', application: 'application_id', contact: 'contact_id', interview: 'interview_id', exclude: 'exclude_posting' },
    acts: {
      add_posting: 'hunt_add_posting', update_posting: 'hunt_update_posting', evaluate_posting: 'hunt_evaluate_posting',
      apply: 'hunt_apply', set_application_status: 'hunt_set_application_status',
      add_interview: 'hunt_add_interview', interview_outcome: 'hunt_interview_outcome',
      log_interaction: 'hunt_log_interaction', complete_next_action: 'hunt_complete_next_action',
      add_contact: 'hunt_add_contact', update_contact: 'hunt_update_contact', add_resume_version: 'hunt_add_resume_version',
      due: 'hunt_due', pipeline: 'hunt_pipeline', posting: 'hunt_get_posting',
      contacts: 'hunt_contacts', resume_versions: 'hunt_resume_versions', check_duplicates: 'hunt_check_duplicates',
    },
  },
  search: (like) => ({
    postings: H.db().prepare(`SELECT p.id, p.title, p.status, c.name AS company FROM hunt_posting p JOIN hunt_company c ON c.id = p.company_id
      WHERE p.id LIKE ? OR p.title LIKE ? OR p.jd_text LIKE ? OR p.fit_notes LIKE ? OR p.skip_reason LIKE ? LIMIT 10`).all(like, like, like, like, like),
    hunt_contacts: H.db().prepare('SELECT id, name, role, relationship FROM hunt_contact WHERE id LIKE ? OR name LIKE ? OR notes LIKE ? LIMIT 10').all(like, like, like),
    hunt_companies: H.db().prepare('SELECT id, name, kind FROM hunt_company WHERE id LIKE ? OR name LIKE ? LIMIT 10').all(like, like),
  }),
  api: { views: V },
});

R.defineSubject('posting', { load: V.postingView });
R.defineSubject('application', { load: (id) => H.need('hunt_application', id, 'application') });

R.inModule(mod, () => {
  require('./commands/postings.js');
  require('./commands/applications.js');
  require('./commands/touches.js');
  require('./commands/reads.js');
});

module.exports = mod.api;
