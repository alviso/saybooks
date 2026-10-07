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
/** Rows an area knows about but cannot post — named, with their value: an export that quietly omitted them would be a lie. */
function omitted(from, to) {
  const rows = [];
  for (const m of require('../../registry.js').MODULES) if (m.api && typeof m.api.journalOmitted === 'function') rows.push(...(m.api.journalOmitted({ from, to }) || []));
  const by = {};
  for (const r of rows) { const c = r.currency || 'USD'; by[c] = by[c] || { currency: c, count: 0, amount: 0 }; by[c].count++; by[c].amount += r.amount; }
  for (const c of Object.keys(by)) by[c].amount_display = money(by[c].amount, c);
  return { count: rows.length, rows, by_currency: by,
    note: rows.length ? `${rows.length} statement row${rows.length > 1 ? 's are' : ' is'} not in this file (${Object.values(by).map(b => `${b.amount_display} net in ${b.currency}`).join(', ')}). The ledger's bank balance will differ from the statement by that much until they are dealt with.` : null };
}
const lastThrough = (format) => (db().prepare('SELECT MAX(period_to) d FROM bridge_export WHERE format = ?').get(format) || {}).d || null;

function build(format, from, to, currency) {
  const { journal, map, missing, format: f } = readiness(format, from, to, currency);
  const rows = f.rows(journal.entries, map);
  return { journal, missing, f, rows, content: csvOf(f.columns, rows) };
}

