'use strict';
/** purchases read models. Sums are per currency and never cross (P-1). */
const H = require('../../db.js');
const { db, need, get, money, today } = H;

const spendOf = (rows) => {   // negative amounts are spending; report it as a positive figure
  const by = {};
  for (const r of rows) { const c = r.currency; by[c] = by[c] || { currency: c, count: 0, amount: 0 }; by[c].count++; by[c].amount += -r.amount; }
  for (const c of Object.keys(by)) by[c].amount_display = money(by[c].amount, c);
  return by;
};
const vendorName = (id) => (id && get('purch_vendor', id) || {}).name || null;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- bills (P-12)
const OPEN_BILL = ['open', 'approved'];
function billView(id) {
  const b = need('purch_bill', id, 'bill');
  const days = b.due_date ? Math.floor((Date.parse(b.due_date) - Date.parse(today())) / 864e5) : null;
  return { ...b, name: `${vendorName(b.vendor_id) || 'Bill'}${b.number ? ' ' + b.number : ''}`, vendor: vendorName(b.vendor_id), amount_display: money(b.amount, b.currency),
    due_in_days: OPEN_BILL.includes(b.status) ? days : null, overdue: OPEN_BILL.includes(b.status) && days < 0 };
}
function bills({ status } = {}) {
  let rows = [];
  try { rows = db().prepare(`SELECT id FROM purch_bill ${status ? 'WHERE status = ?' : ''} ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'approved' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END, due_date, id`).all(...(status ? [status] : [])); } catch { return { count: 0, items: [] }; }
  const items = rows.map(r => billView(r.id));
  return { count: items.length, open: items.filter(i => i.status === 'open').length, approved: items.filter(i => i.status === 'approved').length, items };
}
/** What is coming due against what the latest statements say there is. Cash is each bank
    account's printed closing balance on its latest statement, dated, never projected. */
function payables({ as_of } = {}) {
  const at = as_of || today();
  let open = [];
  try { open = db().prepare(`SELECT id FROM purch_bill WHERE status IN ('open','approved') ORDER BY due_date, id`).all().map(r => billView(r.id)); } catch { open = []; }
  const days = (b) => Math.floor((Date.parse(b.due_date) - Date.parse(at)) / 864e5);
  const buckets = { overdue: [], next_7_days: [], next_30_days: [], later: [] };
  for (const b of open) { const d = days(b); (d < 0 ? buckets.overdue : d <= 7 ? buckets.next_7_days : d <= 30 ? buckets.next_30_days : buckets.later).push(b); }
  const curs = [...new Set(open.map(b => b.currency))];
  const cash = {};
  for (const a of statementAccounts()) {
    if (a.kind === 'card') continue;
    const last = a.statements.filter(x => x.period_end <= at).pop(); if (!last) continue;
    cash[a.currency] = cash[a.currency] || { currency: a.currency, amount: 0, accounts: [] };
    cash[a.currency].amount += last.closing; cash[a.currency].accounts.push({ account: a.account, closing: last.closing, as_of: last.period_end });
  }
  const by = {};
  for (const c of new Set([...curs, ...Object.keys(cash)])) {
    const sumOf = (xs) => xs.filter(b => b.currency === c).reduce((n, b) => n + b.amount, 0);
    const due30 = sumOf(buckets.overdue) + sumOf(buckets.next_7_days) + sumOf(buckets.next_30_days);
    const onHand = cash[c] ? cash[c].amount : null;
    by[c] = { currency: c, overdue: sumOf(buckets.overdue), next_7_days: sumOf(buckets.next_7_days), next_30_days: sumOf(buckets.next_30_days), later: sumOf(buckets.later),
      due_within_30: due30, cash_on_hand: onHand, cash_as_of: cash[c] ? cash[c].accounts.map(x => x.as_of).sort()[0] : null,
      after_due_within_30: onHand == null ? null : onHand - due30 };
    for (const k of ['overdue', 'next_7_days', 'next_30_days', 'later', 'due_within_30', 'cash_on_hand', 'after_due_within_30']) if (by[c][k] != null) by[c][`${k}_display`] = money(by[c][k], c);
  }
  const lines = Object.values(by).map(x => x.cash_on_hand == null
    ? `${x.due_within_30_display} due within 30 days in ${x.currency}; no bank statement on record to set it against.`
    : `${x.due_within_30_display} due within 30 days against ${x.cash_on_hand_display} in the bank as of ${x.cash_as_of}, leaving ${x.after_due_within_30_display}.${x.after_due_within_30 < 0 ? ' That is short: the bills due first, or money coming in, decide which can wait.' : ''}`);
  return { as_of: at, open_count: open.length, overdue_count: buckets.overdue.length, by_currency: by,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.map(b => ({ id: b.id, vendor: b.vendor, number: b.number, due_date: b.due_date, amount_display: b.amount_display, status: b.status }))])),
    note: open.length ? lines.join(' ') : 'No bills waiting to be paid.' };
}
/** Bills received by a date and not paid by it, for the financials' notes (cash basis). A bill
    another area keeps on the accrual basis (a bill on a purchase order) is already in the
    figures, as goods received or accounts payable, so it is not counted here. */
function unpaidBills({ as_of, currency } = {}) {
  try {
    const rows = db().prepare(`SELECT id, amount, currency FROM purch_bill WHERE bill_date <= ? AND status <> 'rejected' AND (paid_at IS NULL OR paid_at > ?) ${currency ? 'AND currency = ?' : ''}`).all(as_of, as_of, ...(currency ? [currency] : []))
      .filter(r => !onAccrual(r.id));
    return { count: rows.length, amount: rows.reduce((n, r) => n + r.amount, 0) };
  } catch { return { count: 0, amount: 0 }; }
}
/** Other areas may hold a bill to a condition before a person approves it (p2p's 3-way match):
    the first one that says no gives its sentence; null when nothing holds it. */
