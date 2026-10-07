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
/** Bills received by a date and not paid by it, for the financials' notes (cash basis). */
function unpaidBills({ as_of, currency } = {}) {
  try {
    const rows = db().prepare(`SELECT amount, currency FROM purch_bill WHERE bill_date <= ? AND status <> 'rejected' AND (paid_at IS NULL OR paid_at > ?) ${currency ? 'AND currency = ?' : ''}`).all(as_of, as_of, ...(currency ? [currency] : []));
    return { count: rows.length, amount: rows.reduce((n, r) => n + r.amount, 0) };
  } catch { return { count: 0, amount: 0 }; }
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
    rows = db().prepare(`SELECT t.*, v.name AS vendor, s.account AS source_account, s.kind AS source_kind
      FROM purch_transaction t LEFT JOIN purch_vendor v ON v.id = t.vendor_id JOIN purch_source s ON s.id = t.source_id
      WHERE t.status IN ('purchase','recurring','fee','income','transfer') ORDER BY t.date, t.id`).all();
  } catch { return []; }
  const out = [];
  for (const t of rows) {
    if (!inRange(t.date)) continue;
    const acct = (t.source_account || `${t.source_kind || 'account'} (unnamed)`).trim();
    const paidFrom = { account: acct, map: { kind: 'source', key: acct } };
    const amount = Math.abs(t.amount);
    const who = t.vendor || t.description;
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
  try { rows = db().prepare('SELECT * FROM purch_source ORDER BY period_start, id').all(); } catch { return []; }
  const by = {};
  for (const s of rows) {
    const account = (s.account || `${s.kind || 'account'} (unnamed)`).trim();
    const k = `${account}|${s.currency}`;
    if (!by[k]) by[k] = { account, currency: s.currency, kind: s.kind, first_start: s.period_start, opening: s.opening_balance, statements: [] };
    by[k].kind = s.kind || by[k].kind;
    by[k].statements.push({ id: s.id, period_start: s.period_start, period_end: s.period_end, closing: s.closing_balance });
  }
  return Object.values(by);
}

function journalOmitted({ from, to } = {}) {
  try {
    const w = ["(t.status = 'unreviewed' OR (t.status = 'transfer' AND COALESCE(TRIM(t.category), '') = '') OR t.status = 'ignored')"]; const args = [];
    if (from) { w.push('t.date >= ?'); args.push(from); }
    if (to) { w.push('t.date <= ?'); args.push(to); }
    return db().prepare(`SELECT t.id, t.date, t.description, t.amount, t.currency, t.status, s.account AS source_account
      FROM purch_transaction t JOIN purch_source s ON s.id = t.source_id WHERE ${w.join(' AND ')} ORDER BY t.date, t.id`).all(...args)
      .map(r => ({ ...r, amount_display: money(r.amount, r.currency),
        why: r.status === 'unreviewed' ? 'nobody has said what it is yet'
          : r.status === 'ignored' ? 'reviewed as not theirs to track'
          : 'a transfer with no other side named — say where the money went and it posts' }));
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

module.exports = { billView, bills, payables, unpaidBills, statementAccounts, activeRules, ruleMatches, suggestionFor, ruleView, rules, windowText, splitsOf, journalLines, journalOmitted, mappableKeys, vocabulary, transactionView, receiptView, subscriptionView, subscriptions, transactions, purchases, receipts, sources, sourceView, receiptCandidates, addPeriod, norm, vendorName };
