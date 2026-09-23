'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

// The statement as pasted, read here instead of retyped by the model. A model that cannot retype
// twenty rows without a slip can still hand over the lines it was given, unchanged; the same
// control totals gate the batch either way. Conservative on purpose: a line that starts with a
// date and cannot be read is refused by line number, never guessed. Lines without a date at the
// start (headers, footers, blank) are ignored, and the row count then catches a row lost that way.
const DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.\d{1,2}\.\d{4})\b/;
function isoDate(d) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/.exec(d); if (!m) return null;
  let [, a, b, y] = m; a = +a; b = +b;
  const [mm, dd] = a > 12 ? [b, a] : [a, b];          // 13/09/2026 can only be day-first
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
function parseMoney(s) {
  let t = String(s).trim().replace(/^[A-Z]{3}\s*|\s*[A-Z]{3}$/g, '').replace(/\s+/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
  if (/^[-+]/.test(t)) { neg = t[0] === '-'; t = t.slice(1); }
  t = t.replace(/^\$/, '');
  if (/^[-+]/.test(t)) { neg = neg || t[0] === '-'; t = t.slice(1); }   // "$-89.12"
  const m = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(t); if (!m) return null;
  const cents = Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] || '0').padEnd(2, '0'));
  return neg ? -cents : cents;
}
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t').map(x => x.trim());
  if (/\S {2,}\S/.test(line)) return line.split(/ {2,}/).map(x => x.trim());
  const out = []; let cur = ''; let q = false;                  // CSV with quoted fields
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  out.push(cur.trim()); return out;
}
function parseStatementText(text) {
  const rows = [];
  String(text).split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim(); if (!line || !DATE_RE.test(line)) return;
    const parts = splitLine(line);
    const bad = () => new Rejected(`Line ${n + 1} starts with a date but could not be read as a row (date, description, amount): "${line.slice(0, 80)}". Fix the line or hand the rows over as fields.`);
    if (parts.length < 3) throw bad();
    const date = isoDate(parts[0]); if (!date) throw bad();
    // An unquoted "$1,800.00" in a CSV arrives as two fields. The amount is the longest run of
    // trailing fields that reads as one money value; the description is what is left.
    let amount = null, k = 0;
    for (let j = 1; j <= 3 && j < parts.length - 1; j++) { const v = parseMoney(parts.slice(-j).join(',')); if (v !== null) { amount = v; k = j; } }
    if (amount === null) throw bad();
    const description = parts.slice(1, -k).join(' ').replace(/^"|"$/g, '').trim(); if (!description) throw bad();
    rows.push({ row_index: rows.length + 1, date, amount, description, raw: line });
  });
  return rows;
}

const ROW = {
  date: { ...f.date('The row\'s date.'), required: true },
  amount: { ...f.money('Signed: spending NEGATIVE, money in POSITIVE.'), required: true },
  description: { ...f.text('The line as the statement prints it (the merchant or payee text). Every row has one.'), required: true },
  counterparty: f.text('Only when the statement names a payee separately from the printed line. Usually left out.'),
  row_index: f.int('Position in the statement, from 1. Defaults to the order you hand the rows in.'),
  raw: f.text('The line as you read it, verbatim. Provenance.'),
};