function approvalHold(billId) {
  for (const m of require('../../registry.js').MODULES) {
    if (m.api && typeof m.api.billApprovalHold === 'function') { const why = m.api.billApprovalHold(billId); if (why) return why; }
  }
  return null;
}
/** Is this bill kept on the accrual basis by another area (posted to Accounts Payable when approved)? */
function onAccrual(billId) {
  for (const m of require('../../registry.js').MODULES) if (m.api && typeof m.api.billOnAccrual === 'function' && m.api.billOnAccrual(billId)) return true;
  return false;
}

// ---------------------------------------------------------------- standing rules (P-11)
const SPENDING_STATUSES = new Set(['purchase', 'recurring']);
const activeRules = () => { try { return db().prepare("SELECT r.*, v.name AS vendor FROM purch_rule r LEFT JOIN purch_vendor v ON v.id = r.vendor_id WHERE r.state = 'active' ORDER BY r.created_at DESC, r.id DESC").all(); } catch { return []; } };
/** Does a rule speak about this row? Window, currency, vendor, words, and the sign: a rule
    that suggests spending never suggests it for money in, and income never for money out. */
function ruleMatches(r, t) {
  if (r.date_from && t.date < r.date_from) return false;
  if (r.date_to && t.date > r.date_to) return false;
  if (r.currency && r.currency !== t.currency) return false;
  if (r.vendor_id && r.vendor_id !== t.vendor_id) return false;
  if (r.match && !String(t.description || '').toLowerCase().includes(r.match.toLowerCase())) return false;
  if (SPENDING_STATUSES.has(r.status) && t.amount > 0) return false;
  if (r.status === 'income' && t.amount < 0) return false;
  return true;
}
/** The most specific active rule wins: words to match, then a vendor, then the narrowest
    window, then the newest. Other matching rules that say something different are listed. */
function suggestionFor(t, rules = activeRules()) {
  if (t.status !== 'unreviewed') return null;
  const hits = rules.filter(r => ruleMatches(r, t));
  if (!hits.length) return null;
  const span = (r) => (r.date_from && r.date_to) ? (Date.parse(r.date_to) - Date.parse(r.date_from)) : Infinity;
  hits.sort((a, b) => (!!b.match - !!a.match) || (!!b.vendor_id - !!a.vendor_id) || (span(a) - span(b)) || (a.created_at < b.created_at ? 1 : -1));
  const w = hits[0];
  const others = hits.slice(1).filter(r => r.category.toLowerCase() !== w.category.toLowerCase() || r.status !== w.status);
  return { status: w.status, category: w.category, rule_id: w.id, rule_label: w.label, ...(others.length ? { also: others.map(r => `${r.id} ${r.label}: ${r.category}`) } : {}) };
}
function ruleView(id) {
  const r = need('purch_rule', id, 'rule');
  const rules = activeRules();
  const rows = r.state === 'active' ? db().prepare("SELECT * FROM purch_transaction WHERE status = 'unreviewed' ORDER BY date, id").all()
    .filter(t => { const s = suggestionFor(t, rules); return s && s.rule_id === r.id; }) : [];
  return { ...r, name: r.label, stage: r.state, vendor: vendorName(r.vendor_id), window: windowText(r), suggesting: rows.length,
    rows: rows.map(t => ({ id: t.id, date: t.date, description: t.description, amount: t.amount, currency: t.currency, amount_display: money(t.amount, t.currency) })) };
}
const windowText = (r) => r.date_from && r.date_to ? `${r.date_from} to ${r.date_to}` : r.date_from ? `from ${r.date_from}` : r.date_to ? `until ${r.date_to}` : 'any date';
function rules({ include_ended } = {}) {
  let all = []; try { all = db().prepare(`SELECT * FROM purch_rule ${include_ended ? '' : "WHERE state = 'active'"} ORDER BY state, created_at DESC, id DESC`).all(); } catch { return { count: 0, active: 0, suggesting: 0, items: [] }; }
  const items = all.map(r => { const v = ruleView(r.id); delete v.rows; return v; });
  return { count: items.length, active: items.filter(i => i.state === 'active').length, suggesting: items.reduce((n, i) => n + i.suggesting, 0), items };
}

function transactionView(id) {
  const t = need('purch_transaction', id, 'transaction');
  const receipt = db().prepare('SELECT id, name, total, date FROM purch_receipt WHERE transaction_id = ?').get(id) || null;
  const split = splitsOf(id).map(l => ({ ...l, amount_display: money(l.amount, t.currency) }));
  return { ...t, vendor: vendorName(t.vendor_id), amount_display: money(t.amount, t.currency), spend: t.amount < 0 ? -t.amount : 0, receipt,
    split, split_into: split.length, source_name: (get('purch_source', t.source_id) || {}).name || null, suggested: suggestionFor(t) };
}
function receiptView(id) {
  const r = need('purch_receipt', id, 'receipt');
  return { ...r, matched: !!r.transaction_id, total_display: money(r.total, r.currency) };
}

// ---------------------------------------------------------------- periods: declared, then confirmed
function addPeriod(iso, cadence, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (cadence === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (cadence === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + n);
  else { const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); }
  return d.toISOString().slice(0, 10);
}
const GRACE_DAYS = 5;   // a charge a few days late is not a missed period
const WINDOW_DAYS = { weekly: 3, monthly: 7, yearly: 20 };

/** One subscription as of a date: every expected period so far, matched or missed; lapsed derived from the last two. */
/** The last date a statement in this currency covers: nothing after it can be judged missed. */
const coverageEnd = (currency) => (db().prepare('SELECT MAX(period_end) d FROM purch_source WHERE currency = ?').get(currency) || {}).d || null;