// ---------------------------------------------------------------- preliminary financials (B-12)
const { Rejected } = require('../../registry.js');
const KIND_OF = Object.fromEntries(ACCOUNTS.map(a => [a.account, a.kind]));
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** "2026-Q3", "2026-09", "2026", or from/to. A statement needs a period to be about. */
function periodOf(a) {
  const named = namedPeriod(a);
  // A named period that has not ended yet runs to today: a balance sheet dated in the future
  // would show a day nobody has seen.
  const now = H.today();
  if (named && named.to > now && named.from <= now) return { ...named, to: now, label: `${named.label} to date` };
  if (named) return named;
  return customPeriod(a);
}
function namedPeriod(a) {
  const p = String(a.period || '').trim().toUpperCase();
  let m;
  if ((m = /^(\d{4})-Q([1-4])$/.exec(p))) { const y = +m[1], q = +m[2], m1 = (q - 1) * 3 + 1, m3 = q * 3; return { from: `${y}-${String(m1).padStart(2, '0')}-01`, to: `${y}-${String(m3).padStart(2, '0')}-${lastDay(y, m3)}`, label: `Q${q} ${y}` }; }
  if ((m = /^(\d{4})-(\d{2})$/.exec(p)) && +m[2] >= 1 && +m[2] <= 12) { const y = +m[1], mo = +m[2]; return { from: `${p}-01`, to: `${p}-${lastDay(y, mo)}`, label: new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }; }
  if ((m = /^(\d{4})$/.exec(p))) return { from: `${p}-01-01`, to: `${p}-12-31`, label: p };
  if (p) throw new Rejected(`"${a.period}" is not a period. Use a quarter (2026-Q3), a month (2026-09), a year (2026), or from and to.`);
  return null;
}
function customPeriod(a) {
  if (a.from || a.to) {
    const from = a.from || null, to = a.to || null;
    if (!to) throw new Rejected('A period needs an end: pass to (YYYY-MM-DD), or a quarter, month or year as period.');
    if (from && to < from) throw new Rejected(`The period ends before it starts: ${to} is before ${from}.`);
    return { from, to, label: from ? `${from} to ${to}` : `through ${to}` };
  }
  throw new Rejected('Preliminary statements need a period: a quarter (2026-Q3), a month (2026-09), a year (2026), or from and to.');
}
/** Where a transfer went, from the person's own word for it. Unclear words stay unclear. */
function transferKind(name, statementNames) {
  const n = String(name || '').toLowerCase();
  if (statementNames.has(n)) return 'statement';
  if (/draw|owner|distribution|personal/.test(n)) return 'equity';
  if (/saving|brokerage|invest|deposit|reserve|checking|current account|bank/.test(n)) return 'asset';
  if (/loan|mortgage|credit line|line of credit/.test(n)) return 'liability';
  return 'unclassified';
}
function financials(a) {
  const per = periodOf(a);
  const stmts = [];
  for (const m of require('../../registry.js').MODULES) if (m.api && typeof m.api.statementAccounts === 'function') stmts.push(...(m.api.statementAccounts() || []));
  const all = core().journal({ to: per.to });
  let cur = a.currency ? String(a.currency).trim().toUpperCase() : null;
  const curs = [...new Set([...all.currencies, ...stmts.filter(s => s.first_start <= per.to).map(s => s.currency)])];
  if (!cur) {
    if (curs.length > 1) throw new Rejected(`These books hold ${curs.join(' and ')}. Preliminary statements are one currency at a time: pass currency.`);
    cur = curs[0] || (H.locale().currency || 'USD');
  }
  const mine = stmts.filter(s => s.currency === cur && s.first_start <= per.to);
  const stmtNames = new Set(mine.map(s => s.account.toLowerCase()));
  const banks = mine.filter(s => s.kind !== 'card');
  // Money received against invoices posts to Cash; it landed in the bank. With exactly one bank
  // account on record, Cash is that account, so the bank figure can tie to its statement.
  const foldCash = banks.length === 1 ? banks[0].account : null;
  const partial = new Set();   // accounts known only from transfers into or out of them
  const classify = (l) => {
    const h = l.map || { kind: 'derivation', key: l.account };
    if (h.kind === 'source') return { kind: 'statement', name: l.account };
    if (h.kind === 'category') {
      if (h.role === 'expense') return { kind: 'expense', name: l.account };
      if (h.role === 'income') return { kind: 'income', name: l.account };
      const k = transferKind(l.account, stmtNames);
      if (k === 'asset' || k === 'liability') partial.add(l.account);
      return { kind: k, name: k === 'statement' ? mine.find(s => s.account.toLowerCase() === l.account.toLowerCase()).account : l.account };
    }
    if (l.account === 'Cash' && foldCash) return { kind: 'statement', name: foldCash, folded: true };
    return { kind: KIND_OF[l.account] || 'unclassified', name: l.account };
  };
  const tally = (entries) => {
    const acc = {};
    for (const e of entries) for (const l of e.lines) {
      const c = classify(l); const k = `${c.kind}|${c.name}`;
      acc[k] = acc[k] || { account: c.name, kind: c.kind, d: 0 };
      acc[k].d += (l.debit || 0) - (l.credit || 0);
    }
    return Object.values(acc);
  };
  const D = (cur2, entries) => tally(entries.filter(e => e.currency === cur2));
  const line = (account, amount) => ({ account, amount, display: money(amount, cur) });
  const sum = (xs) => xs.reduce((n, x) => n + x.amount, 0);

  // Profit and loss: the period's own entries.
  const inPeriod = all.entries.filter(e => e.currency === cur && (!per.from || e.date >= per.from));
  const pl = tally(inPeriod);
  const income = pl.filter(x => x.kind === 'income').map(x => line(x.account, -x.d)).filter(x => x.amount).sort((x, y) => y.amount - x.amount);
  const expenses = pl.filter(x => x.kind === 'expense').map(x => line(x.account, x.d)).filter(x => x.amount).sort((x, y) => y.amount - x.amount);
  const incomeTotal = sum(income), expenseTotal = sum(expenses), net = incomeTotal - expenseTotal;

  // Balance sheet: everything through the period's end, plus each statement account's opening
  // balance as the books' starting point (opening balance equity, as a bookkeeper would).
  const bs = D(cur, all.entries);
  const get = (kind, name) => bs.find(x => x.kind === kind && x.account === name) || { d: 0 };
  const assets = [], liabilities = [], equity = [], unclassified = [], ties = [];
  let opening = 0;
  // Movements dated before an account's first statement are already inside that statement's
  // printed opening balance: they count toward opening balance equity, not on top of it.
  const moved = (s, test) => D(cur, all.entries.filter(test)).filter(x => x.kind === 'statement' && x.account === s.account).reduce((n, x) => n + x.d, 0);
  for (const s of mine) {
    const before = moved(s, e => e.date < s.first_start);
    const books = s.opening + get('statement', s.account).d - before;
    opening += s.opening - before;
    const last = s.statements.filter(x => x.period_end <= per.to).pop();
    if (last) {
      const at = s.opening + moved(s, e => e.date >= s.first_start && e.date <= last.period_end);
      ties.push({ account: s.account, statement_through: last.period_end, printed: last.closing, books: at, ties: at === last.closing,
        note: at === last.closing ? `Ties to the statement through ${last.period_end}.` : `Differs from the statement through ${last.period_end} by ${money(last.closing - at, cur)}: usually rows not reviewed yet, or a transfer with no other side named.` });
    }
    if (books >= 0) assets.push(line(s.account, books)); else liabilities.push(line(s.account, -books));
  }
  for (const x of bs) {
    if (x.kind === 'statement' || x.kind === 'income' || x.kind === 'expense') continue;
    if (x.kind === 'asset') { if (x.d) assets.push(line(x.account, x.d)); }
    else if (x.kind === 'liability') { if (x.d) liabilities.push(line(x.account, -x.d)); }
    else if (x.kind === 'equity') { if (x.d) equity.push(line(x.account, -x.d)); }
    else if (x.d) { unclassified.push(x.account); if (x.d > 0) assets.push({ ...line(x.account, x.d), unclassified: true }); else liabilities.push({ ...line(x.account, -x.d), unclassified: true }); }
  }
  const earned = bs.filter(x => x.kind === 'income').reduce((n, x) => n - x.d, 0) - bs.filter(x => x.kind === 'expense').reduce((n, x) => n + x.d, 0);
  if (opening) equity.unshift(line('Opening balances (from the first statements)', opening));
  equity.push(line('Earnings to date', earned));
  const totalA = sum(assets), totalL = sum(liabilities), totalE = sum(equity);

  // What these figures leave out, said on their face (B-11, B-12).
  const left = omitted(per.from, per.to);
  const leftHere = left.rows.filter(r => (r.currency || cur) === cur);
  const unreviewed = leftHere.filter(r => r.status === 'unreviewed');
  const notes = ['Preliminary: derived from the operational record for the person and their accountant to review. Not a filing, and not the ledger of record.',
    'Invoices count as revenue when issued; spending and income count on the date the statement shows them.'];
  if (unreviewed.length) notes.push(`${unreviewed.length} statement row${unreviewed.length > 1 ? 's' : ''} in the period ${unreviewed.length > 1 ? 'are' : 'is'} not reviewed yet (${money(unreviewed.reduce((n, r) => n + r.amount, 0), cur)} net) and ${unreviewed.length > 1 ? 'are' : 'is'} not in these figures.`);
  const otherLeft = leftHere.length - unreviewed.length;
  if (otherLeft) notes.push(`${otherLeft} other row${otherLeft > 1 ? 's' : ''} left out on purpose, ${money(leftHere.filter(r => r.status !== 'unreviewed').reduce((n, r) => n + r.amount, 0), cur)} net: rows marked ignored, and transfers with no other side named. That is right for the second half of a payment between two of your own accounts, and for a client payment already recorded against its invoice, so neither is counted twice.`);
  if (!inPeriod.length && !mine.length) notes.unshift(`Nothing happened in these books in ${per.label}.`);
  for (const u of unclassified) notes.push(`"${u}" is where transfers went, but not what it is. Ask: savings (an asset), an owner draw (equity), or a loan or card (a liability)?`);
  const cashLines = all.entries.some(e => e.currency === cur && e.lines.some(l => l.account === 'Cash' && !l.map));
  if (foldCash && cashLines) notes.push(`Payments recorded against invoices are counted in ${foldCash}, where they landed.`);
  else if (bs.some(x => x.kind === 'asset' && x.account === 'Cash' && x.d)) notes.push('Cash is money recorded as received against invoices; the accountant maps it to the bank account it went into.');
  for (const n of partial) if (bs.some(x => x.account === n && x.d)) notes.push(`${n} holds only the transfers recorded against it here; import its statements and it starts from its real balance.`);
  for (const t of ties) if (!t.ties) notes.push(`${t.account}: ${t.note}`);
  let unpaid = { count: 0, amount: 0 };
  for (const m of require('../../registry.js').MODULES) if (m.api && typeof m.api.unpaidBills === 'function') { const u = m.api.unpaidBills({ as_of: per.to, currency: cur }); unpaid.count += u.count; unpaid.amount += u.amount; }
  if (unpaid.count) notes.push(`${unpaid.count} bill${unpaid.count > 1 ? 's' : ''} received by ${per.to} and not paid by then (${money(unpaid.amount, cur)}) ${unpaid.count > 1 ? 'are' : 'is'} not in these figures: bills count when the payment shows on a statement. The accountant books them as payable at the close.`);
  notes.push('Not included: cost of goods, inventory, depreciation, accruals and other adjustments the accountant makes at the close.');

  return {
    preliminary: true, period: per.label, from: per.from, to: per.to, currency: cur,
    income_total: incomeTotal, expense_total: expenseTotal, net_income: net,
    total_assets: totalA, total_liabilities: totalL, total_equity: totalE, balanced: totalA === totalL + totalE,
    profit_and_loss: { income, income_total: money(incomeTotal, cur), expenses, expense_total: money(expenseTotal, cur), net_income: money(net, cur) },
    balance_sheet: { as_of: per.to, assets, total_assets: money(totalA, cur), liabilities, total_liabilities: money(totalL, cur), equity, total_equity: money(totalE, cur) },
    ties, unreviewed_in_period: unreviewed.length, unclassified, notes,
  };
}

module.exports = { financials, periodOf, ACCOUNTS, KINDS, FORMATS, mapping, mappable, hintOf, mapKey, omitted, readiness, accountsView, exportsView, lastThrough, build, csvOf, entryNo };
