'use strict';
/**
 * bridge — the hand-over to the ledger of record.
 *
 * Saybooks owns operational truth and derives balanced journal lines from it. QuickBooks
 * Online, Xero or the accountant's own system owns the chart of accounts, the manual
 * journals, the adjustments and the close. This module is how the first feeds the second:
 * a mapping from our fixed derivation accounts onto their real chart, the file in the shape
 * their import wants, and a record of what was handed over and through when.
 *
 * We never compete with the ledger. We make it better fed than it has ever been.
 */
const R = require('../../registry.js');
const V = require('./views.js');
const H = require('../../db.js');

const mod = R.defineModule({
  name: 'bridge', prefix: 'bridge',
  tables: ['bridge_account_map', 'bridge_export'],
  ids: { export: 'EXP-0001' },
  lifecycles: {
    account_map: 'unmapped -> mapped to their chart (code, name, tax rate) — config, changed by an act, logged',
    export: 'built for a period and handed over (immutable: the file is kept exactly as it went out)',
  },
  rules: [
    'The journal is a derivation, never a posting: an export reads it and changes nothing.',
    'An export is refused while an account the period uses has no mapping the chosen format needs.',
    'Every export records its period, its control totals and a hash of the file that went out.',
    'Re-exporting a period is allowed and always visible: the result says what changed since the last hand-over.',
  ],
  doctrine: `The ledger of record stays wherever it is. Your job is to hand it clean, balanced
journal lines and to be honest about what has already gone over.

Order of work: bridge_accounts first — it lists our fixed derivation accounts, which ones the
books actually use, and whether each is mapped. Ask the person (or their accountant) for the
chart codes and names, one account at a time, and write them with bridge_map_account. Never
invent an account code.

Then bridge_preview for the period, in the format the ledger wants (xero, qbo, csv). It shows
the entries, the control totals and anything still unmapped. When the person is happy,
bridge_export records the hand-over and returns a download link — hand over the link, never
the file's bytes. Omit "from" and the export continues from the last hand-over in that
format, so month-end is a diff rather than a re-key.

Nothing here posts to the ledger. A correction after an export is a fresh export of the
affected period; the record shows both, with what changed.`,
  implements: {
    area: 'bridge', spec: '0.1',
    argmap: { export: 'export_id' },
    acts: {
      map_account: 'bridge_map_account', export: 'bridge_export',
      accounts: 'bridge_accounts', preview: 'bridge_preview', exports: 'bridge_exports',
    },
  },
  api: { views: V },
});

R.defineSubject('bridge_export', { load: (id) => H.need('bridge_export', id, 'export') });

R.inModule(mod, () => {
  require('./commands/map.js');
  require('./commands/exports.js');
  require('./commands/reads.js');
});

module.exports = mod;
