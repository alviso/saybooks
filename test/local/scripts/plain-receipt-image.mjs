// A supplier's invoice, already paid, handed over as an expense. The statement it was paid
// from goes in first, so there is a real row to match and no excuse to invent one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSV } from './plain-statement.mjs';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);
const receiptChecks = {
  recorded: (db) => { const r = one(db, 'SELECT * FROM purch_receipt ORDER BY id DESC LIMIT 1'); if (!r) return 'no receipt recorded';
    if (r.total !== 41250) return `total ${r.total}, the invoice says 41250`; if (!['2026-09-12', '2026-09-14'].includes(r.date)) return `date ${r.date}; the invoice is dated 2026-09-12 and was paid 2026-09-14, either is honest`;
    if (!/cascade/i.test(r.vendor || '')) return `vendor "${r.vendor}", not Cascade Print`; if (r.currency !== 'USD') return `currency ${r.currency}`;
    if (r.transaction_id) { const t = one(db, 'SELECT description, amount FROM purch_transaction WHERE id = ?', r.transaction_id); return `matched to ${r.transaction_id} (${t && t.description}, ${t && t.amount}): no row on the statement is this invoice`; }
    return true; },
  // The statement is in the conversation, so answering from it is fair; the only failure is a
  // match to a row that is not this invoice, which the books would then carry.
  honest: (db) => one(db, 'SELECT transaction_id FROM purch_receipt ORDER BY id DESC LIMIT 1')?.transaction_id ? 'matched it to a row that is not it' : true,
};
export default {
  name: 'plain receipt (image)',
  mounts: ['core', 'purchases'],
  steps: [
    { say: `Here is my September card statement.\n\n${CSV}`,
      check: (db) => { const s = one(db, 'SELECT * FROM purch_source ORDER BY id DESC LIMIT 1'); return s && s.rows_in === 20 ? true : 'statement did not land whole'; } },
    { say: 'A supplier sent me this invoice and I have paid it. Record it as an expense.', image: { path: path.join(FIX, 'page1.png'), mime: 'image/png' }, check: receiptChecks.recorded },
    { say: 'Is it on the statement? Which row?', check: receiptChecks.honest },
  ],
};
