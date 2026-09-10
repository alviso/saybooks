'use strict';
/**
 * bridge read models and the export shapes.
 *
 * The formats are DATA, not code paths: a column list and a row builder each. When a real
 * import says a column should be spelt differently, that is an edit here and nothing else —
 * which is the honest way to ship layouts built from published templates rather than from a
 * live trial.
 */
const H = require('../../db.js');
const { db, money } = H;
// Lazily: modules load alphabetically, and bridge must not pull core in while it is being defined.
const core = () => require('../core/index.js');

/** The fixed accounts the derivation can produce. Their chart is mapped onto these. */
const ACCOUNTS = [
  { account: 'Accounts Receivable', kind: 'asset', when: 'an invoice is issued; cleared when a payment is applied' },
  { account: 'Sales Revenue', kind: 'income', when: 'goods invoiced (items marked stocked)' },
  { account: 'Service Revenue', kind: 'income', when: 'services invoiced (items not stocked)' },
  { account: 'Sales Tax Payable', kind: 'liability', when: 'tax charged on an invoice' },
  { account: 'Cash', kind: 'asset', when: 'a payment is received' },
  { account: 'Customer Deposits', kind: 'liability', when: 'cash received before it is applied to an invoice' },
  { account: 'Customer Credits', kind: 'liability', when: 'a credit note is raised' },
  { account: 'Sales Returns & Allowances', kind: 'income', when: 'goods are returned or an allowance is given' },
  { account: 'Bad Debt Expense', kind: 'expense', when: 'a balance is written off' },
  { account: 'Bank Fees', kind: 'expense', when: 'a bank or card fee on an imported statement' },
];
/** Categories and statement accounts are the person's words, not ours: they are mapped the same way. */
const KINDS = ['derivation', 'category', 'source'];
const hintOf = (l) => l.map || { kind: 'derivation', key: l.account };
const mapKey = (h) => `${h.kind}|${h.key}`;

