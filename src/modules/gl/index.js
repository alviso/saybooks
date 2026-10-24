'use strict';
/**
 * gl — closing the books. Adjusting entries (accruals that reverse, depreciation, corrections),
 * a checklist of what blocks a close, closing a period so its journal stops moving, and the
 * corrections that carry later changes into the first open period. Core's journal asks this
 * area's closedBooks() which periods are closed and puts them back as they were kept.
 */
const R = require('../../registry.js');
const V = require('./views.js');

const mod = R.defineModule({
  name: 'gl', prefix: 'gl',
  tables: ['gl_entry', 'gl_entry_line', 'gl_close', 'gl_closed_entry'],
  ids: { entry: 'JE-0001', close: 'CL-0001' },
  lifecycles: {
    entry: 'posted (balanced, reasoned, dated in an open period; an accrual reverses on the 1st of the next month) -> voided (reasoned, open period only)',
    close: 'closed by a person through a day, its journal kept -> reopened (the latest only, by a person, reasoned)',
  },
  rules: [
    'Closing and reopening the books are a person\'s acts, with a reason.',
    'A closed period\'s journal is what it was at close; later changes land as corrections on the first open day.',
    'Adjusting entries balance, carry a reason, say what kind each account is, and are dated in an open period.',
    'A close is refused while statement rows in the period are unreviewed or an account does not tie.',
  ],
  doctrine: `Month-end: closing the books. Before a close, read gl_checklist for the last day of the period:
it lists what blocks the close (statement rows not reviewed, accounts that do not tie) and what is
open. Help the person clear the blocking items. Adjusting entries (gl_record_entry) are for figures
the accountant or the person gives you: accruals (mark reverse: true), depreciation, corrections;
each balanced, with a reason, each line saying what kind of account it is. Closing and reopening are
the person's acts in the app, never yours. After a close, a change to a closed period is not refused:
it lands as a correction on the first open day (gl_changes), and the closed period stays as it was.`,
  implements: {
    area: 'gl', spec: '0.1',
    argmap: { entry: 'entry_id' },
    acts: {
      record_entry: 'gl_record_entry', void_entry: 'gl_void_entry', close_period: 'gl_close_period', reopen_period: 'gl_reopen_period',
      checklist: 'gl_checklist', entries: 'gl_entries', closes: 'gl_closes', changes: 'gl_changes',
    },
  },
  api: { views: V, journalLines: V.journalLines, closedBooks: V.closedBooks },
});

R.defineSubject('gl_entry', { load: (id) => V.entryView(id) });
R.defineSubject('gl_close', { load: (id) => require('../../db.js').need('gl_close', id, 'close') });

R.inModule(mod, () => {
  require('./commands/close.js');
  require('./commands/reads.js');
});

module.exports = mod;
