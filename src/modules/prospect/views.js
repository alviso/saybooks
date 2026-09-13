'use strict';
/** Reads over the holding area. Nothing here creates anything; promotion is a person's act. */
const H = require('../../db.js');

const VERDICTS = ['qualified', 'rejected', 'unclear'];

const rowBrief = (r) => ({
  id: r.id, company: r.company, industry: r.industry, employees: r.employees,
  where: [r.city, r.state, r.country].filter(Boolean).join(', ') || null,
  website: r.website,
  // The seller's blurb is a marketing paragraph. Fifty of them at full length blow the tool
  // output cap and the call fails outright, so brief mode cuts it and says it cut it.
  description: r.description && r.description.length > 200 ? `${r.description.slice(0, 200)}…` : r.description,
  verdict: r.verdict, verdict_reason: r.verdict_reason,
  account_id: r.account_id, source: r.source_id, row_index: r.row_index,
});

const rowFull = (r) => ({ ...rowBrief(r), description: r.description, raw: r.raw,
  verdict_source_url: r.verdict_source_url, verdict_by: r.verdict_by, verdict_at: r.verdict_at,
  promoted_by: r.promoted_by, promoted_at: r.promoted_at });

/**
 * One page of staged rows, and an honest count of what the filter actually matched.
 * The sort is total (employees descending, then id) so paging never skips or repeats a row —
 * a partial sort plus an offset silently loses rows and says nothing.
 */
function rows({ source_id, verdict, judged, promoted, company, limit = 50, offset = 0, brief = true } = {}) {
  const where = []; const args = [];
  if (source_id) { where.push('source_id = ?'); args.push(source_id); }
  if (verdict) { where.push('verdict = ?'); args.push(verdict); }
  if (judged === true) where.push('verdict IS NOT NULL');
  if (judged === false) where.push('verdict IS NULL');
  if (promoted === true) where.push('account_id IS NOT NULL');
  if (promoted === false) where.push('account_id IS NULL');
  if (company) { where.push('company LIKE ?'); args.push(`%${company}%`); }
  const sql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = H.db().prepare(`SELECT COUNT(*) n FROM pros_row${sql}`).get(...args).n;
  const n = Math.max(1, Math.min(200, limit | 0 || 50));
  const off = Math.max(0, offset | 0);
  const page = H.db().prepare(`SELECT * FROM pros_row${sql} ORDER BY employees DESC, id ASC LIMIT ? OFFSET ?`).all(...args, n, off);
  return {
    rows: page.map(brief === false ? rowFull : rowBrief),
    total_matching: total, returned: page.length, offset: off, limit: n,
    has_more: off + page.length < total,
    brief: brief !== false,
    note: off + page.length < total
      ? `${total} rows match; showing ${page.length} from ${off}. Page with offset=${off + page.length}.`
      : `${total} rows match; all shown.`,
  };
}

/** The batches, with how far each one has been judged. Counts, not rows. */
function sources(source_id) {
  const list = source_id
    ? [H.need('pros_source', source_id, 'pull')]
    : H.db().prepare('SELECT * FROM pros_source ORDER BY created_at DESC').all();
  const per = H.db().prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN verdict IS NULL THEN 1 ELSE 0 END) unjudged,
      SUM(CASE WHEN verdict = 'qualified' THEN 1 ELSE 0 END) qualified,
      SUM(CASE WHEN verdict = 'rejected' THEN 1 ELSE 0 END) rejected,
      SUM(CASE WHEN verdict = 'unclear' THEN 1 ELSE 0 END) unclear,
      SUM(CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END) promoted
    FROM pros_row WHERE source_id = ?`);
  return {
    pulls: list.map(s => {
      const c = per.get(s.id);
      return { id: s.id, label: s.label, criteria: s.criteria, campaign_id: s.campaign_id,
        imported: s.created_at.slice(0, 10), imported_by: s.imported_by,
        rows: c.total, unjudged: c.unjudged, qualified: c.qualified, rejected: c.rejected,
        unclear: c.unclear, promoted: c.promoted,
        awaiting_promotion: c.qualified - c.promoted,
        hash: s.hash };
    }),
    note: 'Staged rows are not accounts. They are counted in no pipeline, no coverage and no campaign until a person promotes them.',
  };
}

module.exports = { VERDICTS, rows, sources, rowBrief, rowFull };
