'use strict';
const { defineCommand, f } = require('../../../registry.js');
const H = require('../../../db.js');
const CFG = require('../../../config.js');
const wsp = require('../../../workspace.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Ledger read', ...def });

read({
  name: 'bridge_accounts',
  title: 'Account map',
  summary: 'Our fixed derivation accounts, which ones the books use, and what each is called in the ledger of record.',
  doctrine: 'Read this before any export. Anything in use and unmapped is a question for the person or their accountant, never a guess.',
  args: {},
  handler: () => V.accountsView(),
});

read({
  name: 'bridge_preview',
  title: 'Preview the hand-over',
  summary: 'The journal for a period in the ledger\'s shape, with control totals and anything still unmapped. Records nothing.',
  doctrine: 'Show the person the totals and the first rows before bridge_export. Omitting "from" previews what has not been handed over yet in that format.',
  args: {
    format: { ...f.pick(Object.keys(V.FORMATS), 'Which ledger shape.'), required: true },
    to: { ...f.date('Up to and including this date.'), required: true },
    from: f.date('From this date. Omit to continue from the last hand-over in this format.'),
    currency: f.text('Only this currency (ISO 4217). A period with more than one must be handed over a currency at a time.'),
    rows: f.int('How many sample rows to show. Default 12.'),
  },
  handler: (a) => {
    const last = V.lastThrough(a.format);
    const from = a.from || (last ? H.addDays(last, 1) : null);
    if (from && from > a.to) {
      return { format: a.format, label: V.FORMATS[a.format].label, continues_from: last, period_from: from, period_to: a.to,
        entry_count: 0, line_count: 0, ready: false, unmapped: [], currencies: [], columns: V.FORMATS[a.format].columns, sample_rows: [],
        debits_display: H.money(0), credits_display: H.money(0),
        next: `Nothing left to hand over: ${a.format} is exported through ${last}, which is already past ${a.to}. Pick a later date, or set "from" to send a period again.` };
    }
    const { journal, missing, f: fmt, rows, content } = V.build(a.format, from, a.to, a.currency);
    const n = a.rows ?? 12;
    return {
      format: a.format, label: fmt.label, note: fmt.note, continues_from: last || null,
      period_from: from || null, period_to: a.to, currencies: journal.currencies, currency: a.currency || null,
      entry_count: journal.entry_count, line_count: rows.length, balanced: journal.balanced,
      debits_display: journal.debits_display, credits_display: journal.credits_display,
      unmapped: missing, left_out: V.omitted(from, a.to),
      ready: !missing.length && journal.entry_count > 0 && journal.currencies.length <= 1,
      columns: fmt.columns, sample_rows: rows.slice(0, n), truncated: rows.length > n,
      bytes: Buffer.byteLength(content),
      next: V.omitted(from, a.to).count ? V.omitted(from, a.to).note
        : journal.currencies.length > 1 ? `This period holds ${journal.currencies.join(' and ')} — hand over one currency at a time (pass currency).`
        : missing.length ? `Map ${missing.join(', ')} with bridge_map_account, then preview again.`
        : journal.entry_count ? 'Looks right? bridge_export records the hand-over and returns a download link.'
        : `Nothing happened in the books between ${from || 'the beginning'} and ${a.to}.`,
    };
  },
});

read({
  name: 'bridge_exports',
  title: 'Hand-overs',
  summary: 'What has been handed to the ledger, in which shape, through when — with the totals and the file that went out.',
  doctrine: 'The answer to "did the ledger get August?". Each row keeps its control totals and a hash of the exact file; the link re-downloads that file, not a fresh derivation.',
  args: {},
  handler: () => {
    const v = V.exportsView();
    return { ...v, exports: v.exports.map(r => ({ ...r, csv_url: CFG.absolute(`/journal/${wsp.currentName()}/${r.token}.csv`) })) };
  },
});
