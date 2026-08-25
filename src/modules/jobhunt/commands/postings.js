'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const POSTING_FIELDS = {
  end_client: f.text('The real client behind an agency posting — key for the duplicate guard (JH-5). Ask for it.'),
  req_id: f.text('Requisition id exactly as printed, e.g. 151469BR.'),
  source: f.pick(['linkedin', 'email_outreach', 'scrape', 'referral', 'direct'], 'How it reached us.'),
  url: f.text('Posting URL.'),
  jd_text: f.note('Full JD text, verbatim. Feeds search and the duplicate guard.'),
  location: f.text(''),
  work_mode: f.pick(['remote', 'hybrid', 'onsite'], ''),
  comp_min: f.money('Annualized. Hourly: annualize ×2080 and say so in comp_notes (JH-11).'),
  comp_max: f.money('Annualized.'),
  comp_notes: f.text('Caveats in prose: "band decorative", "hourly $85 annualized".'),
  employment_type: f.pick(['fulltime', 'contract', 'c2h', 'unknown'], ''),
  red_flags: f.text('e.g. "no comp, no client, registered-agent address".'),
};

defineCommand({
  name: 'hunt_add_posting',
  title: 'New posting', group: 'Jobhunt', subject: 'posting', scope: 'collection',
  permission: 'sales.write',
  summary: 'Record a JD encountered. Runs the duplicate guard; its warnings ride the result.',
  doctrine: `Facts come only from the JD or actual correspondence (JH-1). The company is created
by name if new; for agency postings, get the end client — the guard keys on it, and the same
req arriving through four agencies is normal (JH-3). The warnings in the result are for a
PERSON to act on: never silently merge, never quietly drop — a double submission can
disqualify the candidate.`,
  effects: ['posting created as lead', 'duplicate warnings surfaced in the result'],
  args: {
    title: { ...f.text('Role title as posted.'), required: true },
    company: { ...f.text('Hiring company or agency as presented. Created if new.'), required: true },
    company_kind: f.pick(['end_client', 'consultancy', 'staffing_agency', 'product_vendor', 'rpo'], 'Kind, for a newly created company.'),
    ...POSTING_FIELDS,
  },
  handler(a, { db, at }) {
    const company = V.ensureCompany(db, a.company, a.company_kind, at);
    const endClient = a.end_client ? V.ensureCompany(db, a.end_client, 'end_client', at) : null;
    const warnings = V.duplicateWarnings({ title: a.title, end_client_id: endClient && endClient.id, company_id: company.id, req_id: a.req_id, url: a.url });
    const id = H.nextId('JP', 'hunt_posting');
    db.prepare(`INSERT INTO hunt_posting (id,title,company_id,end_client_id,req_id,source,url,jd_text,location,work_mode,comp_min,comp_max,comp_notes,employment_type,red_flags,status,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'lead',?,?)`)
      .run(id, a.title, company.id, endClient ? endClient.id : null, a.req_id || null, a.source || null, a.url || null,
           a.jd_text || null, a.location || null, a.work_mode || null, a.comp_min || null, a.comp_max || null,
           a.comp_notes || null, a.employment_type || null, a.red_flags || null, at, at);
    return { ...V.postingView(id), warnings, warning_count: warnings.length };
  },
});

defineCommand({
  name: 'hunt_update_posting',
  title: 'Update posting', group: 'Jobhunt', subject: 'posting',
  permission: 'sales.write', guardless: true,
  summary: 'Patch a posting. Only the fields you pass change.',
  doctrine: 'Corrections from real sources only (JH-1). Setting the end client late is common and good — it comes off the due list (JH-5).',
  effects: ['posting updated'],
  args: {
    posting_id: { ...f.text('The posting, e.g. JP-0001.'), required: true },
    title: f.text(''), end_client: f.text('Sets/creates the end client.'), ...POSTING_FIELDS,
  },
  handler(a, { db, at }) {
    H.need('hunt_posting', a.posting_id, 'posting');
    if (a.end_client !== undefined && a.end_client !== '') {
      const ec = V.ensureCompany(db, a.end_client, 'end_client', at);
      db.prepare('UPDATE hunt_posting SET end_client_id = ?, updated_at = ? WHERE id = ?').run(ec.id, at, a.posting_id);
    }
    const fields = ['title', 'req_id', 'source', 'url', 'jd_text', 'location', 'work_mode', 'comp_min', 'comp_max', 'comp_notes', 'employment_type', 'red_flags'];
    for (const k of fields) if (a[k] !== undefined) db.prepare(`UPDATE hunt_posting SET ${k} = ?, updated_at = ? WHERE id = ?`).run(a[k] === '' ? null : a[k], at, a.posting_id);
    return V.postingView(a.posting_id);
  },
});

defineCommand({
  name: 'hunt_evaluate_posting',
  title: 'Evaluate', group: 'Jobhunt', subject: 'posting',
  permission: 'sales.write',
  summary: 'Record the evaluation — or the skip, with its reason.',
  doctrine: 'Skips are pattern memory (JH-8): a skip_reason is required to skip, and skipped postings stay queryable — which agencies waste your time is knowledge.',
  effects: ['posting -> evaluated, or skipped with reason'],
  guards: [ (p) => p.status !== 'applied' || 'Already applied — evaluation happened; log interactions instead.' ],
  args: {
    posting_id: { ...f.text('The posting.'), required: true },
    fit_score: { type: 'number', description: '1–5; halves are fine.', ui: { widget: 'number' } },
    fit_notes: f.note('Gap/strength summary — interpretation is free here (JH-1).'),
    resume_version: f.text('Recommended version, by label.'),
    red_flags: f.text(''),
    skip_reason: f.note('Set this to skip. The reason is the value.'),
  },
  handler(a, { db, at }) {
    const p = H.need('hunt_posting', a.posting_id, 'posting');
    if (p.status === 'applied') throw new Rejected('Already applied — evaluation happened; log interactions instead.');
    let rvId = null;
    if (a.resume_version) {
      const rv = db.prepare('SELECT id FROM hunt_resume_version WHERE label = ? OR id = ?').get(a.resume_version, a.resume_version);
      if (!rv) throw new Rejected(`No resume version "${a.resume_version}" — register it first (JH-10).`);
      rvId = rv.id;
    }
    db.prepare(`UPDATE hunt_posting SET status = ?, fit_score = coalesce(?, fit_score), fit_notes = coalesce(?, fit_notes),
                resume_version_id = coalesce(?, resume_version_id), red_flags = coalesce(?, red_flags), skip_reason = ?, updated_at = ? WHERE id = ?`)
      .run(a.skip_reason ? 'skipped' : 'evaluated', a.fit_score ?? null, a.fit_notes ?? null, rvId, a.red_flags ?? null, a.skip_reason || null, at, a.posting_id);
    return V.postingView(a.posting_id);
  },
});
