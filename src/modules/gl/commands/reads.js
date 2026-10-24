'use strict';
const { defineCommand, f } = require('../../../registry.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Month-end read', ...def });

read({ name: 'gl_checklist', title: 'Close checklist', summary: 'What blocks closing the books through a day (unreviewed statement rows, accounts that do not tie), and what is open but not blocking.',
  args: { through: { ...f.date('The last day of the period to close.'), required: true } }, handler: (a) => V.checklist(a) });
read({ name: 'gl_entries', title: 'Adjusting entries', summary: 'Adjusting entries, newest first, with their lines and any reversal.', args: {}, handler: () => V.entries() });
read({ name: 'gl_entry', title: 'Adjusting entry', summary: 'One adjusting entry with its lines.', args: { entry_id: { ...f.text('e.g. JE-0001.'), required: true } }, handler: (a) => V.entryView(a.entry_id) });
read({ name: 'gl_closes', title: 'Closes', summary: 'Every close: through when, by whom, its totals and hash, and whether the record has changed since.', args: {}, handler: () => V.closes() });
read({ name: 'gl_changes', title: 'Changes after close', summary: 'What the record now says differently about closed periods, per account, landing on the first open day.', args: {}, handler: () => V.changes() });