function subscriptionView(id, asOf) {
  const s = need('purch_subscription', id, 'subscription');
  const as = asOf || today();
  const covered = coverageEnd(s.currency);
  // A period counts as missed only when a statement covering its grace window has been read (P-6):
  // judged as of the earlier of the asked date and the coverage end.
  const judge = covered && covered < as ? covered : as;
  const vendor = vendorName(s.vendor_id);
  const tol = Math.round(s.amount * (s.tolerance_bp || 0) / 10000);
  const w = WINDOW_DAYS[s.cadence] || 7;
  const cands = db().prepare(`SELECT id, date, amount FROM purch_transaction WHERE vendor_id = ? AND currency = ? AND status NOT IN ('transfer','income','ignored') AND amount < 0 ORDER BY date`).all(s.vendor_id, s.currency)
    .filter(t => Math.abs(-t.amount - s.amount) <= tol);
  const used = new Set(); const periods = [];
  for (let n = 0; n < 600; n++) {
    const expected = addPeriod(s.start, s.cadence, n);
    if (expected > as) break;
    if (s.status === 'cancelled' && expected > (s.updated_at || as).slice(0, 10)) break;
    const lo = H.addDays(expected, -w), hi = H.addDays(expected, w);
    const hit = cands.find(t => !used.has(t.id) && t.date >= lo && t.date <= hi);
    if (hit) { used.add(hit.id); periods.push({ expected, matched: true, transaction_id: hit.id, date: hit.date, amount: -hit.amount, amount_display: money(-hit.amount, s.currency) }); }
    else { const due = H.addDays(expected, GRACE_DAYS); periods.push({ expected, matched: false, missed: due <= judge, pending: due > judge, no_statement_yet: due > judge && due <= as }); }
  }
  const missed = periods.filter(p => p.missed);
  const tail = periods.slice(-2);
  const lapsed = s.status === 'active' && tail.length === 2 && tail.every(p => p.missed);
  const nextExpected = addPeriod(s.start, s.cadence, periods.length);
  return { ...s, vendor, amount_display: money(s.amount, s.currency), as_of: as, covered_through: covered,
    derived_status: s.status === 'cancelled' ? 'cancelled' : lapsed ? 'lapsed' : 'active',
    periods, matched_periods: periods.filter(p => p.matched).length, missed_periods: missed.length,
    last_charge: [...periods].reverse().find(p => p.matched) || null,
    next_expected: s.status === 'cancelled' ? null : nextExpected,
    monthly_equivalent: s.cadence === 'weekly' ? Math.round(s.amount * 52 / 12) : s.cadence === 'yearly' ? Math.round(s.amount / 12) : s.amount,
  };
}

function subscriptions(asOf) {
  const items = db().prepare('SELECT id FROM purch_subscription ORDER BY id').all().map(r => subscriptionView(r.id, asOf));
  const active = items.filter(i => i.derived_status === 'active');
  const monthly = {};
  for (const i of active) { monthly[i.currency] = (monthly[i.currency] || 0) + i.monthly_equivalent; }
  return { as_of: asOf || today(), items, count: items.length,
    active_total: active.length, lapsed_total: items.filter(i => i.derived_status === 'lapsed').length, cancelled_total: items.filter(i => i.derived_status === 'cancelled').length,
    missed_total: items.reduce((s, i) => s + i.missed_periods, 0),
    monthly_equivalent: Object.fromEntries(Object.entries(monthly).map(([c, a]) => [c, { amount: a, amount_display: money(a, c) }])) };
}

