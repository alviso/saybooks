'use strict';
const { defineCommand, f } = require('../../../registry.js');
const V = require('../views.js');

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Prospects read', ...def });

read({ name: 'pros_rows', title: 'Staged rows',
  summary: 'One page of staged rows, with an honest count of everything the filter matched.',
  doctrine: `judged=false IS THE "WHAT IS LEFT TO JUDGE" QUERY and it is usually the one you
want. It is not the same as any verdict filter: an unjudged row has no verdict at all.

BRIEF IS THE DEFAULT AND YOU ALMOST ALWAYS WANT IT. The seller's description is a marketing
paragraph; fifty of them at full length exceed the tool output cap and the call fails outright
rather than truncating. Brief cuts each to 200 characters, which decides most rows. Ask for
brief=false on the handful where the cut description genuinely is not enough, and lower the
limit when you do.

ALWAYS READ total_matching AND has_more. The page caps at 200 and the sort is total, so paging
with offset never skips or repeats a row — but a page is not the answer to "how many".`,
  args: {
    source_id: f.text('One pull, e.g. PUL-0001. Judging is a pass over one pull, not over everything staged.'),
    judged:    f.bool('false: rows with no verdict yet. true: rows already judged.'),
    verdict:   f.pick(['qualified', 'rejected', 'unclear'], 'Only rows carrying this verdict.'),
    promoted:  f.bool('false: not yet an account. true: already promoted.'),
    company:   f.text('Name contains this.'),
    limit:     f.int('Rows per page, up to 200. Default 50.'),
    offset:    f.int('Where the page starts. Default 0.'),
    brief:     f.bool('Default true. false returns the full description and provenance.'),
  },
  handler: (a) => V.rows(a) });

read({ name: 'pros_sources', title: 'Pulls',
  summary: 'Every staged pull with the brief it was made under and how far it has been judged.',
  doctrine: 'Read the criteria before judging any of its rows: a verdict is a judgement against a stated brief, not against your general sense of a good customer.',
  args: { source_id: f.text('One pull.') },
  handler: (a) => V.sources(a.source_id) });