defineCommand({
  name: 'purch_import_statement',
  permission: 'cash.write',
  title: 'Import statement', group: 'Purchases', subject: 'purch_source', scope: 'collection',
  summary: 'Hand over one statement you read: its rows and the control totals it prints. Accepted whole, or refused with the gap named.',
  doctrine: `You read the file; this records it. State the opening balance, closing balance and
row count the statement PRINTS, then the rows: either every row as fields with a signed amount
(spending negative), or the statement's lines exactly as pasted in \`text\` and this reads
them (date, description, amount per line). Pass text when you were handed the file; retyping
twenty rows is where slips happen. The batch is refused unless opening + rows = closing and the
count matches — that is where a misread digit is caught (P-3). Never adjust a row to make it
fit: re-read. The same hash is refused a second time (P-4); rows already on record are skipped
and listed back. Nothing is categorised here — review follows, one act at a time.`,
  effects: ['source recorded', 'transactions recorded with provenance', 'duplicates skipped and listed'],
  args: {
    name: { ...f.text('File name as given.'), required: true },
    hash: { ...f.text('Content hash of the file if you can compute one; otherwise a stable id the statement carries (statement number + period).'), required: true },
    kind: { ...f.pick(['bank', 'card', 'other'], 'What kind of statement.'), required: true },
    account: f.text('The account label as printed (e.g. "Visa ending 4421").'),
    currency: { ...f.text('ISO 4217 code of the statement.'), required: true },
    period_start: { ...f.date('First day the statement covers.'), required: true },
    period_end: { ...f.date('Last day the statement covers.'), required: true },
    opening_balance: { ...f.money('Opening balance as printed, signed.'), required: true },
    closing_balance: { ...f.money('Closing balance as printed, signed.'), required: true },
    row_count: { ...f.int('Number of rows the statement lists.'), required: true },
    rows: f.lines(ROW, 'Every row, in the statement\'s order. Leave out when you pass text.'),
    text: f.note('The statement\'s lines exactly as you were given them, unchanged: one row per line, date first, amount last. Header and footer lines are ignored. Use this instead of rows when you were handed the file.'),
  },
  handler(a, { db, at, actor }) {
    // The hash exists to stop the same file landing twice, nothing more. A content hash is
    // best; a filename is an honest stable id and a model that cannot compute a digest will
    // hand one over. Spaces and case are not a reason to refuse: normalise, then require
    // enough of it to be distinctive.
    const hash = String(a.hash).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._:-]/g, '');
    if (!/^[a-z0-9][a-z0-9._:-]{7,159}$/.test(hash)) throw new Rejected('hash: at least 8 characters of letters, digits, . _ : - once spaces are collapsed (a content hash, the file name, or the statement id plus period).');
    const dup = db.prepare('SELECT id, name, created_at FROM purch_source WHERE hash = ?').get(hash);
    if (dup) throw new Rejected(`This statement is already imported as ${dup.id} (${dup.name}, ${dup.created_at.slice(0, 10)}). The same file never goes in twice (P-4).`);
    const cur = String(a.currency).toUpperCase(); if (!H.CUR_RE.test(cur)) throw new Rejected('currency is a three-letter ISO 4217 code.');
    if (a.rows?.length && a.text) throw new Rejected('Pass the rows as fields or the statement as text, not both.');
    const rows = a.rows?.length ? a.rows : a.text ? parseStatementText(a.text) : [];
    if (!rows.length) throw new Rejected(a.text ? 'No line in the text starts with a date, so no row could be read. A row is date, description, amount.' : 'A statement with no rows is not a statement.');
    if (rows.length !== a.row_count) throw new Rejected(`The statement says ${a.row_count} rows; you handed over ${rows.length}. Re-read it and pass every row (P-3).`);
    if (a.period_end < a.period_start) throw new Rejected('period_end is before period_start.');
    let sum = 0;
    rows.forEach((r, i) => {
      if (!Number.isInteger(r.amount) || r.amount === 0) throw new Rejected(`Row ${i + 1}: amount must be a non-zero whole number of minor units (spending negative).`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) throw new Rejected(`Row ${i + 1}: date must be ISO YYYY-MM-DD.`);
      if (r.date < a.period_start || r.date > a.period_end) throw new Rejected(`Row ${i + 1} is dated ${r.date}, outside the statement's period ${a.period_start}–${a.period_end}.`);
      sum += r.amount;
    });
    const expected = a.closing_balance - a.opening_balance;
    if (sum !== expected) {
      throw new Rejected(`The rows do not reconcile: they sum to ${H.money(sum, cur)}, but the statement moves ${H.money(a.opening_balance, cur)} → ${H.money(a.closing_balance, cur)}, which is ${H.money(expected, cur)}. Gap ${H.money(expected - sum, cur)}. Re-read the rows; do not adjust them to fit (P-3).`);
    }
    const id = H.nextId('SRC', 'purch_source');
    const skipped = []; let n = 0;
    const seen = db.prepare('SELECT id, source_id FROM purch_transaction WHERE currency = ? AND date = ? AND amount = ? AND lower(description) = lower(?) LIMIT 1');
    db.prepare(`INSERT INTO purch_source (id,name,hash,kind,account,currency,period_start,period_end,opening_balance,closing_balance,row_count,rows_in,rows_skipped,imported_by,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`).run(id, a.name, hash, a.kind, a.account || null, cur, a.period_start, a.period_end, a.opening_balance, a.closing_balance, a.row_count, actor || 'unknown', at);
    const alias = db.prepare('SELECT vendor_id FROM purch_vendor_alias WHERE alias = ?');
    rows.forEach((r, i) => {
      const have = seen.get(cur, r.date, r.amount, r.description);
      if (have) { skipped.push({ row_index: r.row_index || i + 1, date: r.date, amount: r.amount, description: r.description, already: have.id, in_source: have.source_id }); return; }
      const tid = H.nextId('T', 'purch_transaction');
      const v = alias.get(r.description);   // a shop named once is named for every later row
      db.prepare(`INSERT INTO purch_transaction (id,source_id,row_index,date,amount,currency,description,counterparty,raw,vendor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(tid, id, r.row_index || i + 1, r.date, r.amount, cur, r.description, r.counterparty || null, r.raw || null, v ? v.vendor_id : null, at);
      n++;
    });
    db.prepare('UPDATE purch_source SET rows_in = ?, rows_skipped = ? WHERE id = ?').run(n, skipped.length, id);
    const ids = db.prepare('SELECT id, row_index, date, amount, description FROM purch_transaction WHERE source_id = ? ORDER BY row_index').all(id);
    return { source: id, name: a.name, hash, currency: cur, reconciled: true, rows_in: n, rows_skipped: skipped.length, skipped,
      // The ids the review step needs, so nobody has to guess them or fetch them again.
      transactions: ids.map(t => ({ id: t.id, row_index: t.row_index, date: t.date, amount: t.amount, description: t.description })),
      spend: H.money(-rows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0), cur), money_in: H.money(rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0), cur),
      note: `Accepted whole: ${rows.length} rows reconcile to ${H.money(a.opening_balance, cur)} → ${H.money(a.closing_balance, cur)}.${skipped.length ? ` ${skipped.length} already on record, skipped (listed).` : ''} NEXT: read purch_vocabulary (the statuses and the person's own categories and vendors), propose a status, a category and a vendor for every row listed here, show the person the whole table, and once they have answered write it in one purch_review_batch with their confirmation as the reason. A row marked recurring must carry its vendor.` };
  },
});

defineCommand({
  name: 'purch_discard_source',
  permission: 'workspace.admin',
  title: 'Discard statement', group: 'Purchases', subject: 'purch_source',
  summary: 'Throw out one imported statement and every row that came from it, with a reason, so it can be re-read and imported again.',
  doctrine: `A wrong row means a wrong source (P-2): rows are never edited, the statement is
discarded and imported again from a fresh read. Receipts matched to its rows go back to
unmatched and are listed; vendors, aliases and subscriptions stay — they are the person's
words, not the statement's. The hash is free again afterwards. Owner's act, on the record.`,
  effects: ['source and its transactions deleted', 'matched receipts unmatched', 'hash free to import again'],
  guards: [ () => true ],
  args: { source_id: { ...f.text('The statement, e.g. SRC-0001.'), required: true }, reason: { ...f.text('Why — a misread column, the wrong file, a re-read.'), required: true } },
  handler(a, { db, at }) {
    const s = H.need('purch_source', a.source_id, 'source');
    const rows = db.prepare('SELECT id FROM purch_transaction WHERE source_id = ?').all(s.id).map(r => r.id);
    const unmatched = rows.length ? db.prepare(`SELECT id, transaction_id FROM purch_receipt WHERE transaction_id IN (${rows.map(() => '?').join(',')})`).all(...rows) : [];
    for (const r of unmatched) db.prepare('UPDATE purch_receipt SET transaction_id = NULL, updated_at = ? WHERE id = ?').run(at, r.id);
    db.prepare('DELETE FROM purch_transaction WHERE source_id = ?').run(s.id);
    db.prepare('DELETE FROM purch_source WHERE id = ?').run(s.id);
    return { discarded: s.id, name: s.name, hash: s.hash, rows_removed: rows.length, receipts_unmatched: unmatched.map(r => r.id),
      note: `${s.name} discarded with ${rows.length} rows. Import it again from a fresh read; the hash ${s.hash} is free.` };
  },
});