function transactions({ from, to, status, source_id, vendor, category, limit } = {}) {
  const where = []; const args = [];
  if (from) { where.push('t.date >= ?'); args.push(from); }
  if (to) { where.push('t.date <= ?'); args.push(to); }
  if (status === 'spending') where.push("t.status IN ('purchase','recurring')");
  else if (status) { where.push('t.status = ?'); args.push(status); }
  if (source_id) { where.push('t.source_id = ?'); args.push(source_id); }
  if (category) { where.push('t.category = ? COLLATE NOCASE'); args.push(category); }
  if (vendor) { where.push('v.name = ? COLLATE NOCASE'); args.push(vendor); }
  const rows = db().prepare(`SELECT t.*, v.name AS vendor, r.id AS receipt_id FROM purch_transaction t LEFT JOIN purch_vendor v ON v.id = t.vendor_id LEFT JOIN purch_receipt r ON r.transaction_id = t.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...args, limit || 500);
  const rl = activeRules();
  const items = rows.map(r => ({ ...r, amount_display: money(r.amount, r.currency), has_receipt: !!r.receipt_id, suggested: suggestionFor(r, rl) }));
  const unreviewed = items.filter(i => i.status === 'unreviewed').length;
  return { count: items.length, unreviewed, suggested: items.filter(i => i.suggested).length, items, spend_by_currency: spendOf(items.filter(i => i.status === 'purchase' || i.status === 'recurring' || (i.status === 'unreviewed' && i.amount < 0))) };
}

function purchases(opts = {}) {
  const t = transactions({ ...opts, status: 'spending', limit: 5000 });
  const byCat = {}, byMonth = {}, byVendor = {};
  for (const i of t.items) {
    const c = i.currency, sp = -i.amount;
    const k1 = `${i.category || '(uncategorised)'}|${c}`; byCat[k1] = byCat[k1] || { category: i.category || null, currency: c, amount: 0, count: 0 }; byCat[k1].amount += sp; byCat[k1].count++;
    const k2 = `${i.date.slice(0, 7)}|${c}`; byMonth[k2] = byMonth[k2] || { month: i.date.slice(0, 7), currency: c, amount: 0, count: 0 }; byMonth[k2].amount += sp; byMonth[k2].count++;
    const k3 = `${i.vendor || '(no vendor)'}|${c}`; byVendor[k3] = byVendor[k3] || { vendor: i.vendor || '(no vendor)', named: !!i.vendor, currency: c, amount: 0, count: 0 }; byVendor[k3].amount += sp; byVendor[k3].count++;
  }
  const fin = (o) => Object.values(o).map(x => ({ ...x, amount_display: money(x.amount, x.currency) }));
  const latest = (db().prepare('SELECT MAX(period_end) d FROM purch_source').get() || {}).d || null;
  return { count: t.count, items: t.items, spend_by_currency: spendOf(t.items), covered_through: latest,
    by_category: fin(byCat).sort((a, b) => b.amount - a.amount), by_month: fin(byMonth).sort((a, b) => a.month < b.month ? -1 : 1),
    by_vendor: fin(byVendor).sort((a, b) => b.amount - a.amount).slice(0, 25) };
}

function receipts({ unmatched } = {}) {
  const rows = db().prepare(`SELECT * FROM purch_receipt ${unmatched ? 'WHERE transaction_id IS NULL' : ''} ORDER BY date DESC, id DESC`).all();
  const items = rows.map(r => ({ ...r, matched: !!r.transaction_id, total_display: money(r.total, r.currency) }));
  return { count: items.length, unmatched: items.filter(i => !i.matched).length, items };
}

function sources() {
  const rows = db().prepare('SELECT * FROM purch_source ORDER BY period_start DESC, id DESC').all();
  return { count: rows.length, items: rows.map(s => ({ ...s, opening_display: money(s.opening_balance, s.currency), closing_display: money(s.closing_balance, s.currency), reconciled: true })) };
}
function sourceView(id) {
  const s = need('purch_source', id, 'source');
  const rows = db().prepare('SELECT t.*, v.name AS vendor FROM purch_transaction t LEFT JOIN purch_vendor v ON v.id = t.vendor_id WHERE t.source_id = ? ORDER BY t.row_index').all(id)
    .map(r => ({ ...r, amount_display: money(r.amount, r.currency), suggested: suggestionFor(r) }));
  return { ...s, opening_display: money(s.opening_balance, s.currency), closing_display: money(s.closing_balance, s.currency), reconciled: true, rows, unreviewed: rows.filter(r => r.status === 'unreviewed').length };
}

/** Candidates for a receipt: same currency, spending, same amount within a cent, within seven days, no receipt yet. */
function receiptCandidates(r) {
  return db().prepare(`SELECT t.id, t.date, t.amount, t.description, t.currency FROM purch_transaction t LEFT JOIN purch_receipt x ON x.transaction_id = t.id
    WHERE x.id IS NULL AND t.currency = ? AND t.amount < 0 AND ABS(-t.amount - ?) <= 1 AND t.date BETWEEN ? AND ? ORDER BY ABS(julianday(t.date) - julianday(?))`)
    .all(r.currency, r.total, H.addDays(r.date, -7), H.addDays(r.date, 7), r.date)
    .map(t => ({ ...t, amount_display: money(t.amount, t.currency) }));
}

/** The words in use: statuses with meaning, the person's categories and vendors — what an agent proposes from. */
function vocabulary() {
  const statuses = [
    { status: 'purchase', means: 'one-off spending — counted in spend' },
    { status: 'recurring', means: 'spending that repeats (rent, streaming, insurance) — counted in spend; with a vendor it declares the subscription' },
    { status: 'transfer', means: "the person's own money moving: card payoffs, brokerage, loans, own accounts — not spend" },
    { status: 'income', means: 'money in: salary, refunds, payments received' },
    { status: 'fee', means: "the bank's charge" },
    { status: 'ignored', means: 'not theirs to track' },
  ];
  const categories = db().prepare("SELECT category, COUNT(*) n, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) spend FROM purch_transaction WHERE category IS NOT NULL GROUP BY category COLLATE NOCASE ORDER BY n DESC").all();
  const vendors = db().prepare('SELECT v.id, v.name, COUNT(t.id) rows FROM purch_vendor v LEFT JOIN purch_transaction t ON t.vendor_id = v.id GROUP BY v.id ORDER BY v.name COLLATE NOCASE').all()
    .map(v => ({ ...v, aliases: db().prepare('SELECT alias FROM purch_vendor_alias WHERE vendor_id = ?').all(v.id).map(a => a.alias) }));
  const subs = db().prepare("SELECT s.id, v.name AS vendor, s.cadence, s.amount, s.currency, s.status FROM purch_subscription s JOIN purch_vendor v ON v.id = s.vendor_id ORDER BY v.name").all();
  const unreviewed = db().prepare("SELECT COUNT(*) n FROM purch_transaction WHERE status = 'unreviewed'").get().n;
  const standing = activeRules().map(r => ({ id: r.id, label: r.label, category: r.category, status: r.status, window: windowText(r), match: r.match || null, vendor: r.vendor || null }));
  return { statuses, cadences: ['weekly', 'monthly', 'yearly'], categories, vendors, subscriptions: subs, rules: standing, unreviewed,
    note: categories.length ? 'Propose from these categories and vendors first; a new word is fine when nothing fits, but say it is new.' : 'No categories yet — propose plain words and let the person rename them before writing.' };
}

/**
 * The spending side of the journal, contributed by this module (core stitches the areas
 * together). One entry per reviewed row, so every posting traces to a statement line:
 *   spending  → debit the category, credit the account it was paid from
 *   fee       → debit Bank Fees, credit that account
 *   income    → debit that account, credit the category
 * A transfer is the person's own money moving between their own accounts, so it posts
 * nothing; neither does an unreviewed or ignored row. Categories and statement accounts are
 * the person's words: the ledger bridge maps each onto their chart, and refuses to export
 * while one is unmapped.
 */
const splitsOf = (id) => { try { return db().prepare('SELECT amount, category, note FROM purch_split WHERE transaction_id = ? ORDER BY pos').all(id); } catch { return []; } };

function journalLines({ from, to } = {}) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  let rows = [];
  try {
    rows = db().prepare(`SELECT t.*, v.name AS vendor, COALESCE((SELECT a.name FROM purch_account a WHERE a.id = s.account_id), s.account) AS source_account, s.kind AS source_kind
      FROM purch_transaction t LEFT JOIN purch_vendor v ON v.id = t.vendor_id JOIN purch_source s ON s.id = t.source_id
      WHERE t.status IN ('purchase','recurring','fee','income','transfer') ORDER BY t.date, t.id`).all();
  } catch { return []; }
  const out = [];
  // A row that paid a bill kept on the accrual basis (a bill on a purchase order) clears
  // Accounts Payable: the spending was booked when the bill was approved, not again here.
  const paysAccrued = new Map();
  try { for (const b of db().prepare('SELECT id, transaction_id FROM purch_bill WHERE transaction_id IS NOT NULL').all()) if (onAccrual(b.id)) paysAccrued.set(b.transaction_id, b.id); } catch { /* no bills yet */ }
  const pi = pairIndex();
  for (const t of rows) {
    if (!inRange(t.date)) continue;
    const acct = (t.source_account || `${t.source_kind || 'account'} (unnamed)`).trim();
    const paidFrom = { account: acct, map: { kind: 'source', key: acct } };
    const amount = Math.abs(t.amount);
    const who = t.vendor || t.description;
    // P-16: a paired transfer posts once, on its out side, from one account straight into the other.
    const pr = pi.get(t.id);
    if (pr && pr.side === 'in') continue;
    if (pr && pr.side === 'out') {
      const to = rowWithAccount(pr.pair.in_tx).account_name;
      out.push({ date: t.date, memo: `Transfer ${pr.pair.id} · ${acct} to ${to}`, customer: null, currency: t.currency, source: t.id,
        lines: [{ account: to, map: { kind: 'source', key: to }, debit: amount }, { ...paidFrom, credit: amount }] });
      continue;
    }
    if (t.status === 'fee') {
      out.push({ date: t.date, memo: `Fee · ${t.description}`, customer: null, currency: t.currency, source: t.id,
        lines: [{ account: 'Bank Fees', debit: amount }, { ...paidFrom, credit: amount }] });
    } else if (t.status === 'transfer') {
      // A transfer is real money leaving or entering this account: it must post, or the ledger's
      // bank balance stops tying to the statement. The category names the other side (savings,
      // owner draw, the card being paid off). With no other side named it posts nothing and is
      // reported as left out — which is also how money already recorded elsewhere in these books
      // (a customer payment against an invoice) stays out without being counted twice.
      const cat = (t.category || '').trim();
      if (!cat) continue;
      const other = { account: cat, map: { kind: 'category', key: cat, role: 'transfer' } };
      out.push({ date: t.date, memo: `Transfer · ${t.description}`, customer: null, currency: t.currency, source: t.id,
        lines: t.amount < 0 ? [{ ...other, debit: amount }, { ...paidFrom, credit: amount }] : [{ ...paidFrom, debit: amount }, { ...other, credit: amount }] });
    } else if (t.status === 'income') {
      const cat = (t.category || '').trim();
      const legs = splitsOf(t.id);
      const credits = legs.length
        ? legs.map(l => ({ account: l.category, map: { kind: 'category', key: l.category, role: 'income' }, credit: l.amount }))
        : [{ account: cat || 'Uncategorised income', map: { kind: 'category', key: cat || '(uncategorised)', role: 'income' }, credit: amount }];
      out.push({ date: t.date, memo: `Received · ${who}`, customer: t.vendor || null, currency: t.currency, source: t.id,
        lines: [{ ...paidFrom, debit: amount }, ...credits] });
    } else if (paysAccrued.has(t.id) && t.amount < 0) {
      out.push({ date: t.date, memo: `Paid ${paysAccrued.get(t.id)} · ${who}`, customer: t.vendor || null, currency: t.currency, source: t.id,
        lines: [{ account: 'Accounts Payable', debit: amount }, { ...paidFrom, credit: amount }] });
    } else {
      // A split row posts one leg per part, all against the one account the money moved on.
      const legs = splitsOf(t.id);
      const cat = (t.category || '').trim();
      const debits = legs.length
        ? legs.map(l => ({ account: l.category, map: { kind: 'category', key: l.category, role: 'expense' }, debit: l.amount }))
        : [{ account: cat || 'Uncategorised spending', map: { kind: 'category', key: cat || '(uncategorised)', role: 'expense' }, debit: amount }];
      out.push({ date: t.date, memo: `${who}${t.ref ? ' · ' + t.ref : ''}`, customer: t.vendor || null, currency: t.currency, source: t.id,
        lines: [...debits, { ...paidFrom, credit: amount }] });
    }
  }
  return out;
}

/**
 * Rows an imported statement carries that post nothing, and why. An export that quietly left
 * these out would break the one control an accountant has: the ledger's bank balance tying to
 * the statement. So they are named, with their value, every time.
 */
/**
 * The statement accounts as the statements print them: for each account, the opening balance
 * of its earliest statement and the closing balance of every statement, in signed minor units
 * (money in positive; a card owing money is negative). The journal only holds movements since
 * the first import, so preliminary statements take the starting point from here (bridge B-12).
 */
function statementAccounts() {
  let rows = [];
  // The register's name for the account, so every statement of one account is one account here too.
  try { rows = db().prepare('SELECT s.*, COALESCE(a.name, s.account) AS account FROM purch_source s LEFT JOIN purch_account a ON a.id = s.account_id ORDER BY s.period_start, s.id').all(); } catch { return []; }
  const by = {};
  for (const s of rows) {
    const account = (s.account || `${s.kind || 'account'} (unnamed)`).trim();
    const k = `${account}|${s.currency}`;
    if (!by[k]) by[k] = { account, currency: s.currency, kind: s.kind, first_start: s.period_start, opening: s.opening_balance, statements: [] };
    by[k].kind = s.kind || by[k].kind;
    by[k].statements.push({ id: s.id, period_start: s.period_start, period_end: s.period_end, opening: s.opening_balance, closing: s.closing_balance });
  }
  return Object.values(by);
}

/**
 * Rows another area has tied to money already recorded in these books (bankrec's matches), as
 * id -> what they were matched to. Such a row posts nothing (the payment did) and is not left out.
 */
function matchedRows() {
  const m = new Map();
  for (const mod of require('../../registry.js').MODULES) if (mod.api && typeof mod.api.statementRowMatches === 'function') for (const [k, v] of mod.api.statementRowMatches()) m.set(k, v);
  return m;
}
const posts = (t) => ['purchase', 'recurring', 'fee', 'income'].includes(t.status) || (t.status === 'transfer' && !!String(t.category || '').trim());

/** Every statement row with its account and whether it posts, for the bank reconciliation. */
function statementRows() {
  let rows = [];
  try { rows = db().prepare(`SELECT t.*, s.account_id, COALESCE((SELECT a.name FROM purch_account a WHERE a.id = s.account_id), s.account) AS source_account, s.kind AS source_kind, s.period_end AS source_end FROM purch_transaction t JOIN purch_source s ON s.id = t.source_id ORDER BY t.date, t.id`).all(); }
  catch (e) { if (/no such table/i.test(e.message)) return []; throw e; }
  const pi = pairIndex();   // a paired transfer is in the books once, through its out side (P-16)
  return rows.map(t => ({ ...t, account: (t.source_account || `${t.source_kind || 'account'} (unnamed)`).trim(), posts: posts(t) || pi.has(t.id), paired: pi.has(t.id) ? pi.get(t.id).pair.id : null, amount_display: money(t.amount, t.currency) }));
}

function journalOmitted({ from, to } = {}) {
  try {
    const matched = matchedRows(), pi = pairIndex();
    const w = ["(t.status = 'unreviewed' OR (t.status = 'transfer' AND COALESCE(TRIM(t.category), '') = '') OR t.status = 'ignored')"]; const args = [];
    if (from) { w.push('t.date >= ?'); args.push(from); }
    if (to) { w.push('t.date <= ?'); args.push(to); }
    return db().prepare(`SELECT t.id, t.date, t.description, t.amount, t.currency, t.status, COALESCE((SELECT a.name FROM purch_account a WHERE a.id = s.account_id), s.account) AS source_account
      FROM purch_transaction t JOIN purch_source s ON s.id = t.source_id WHERE ${w.join(' AND ')} ORDER BY t.date, t.id`).all(...args)
      .map(r => ({ ...r, amount_display: money(r.amount, r.currency),
        why: r.status === 'unreviewed' ? 'nobody has said what it is yet'
          : r.status === 'ignored' ? 'reviewed as not theirs to track'
          : 'a transfer with no other side named — say where the money went and it posts' }))
      .filter(r => !matched.has(r.id) && !pi.has(r.id));
  } catch (e) {
    // No purchases tables in this space is the only expected miss; anything else is a bug and
    // must not be hidden — an export that silently reports "nothing left out" would be a lie.
    if (/no such table/i.test(e.message)) return [];
    console.error('[purchases] journalOmitted:', e.message);
    throw e;
  }
}

/** The words the ledger has to have a chart account for: every category and statement account in use. */
function mappableKeys() {
  const cats = (() => { try { return db().prepare(`SELECT DISTINCT k FROM (
      SELECT COALESCE(NULLIF(TRIM(category), ''), '(uncategorised)') k FROM purch_transaction WHERE status IN ('purchase','recurring','income')
      UNION SELECT TRIM(category) k FROM purch_split
      UNION SELECT TRIM(category) k FROM purch_transaction WHERE status = 'transfer' AND COALESCE(TRIM(category), '') <> '')`).all(); } catch { return []; } })();
  const srcs = (() => { try { return db().prepare('SELECT DISTINCT account k, kind FROM purch_source').all(); } catch { return []; } })();
  return { categories: [...new Set(cats.map(c => c.k))].sort(), sources: [...new Set(srcs.map(s => (s.k || `${s.kind} (unnamed)`).trim()))].sort() };
}

// ---------------------------------------------------------------- accounts and net worth (0.6)
const ACCOUNT_KINDS = ['checking', 'savings', 'credit_card', 'loan', 'asset', 'other'];
// Which statements an account can carry: a card's statements are card statements, and so on.
// An asset (a house, a car) has no statements; its value is what a person states.
const STATEMENT_KIND = { checking: ['bank'], savings: ['bank'], credit_card: ['card'], loan: ['other'], other: ['bank', 'card', 'other'], asset: [] };
const accountKindFor = (sourceKind) => ({ bank: 'checking', card: 'credit_card' }[sourceKind] || 'other');
const STALE_DAYS = 45;

const accountRow = (id) => H.need('purch_account', id, 'account');
const statementsOf = (accountId) => { try { return db().prepare('SELECT * FROM purch_source WHERE account_id = ? ORDER BY period_start, id').all(accountId); } catch { return []; } };
const valuationsOf = (accountId) => { try { return db().prepare('SELECT * FROM purch_valuation WHERE account_id = ? ORDER BY as_of, id').all(accountId); } catch { return []; } };

/** P-13: statements chain; a gap, an overlap or an opening that is not the last closing is named. */
function chainIssues(stmts, cur) {
  const out = [];
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1], b = stmts[i];
    if (b.period_start > H.addDays(a.period_end, 1)) out.push({ kind: 'gap', after: a.id, before: b.id, text: `No statement for ${H.addDays(a.period_end, 1)} to ${H.addDays(b.period_start, -1)}.` });
    else if (b.period_start <= a.period_end) out.push({ kind: 'overlap', after: a.id, before: b.id, text: `${b.id} starts ${b.period_start}, before ${a.id} ends (${a.period_end}).` });
    if (b.opening_balance !== a.closing_balance) out.push({ kind: 'jump', after: a.id, before: b.id, text: `${b.id} opens at ${money(b.opening_balance, cur)}; ${a.id} closed at ${money(a.closing_balance, cur)}.` });
  }
  return out;
}

/** P-14: a balance is what a statement printed or a value a person stated, with its date; never extrapolated. */
function balanceOf(acc, asOf) {
  const st = statementsOf(acc.id).filter(x => x.period_end <= asOf).pop();
  const va = valuationsOf(acc.id).filter(x => x.as_of <= asOf).pop();
  const fromSt = st && { balance: st.closing_balance, as_of: st.period_end, from: `statement ${st.id}` };
  const fromVa = va && { balance: va.value, as_of: va.as_of, from: `stated: ${va.source}` };
  return (fromSt && fromVa) ? (fromVa.as_of > fromSt.as_of ? fromVa : fromSt) : (fromSt || fromVa || null);
}

function accountView(id, asOf = today()) {
  const acc = accountRow(id);
  const stmts = statementsOf(acc.id), vals = valuationsOf(acc.id);
  const b = balanceOf(acc, asOf);
  const issues = chainIssues(stmts, acc.currency);
  const stale = b ? Math.floor((Date.parse(asOf) - Date.parse(b.as_of)) / 864e5) : null;
  return { ...acc, status: acc.closed_on && acc.closed_on <= asOf ? 'closed' : 'open', nature: ['credit_card', 'loan'].includes(acc.kind) ? 'owed' : 'held',
    balance: b ? b.balance : null, balance_display: b ? money(b.balance, acc.currency) : null, balance_as_of: b ? b.as_of : null, balance_from: b ? b.from : null,
    stale_days: stale, stale: stale != null && stale > STALE_DAYS, closed: !!(acc.closed_on && acc.closed_on <= asOf),
    statements: stmts.map(x => ({ id: x.id, name: x.name, period_start: x.period_start, period_end: x.period_end, opening: x.opening_balance, closing: x.closing_balance,
      opening_display: money(x.opening_balance, acc.currency), closing_display: money(x.closing_balance, acc.currency), rows: x.rows_in })),
    valuations: vals.map(v => ({ ...v, value_display: money(v.value, acc.currency) })), issues };
}

function accounts({ as_of } = {}) {
  const day = as_of || today();
  let rows = []; try { rows = db().prepare('SELECT id FROM purch_account ORDER BY id').all(); } catch { return { as_of: day, count: 0, items: [] }; }
  const order = Object.fromEntries(ACCOUNT_KINDS.map((k, i) => [k, i]));
  const items = rows.map(r => accountView(r.id, day)).sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
  return { as_of: day, count: items.length, issues: items.reduce((n, a) => n + a.issues.length, 0), items };
}

/** P-15: net worth per currency, what is held less what is owed, each line with its date. */
function netWorth({ as_of } = {}) {
  const day = as_of || today();
  const all = accounts({ as_of: day }).items.filter(a => !a.closed && !(a.opened_on && a.opened_on > day));
  const by = {};
  for (const a of all) {
    const c = by[a.currency] = by[a.currency] || { currency: a.currency, held: [], owed: [], unknown: [] };
    const line = { account_id: a.id, name: a.name, kind: a.kind, balance: a.balance, balance_display: a.balance_display, as_of: a.balance_as_of, from: a.balance_from, stale: a.stale, stale_days: a.stale_days };
    if (a.balance == null) c.unknown.push(line); else if (a.balance >= 0) c.held.push(line); else c.owed.push(line);
  }
  const sum = (xs) => xs.reduce((n, x) => n + x.balance, 0);
  const currencies = Object.values(by).map(c => {
    const held = sum(c.held), owed = -sum(c.owed), net = held - owed;
    const stale = [...c.held, ...c.owed].filter(x => x.stale);
    return { ...c, held_total: held, held_display: money(held, c.currency), owed_total: owed, owed_display: money(owed, c.currency), net, net_display: money(net, c.currency),
      note: `Net worth ${money(net, c.currency)} as of ${day}: ${money(held, c.currency)} held, ${money(owed, c.currency)} owed.`
        + (stale.length ? ` ${stale.length} figure${stale.length === 1 ? ' is' : 's are'} more than ${STALE_DAYS} days old (${stale.map(x => `${x.name}, ${x.as_of}`).join('; ')}).` : '')
        + (c.unknown.length ? ` No balance yet for ${c.unknown.map(x => x.name).join(', ')}.` : '') };
  });
  const one = currencies.length === 1 ? currencies[0] : null;
  return { as_of: day, currencies, ...(one ? { currency: one.currency, net: one.net, net_display: one.net_display, held_total: one.held_total, owed_total: one.owed_total } : {}), note: currencies.length ? currencies.map(c => c.note).join(' ') : 'No accounts yet. Import a statement, or add an account and state its value.' };
}

// ---------------------------------------------------------------- transfers between own accounts (0.7)
const activePairs = () => { try { return db().prepare('SELECT * FROM purch_transfer WHERE unpaired_at IS NULL ORDER BY id').all(); } catch { return []; } };
/** tx id -> { pair, side } for every row in an active pair (P-16). */
function pairIndex() { const m = new Map(); for (const p of activePairs()) { m.set(p.out_tx, { pair: p, side: 'out' }); m.set(p.in_tx, { pair: p, side: 'in' }); } return m; }
const rowWithAccount = (id) => db().prepare(`SELECT t.*, s.account_id, COALESCE(a.name, s.account) AS account_name, a.last4 FROM purch_transaction t JOIN purch_source s ON s.id = t.source_id
  LEFT JOIN purch_account a ON a.id = s.account_id WHERE t.id = ?`).get(id);
const brief = (t) => t && { id: t.id, date: t.date, amount: t.amount, amount_display: money(t.amount, t.currency), description: t.description, account_id: t.account_id, account: t.account_name };

function transferView(id) {
  const p = need('purch_transfer', id, 'transfer');
  const o = rowWithAccount(p.out_tx), i = rowWithAccount(p.in_tx);
  return { ...p, name: `${o.account_name} to ${i.account_name}`, state: p.unpaired_at ? 'unpaired' : 'paired', status: p.unpaired_at ? 'unpaired' : 'paired', amount: -o.amount, amount_display: money(-o.amount, o.currency),
    out: brief(o), in: brief(i), out_was: JSON.parse(p.out_was || '{}'), in_was: JSON.parse(p.in_was || '{}') };
}

const PAY_WORDS = /\b(payment|pmt|transfer|xfer|thank you|autopay|epay|online pmt|to card|from chk|from checking|to savings|from savings)\b/i;
/** P-17: suggestions only. Each money-out row and a money-in row of the same size in another of the person's accounts, close in time. */
function transferCandidates({ account_id } = {}) {
  const pi = pairIndex(), held = matchedRows();
  const rows = statementRows().filter(t => !pi.has(t.id) && !held.has(t.id) && (t.status === 'unreviewed' || t.status === 'transfer') && t.account_id);
  let billPaid = new Set(); try { billPaid = new Set(db().prepare('SELECT transaction_id FROM purch_bill WHERE transaction_id IS NOT NULL').all().map(r => r.transaction_id)); } catch { /* none */ }
  const free = rows.filter(t => !billPaid.has(t.id) && !splitsOf(t.id).length);
  const accs = new Map(); try { for (const a of db().prepare('SELECT * FROM purch_account').all()) accs.set(a.id, a); } catch { /* none */ }
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const options = [];
  for (const o of free.filter(t => t.amount < 0)) for (const i of free.filter(t => t.amount === -o.amount && t.currency === o.currency && t.account_id !== o.account_id)) {
    const d = days(o.date, i.date); if (d < -3 || d > 7) continue;
    const ai = accs.get(i.account_id) || {}, ao = accs.get(o.account_id) || {};
    const named = (ai.last4 && o.description.includes(ai.last4)) || (ao.last4 && i.description.includes(ao.last4));
    const words = PAY_WORDS.test(o.description) || PAY_WORDS.test(i.description);
    options.push({ o, i, d, score: (named ? 6 : 0) + (words ? 3 : 0) - Math.abs(d),
      why: `same amount, ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} apart${named ? ', the account number in the description' : ''}${words ? ', worded as a payment or transfer' : ''}` });
  }
  options.sort((a, b) => b.score - a.score);
  const used = new Set(), out = [];
  for (const x of options) {
    if (used.has(x.o.id) || used.has(x.i.id)) continue;
    if (account_id && x.o.account_id !== account_id && x.i.account_id !== account_id) continue;
    used.add(x.o.id); used.add(x.i.id);
    out.push({ out: brief({ ...x.o, account_name: x.o.account }), in: brief({ ...x.i, account_name: x.i.account }), amount_display: money(-x.o.amount, x.o.currency), why: x.why });
  }
  return { count: out.length, items: out, note: out.length ? `${out.length} move${out.length === 1 ? '' : 's'} between your accounts could be paired. Suggestions only: show the person, then pair with purch_pair_transfer and a reason.` : 'Nothing waiting to be paired.' };
}

/** P-18: rows reviewed as a transfer to or from one of the person's accounts, with no other half paired yet. */
function oneSided() {
  const pi = pairIndex(), held = matchedRows();
  const suggested = new Map(); for (const c of transferCandidates().items) { suggested.set(c.out.id, c.in.id); suggested.set(c.in.id, c.out.id); }
  let accs = []; try { accs = db().prepare('SELECT * FROM purch_account').all(); } catch { return []; }
  const byName = new Map(accs.map(a => [a.name.toLowerCase(), a]));
  return statementRows().filter(t => t.status === 'transfer' && !pi.has(t.id) && !held.has(t.id) && t.category && byName.has(String(t.category).trim().toLowerCase())).map(t => {
    const other = byName.get(String(t.category).trim().toLowerCase());
    const st = statementsOf(other.id);
    const covered = st.some(s => s.period_start <= t.date && s.period_end >= H.addDays(t.date, 5));
    const before = st.length && t.date < st[0].period_start;
    return { ...brief({ ...t, account_name: t.account }), other_account_id: other.id, other_account: other.name,
      state: suggested.has(t.id) ? `its other half looks like ${suggested.get(t.id)}, suggested for pairing` : !st.length ? 'no statements for that account yet' : before ? 'before that account\'s first statement' : covered ? 'the other half is missing from that account\'s statement' : 'waiting for that account\'s next statement',
      missing: covered && !suggested.has(t.id) };
  });
}

function transfers() {
  const pairs = activePairs().map(p => transferView(p.id)).reverse();
  const one = oneSided();
  const cands = transferCandidates();
  return { count: pairs.length, pairs, one_sided: one, one_sided_missing: one.filter(x => x.missing).length, suggestions: cands.count,
    note: `${pairs.length ? `${pairs.length} transfer${pairs.length === 1 ? '' : 's'} paired.` : 'No transfers paired yet.'}${cands.count ? ` ${cands.count} could be paired.` : ''}${one.length ? ` ${one.length} one-sided, ${one.filter(x => x.missing).length} with the other half missing from a statement that should show it.` : ''}` };
}

module.exports = { pairIndex, transferView, transferCandidates, oneSided, transfers, rowWithAccount, ACCOUNT_KINDS, STATEMENT_KIND, accountKindFor, accountView, accounts, netWorth, statementsOf, chainIssues, balanceOf, matchedRows, statementRows, billView, bills, payables, unpaidBills, approvalHold, onAccrual, statementAccounts, activeRules, ruleMatches, suggestionFor, ruleView, rules, windowText, splitsOf, journalLines, journalOmitted, mappableKeys, vocabulary, transactionView, receiptView, subscriptionView, subscriptions, transactions, purchases, receipts, sources, sourceView, receiptCandidates, addPeriod, norm, vendorName };
