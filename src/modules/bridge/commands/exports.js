'use strict';
const crypto = require('crypto');
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const CFG = require('../../../config.js');
const wsp = require('../../../workspace.js');
const V = require('../views.js');

const FORMATS = Object.keys(V.FORMATS);

defineCommand({
  name: 'bridge_export',
  permission: 'billing.write',
  title: 'Export to the ledger', group: 'Ledger', subject: 'bridge_export', scope: 'collection',
  summary: 'Hand the period over: build the file in the ledger\'s shape, record what went out, and return a download link.',
  doctrine: `Show the person bridge_preview and its totals first; this is the act that says the
period has been handed over. Omit "from" to continue from the last hand-over in this format —
month-end becomes a diff, not a re-key. Refused while an account the period uses is unmapped,
naming which. Hand over the returned link; never relay the file's bytes. The file is kept
exactly as it went out, with its control totals and a hash, so a later question about what the
ledger received has an answer.`,
  effects: ['journal file built for the period', 'hand-over recorded with its control totals', 'download link minted'],
  args: {
    format: { ...f.pick(FORMATS, 'Which ledger shape.'), required: true },
    to: { ...f.date('Hand over everything on or before this date.'), required: true },
    from: f.date('Start of the period. Omit to continue from the last hand-over in this format.'),
    currency: f.text('Which currency to hand over (ISO 4217). Required when the period holds more than one: a ledger takes one currency at a time.'),
    reason: f.text('Why — "August close", "first hand-over to their Xero".'),
  },
  handler(a, { db, at, actor }) {
    if (!V.FORMATS[a.format]) throw new Rejected(`Unknown format ${a.format}. Available: ${FORMATS.join(', ')}.`);
    const last = V.lastThrough(a.format);
    const from = a.from || (last ? H.addDays(last, 1) : null);
    if (from && from > a.to) throw new Rejected(`Nothing to hand over: ${a.format} is already exported through ${last}, which is after ${a.to}.`);
    const scan = require('../../core/index.js').journal({ from, to: a.to });
    if (!a.currency && scan.currencies.length > 1) {
      throw new Rejected(`This period holds ${scan.currencies.join(' and ')} (${scan.currencies.map(c => `${scan.by_currency[c].entries} entries in ${c}`).join(', ')}). A ledger takes one currency at a time: export each separately with currency set.`);
    }
    const { journal, missing, f: fmt, rows, content } = V.build(a.format, from, a.to, a.currency);
    if (missing.length) {
      throw new Rejected(`${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no ${fmt.needs === 'code' ? 'account code' : 'account name'} in your mapping, and ${fmt.label} matches on it. Ask the accountant for ${missing.length > 1 ? 'those accounts' : 'that account'} and write ${missing.length > 1 ? 'them' : 'it'} with bridge_map_account, then export again.`);
    }
    if (!journal.entry_count) throw new Rejected(`Nothing happened in the books between ${from || 'the beginning'} and ${a.to}, so there is nothing to hand over.`);
    if (!journal.balanced) throw new Rejected(`The derivation does not balance for this period (${journal.debits_display} against ${journal.credits_display}) — that is a bug, not a mapping problem. Nothing was exported.`);
    const prior = db.prepare('SELECT id, line_count, debits FROM bridge_export WHERE format = ? AND period_to >= ? AND (period_from IS NULL OR period_from <= ?) ORDER BY id DESC LIMIT 1').get(a.format, from || a.to, a.to);
    const id = H.nextId('EXP', 'bridge_export');
    const token = crypto.randomBytes(12).toString('hex');
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    db.prepare(`INSERT INTO bridge_export (id,format,period_from,period_to,entry_count,line_count,debits,credits,content,hash,token,actor,reason,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, a.format, from || null, a.to, journal.entry_count, rows.length, journal.debits, journal.credits, content, hash, token, actor || 'unknown', a.reason || null, at);
    const path = `/journal/${wsp.currentName()}/${token}.csv`;
    const url = CFG.absolute(path);
    return { _attachments: [{ kind: 'file', mime: 'text/csv', name: `saybooks-${a.format}-${id}.csv`, uri: url || `saybooks:/${path}`,
      description: `${fmt.label} · ${journal.entry_count} entries, ${rows.length} lines, ${journal.debits_display} each side. The file exactly as handed over.` }],
      id, format: a.format, label: fmt.label, currency: journal.currencies[0] || null, period_from: from || null, period_to: a.to,
      entry_count: journal.entry_count, line_count: rows.length, debits_display: journal.debits_display, credits_display: journal.credits_display, hash,
      csv_path: path, csv_url: CFG.absolute(path), continues_from: last || null,
      re_export_of: prior ? { export: prior.id, lines_then: prior.line_count, lines_now: rows.length, changed: prior.line_count !== rows.length || prior.debits !== journal.debits } : null,
      note: `${journal.entry_count} entries, ${rows.length} lines, ${journal.debits_display} each side. Hand over this link: ${CFG.absolute(path) || path}${prior ? ` — note this period overlaps ${prior.id}, already handed over${prior.line_count !== rows.length || prior.debits !== journal.debits ? ' (and the numbers have changed since)' : ' (unchanged since)'}.` : ''}` };
  },
});
