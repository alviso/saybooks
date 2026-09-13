'use strict';
/**
 * prospect — the holding area in front of a curated list. Rows arrive in batches from a pull
 * somebody bought or scraped. They are NOT accounts: they appear in no pipeline, no coverage
 * and no campaign, and an agent cannot turn one into an account however senior its role.
 *
 * The split is the whole design. Staging and judging are cheap and reversible, so an agent
 * does them. Promotion is the act that puts a row into the asset, so a person does it.
 * Extracted from a production single-tenant CRM; see specs/prospect/spec.md §6.
 */
const R = require('../../registry.js');
const V = require('./views.js');
const H = require('../../db.js');

const mod = R.defineModule({
  name: 'prospect', prefix: 'pros',
  tables: ['pros_source', 'pros_row'],
  ids: { pros_source: 'PUL-0001' },
  lifecycles: {
    pros_source: 'staged whole (the same hash never twice) — immutable; discarded and re-staged rather than edited',
    pros_row: 'staged -> judged (qualified | rejected | unclear, with a reason) -> promoted to an account by a PERSON, once',
  },
  rules: [
    'A staged row is not an account and is counted in no statistic until a person promotes it.',
    'Every pull records the brief it was made under; verdicts are judged against that brief.',
    'A verdict carries a reason a person can overrule, or it is refused.',
    'Only a person promotes. The act is refused to agents whatever their role.',
    'Rows are never edited: a wrong pull is discarded and handed over again.',
  ],
  doctrine: `AGENT FIRST, AND THEN A DOOR YOU CANNOT OPEN. You read the pulled file and hand
over its rows; you read each row and say what you think of it; a person decides which become
accounts. pros_promote is refused to you, and that is not a permissions accident.

Staging (pros_import_rows): hand over the seller's own text, not your summary of it, and write
the criteria the pull was actually made under. A pull with no stated brief cannot have its
verdicts checked against anything later.

Judging (pros_qualify): read the pull's criteria first with pros_sources. Then read rows with
pros_rows(source_id=..., judged=false) — that is the "what is left" query. Form a view on each
and send them together: one metro is one pass of judgement, not fifty round trips. The reason
on every verdict is the product; it is read by the person deciding whether to overrule you and
by somebody months later asking why a company was dropped. "unclear" is a real answer and a
better one than a confident guess, because nobody ever audits the companies that were dropped.

An industry label is not evidence. It covers two different businesses more often than not.
Read the description and the site.`,
  implements: {
    area: 'prospect', spec: '0.1',
    argmap: { pros_source: 'source_id', campaign: 'campaign_id' },
    acts: {
      import_rows: 'pros_import_rows', qualify: 'pros_qualify', promote: 'pros_promote',
      discard_pull: 'pros_discard_pull', rows: 'pros_rows', pulls: 'pros_sources',
    },
  },
  search: (like) => ({
    staged_rows: H.db().prepare(`SELECT id, company, industry, verdict, account_id FROM pros_row
      WHERE company LIKE ? OR industry LIKE ? OR description LIKE ? OR verdict_reason LIKE ? LIMIT 10`).all(like, like, like, like),
    pulls: H.db().prepare('SELECT id, label, criteria FROM pros_source WHERE id LIKE ? OR label LIKE ? OR criteria LIKE ? LIMIT 10').all(like, like, like),
  }),
  api: { views: V },
});

R.defineSubject('pros_source', { load: (id) => V.sources(id) });

R.inModule(mod, () => {
  require('./commands/staging.js');
  require('./commands/reads.js');
});

module.exports = mod.api;