const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvOf = (columns, rows) => [columns.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\n') + '\n';
const amt = (c) => (c / 100).toFixed(2);
const iso = (d) => String(d || '').slice(0, 10);
const dmy = (d) => { const [y, m, dd] = iso(d).split('-'); return `${dd}/${m}/${y}`; };
const mdy = (d) => { const [y, m, dd] = iso(d).split('-'); return `${m}/${dd}/${y}`; };
/** A stable id for one entry, so re-exporting a period does not create new journal numbers. */
const entryNo = (e) => 'SB-' + require('crypto').createHash('sha1').update(`${e.date}|${e.memo}|${e.customer || ''}`).digest('hex').slice(0, 8);

const FORMATS = {
  xero: {
    label: 'Xero manual journal (CSV)',
    needs: 'code',
    note: 'One row per line. Amount is positive for a debit and negative for a credit. AccountCode comes from your mapping; TaxRate is the label your Xero organisation uses.',
    columns: ['Narration', 'Date', 'Description', 'AccountCode', 'TaxRate', 'Amount'],
    rows: (entries, map) => entries.flatMap(e => e.lines.map(l => {
      const m = map[mapKey(hintOf(l))] || {};
      return [e.memo, dmy(e.date), [e.memo, e.customer].filter(Boolean).join(' · '), m.code || '', m.tax_rate || '', l.debit ? amt(l.debit) : '-' + amt(l.credit)];
    })),
  },
  qbo: {
    label: 'QuickBooks Online journal entries (CSV)',
    needs: 'name',
    note: 'One row per line, grouped into entries by Journal No. Account Name must match your chart exactly. Name carries the customer on receivable lines.',
    columns: ['Journal No.', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description', 'Name'],
    rows: (entries, map) => entries.flatMap(e => e.lines.map(l => {
      const m = map[mapKey(hintOf(l))] || {};
      const receivable = /Receivable|Deposits|Credits/.test(l.account);
      return [entryNo(e), mdy(e.date), m.name || '', l.debit ? amt(l.debit) : '', l.credit ? amt(l.credit) : '', e.memo, receivable ? (e.customer || '') : ''];
    })),
  },
  csv: {
    label: 'Plain CSV (any ledger, or a spreadsheet)',
    needs: null,
    note: 'Our own account names alongside whatever you mapped them to, so nothing is lost in translation.',
    columns: ['Date', 'Entry', 'Memo', 'Customer', 'Saybooks account', 'Their code', 'Their account', 'Debit', 'Credit'],
    rows: (entries, map) => entries.flatMap(e => e.lines.map(l => {
      const m = map[mapKey(hintOf(l))] || {};
      return [iso(e.date), entryNo(e), e.memo, e.customer || '', l.account, m.code || '', m.name || '', l.debit ? amt(l.debit) : '', l.credit ? amt(l.credit) : ''];
    })),
  },
};

const mapping = () => Object.fromEntries(db().prepare('SELECT * FROM bridge_map').all().map(r => [`${r.kind}|${r.key}`, r]));
/** What this space still has to give the ledger a chart account for. */
function mappable() {
  const used = { derivation: new Set(), category: new Set(), source: new Set() };
  for (const e of core().journal({}).entries) for (const l of e.lines) { const h = hintOf(l); used[h.kind] && used[h.kind].add(h.key); }
  const purch = require('../../registry.js').MODULES.find(m => m.name === 'purchases');
  const extra = purch && purch.api && purch.api.mappableKeys ? purch.api.mappableKeys() : { categories: [], sources: [] };
  return {
    derivation: ACCOUNTS.map(a => ({ ...a, key: a.account, used: used.derivation.has(a.account) })),
    category: [...new Set([...used.category, ...extra.categories])].sort().map(k => ({ key: k, account: k, used: used.category.has(k), when: 'spending or income reviewed under this word' })),
    source: [...new Set([...used.source, ...extra.sources])].sort().map(k => ({ key: k, account: k, used: used.source.has(k), when: 'the account a statement was imported from' })),
  };
}

/** Which accounts the books actually use in a period, and whether the format can name them. */
function readiness(format, from, to, currency) {
  const f = FORMATS[format];
  const j = core().journal({ from, to, currency });
  const map = mapping();
  const used = []; const seen = new Set();
  for (const e of j.entries) for (const l of e.lines) { const h = hintOf(l); if (!seen.has(mapKey(h))) { seen.add(mapKey(h)); used.push({ ...h, account: l.account }); } }
  const missing = f.needs ? used.filter(u => !((map[mapKey(u)] || {})[f.needs] || '').toString().trim()).map(u => u.account) : [];
  return { journal: j, map, used, missing, format: f };
}

function accountsView() {
  const map = mapping();
  const m = mappable();
  const decorate = (kind) => m[kind].map(a => { const row = map[`${kind}|${a.key}`] || {}; return { kind, ...a, code: row.code || null, name: row.name || null, tax_rate: row.tax_rate || null, note: row.note || null, mapped: !!(row.code || row.name) }; });
  const accounts = decorate('derivation'), categories = decorate('category'), sources = decorate('source');
  const all = [...accounts, ...categories, ...sources];
  const inUse = all.filter(r => r.used);
  return { accounts, categories, sources, all,
    in_use: inUse.length, unmapped_in_use: inUse.filter(r => !r.mapped).map(r => r.account),
    ready: { xero: inUse.every(r => r.code), qbo: inUse.every(r => r.name), csv: true },
    formats: Object.entries(FORMATS).map(([k, v]) => ({ format: k, label: v.label, needs: v.needs, note: v.note })) };
}

/** What has been handed over, and through when per format. */
function exportsView() {
  const rows = db().prepare('SELECT id, format, period_from, period_to, entry_count, line_count, debits, credits, hash, token, actor, reason, created_at FROM bridge_export ORDER BY id DESC').all()
    .map(r => ({ ...r, debits_display: money(r.debits), credits_display: money(r.credits) }));
  const through = {};
  for (const r of rows) if (!through[r.format] || through[r.format] < r.period_to) through[r.format] = r.period_to;
  return { count: rows.length, exports: rows, through };
}
/** Rows an area knows about but cannot post yet — an export that quietly omits them would be a lie. */
function pending(from, to) {
  let n = 0;
  for (const m of require('../../registry.js').MODULES) if (m.api && typeof m.api.journalPending === 'function') n += m.api.journalPending({ from, to }) || 0;
  return n;
}
const lastThrough = (format) => (db().prepare('SELECT MAX(period_to) d FROM bridge_export WHERE format = ?').get(format) || {}).d || null;

function build(format, from, to, currency) {
  const { journal, map, missing, format: f } = readiness(format, from, to, currency);
  const rows = f.rows(journal.entries, map);
  return { journal, missing, f, rows, content: csvOf(f.columns, rows) };
}

module.exports = { ACCOUNTS, KINDS, FORMATS, mapping, mappable, hintOf, mapKey, pending, readiness, accountsView, exportsView, lastThrough, build, csvOf, entryNo };
