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

function transactionView(id) {
  const t = need('purch_transaction', id, 'transaction');
  const receipt = db().prepare('SELECT id, name, total, date FROM purch_receipt WHERE transaction_id = ?').get(id) || null;
  return { ...t, vendor: vendorName(t.vendor_id), amount_display: money(t.amount, t.currency), spend: t.amount < 0 ? -t.amount : 0, receipt, source_name: (get('purch_source', t.source_id) || {}).name || null };
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
  const items = rows.map(r => ({ ...r, amount_display: money(r.amount, r.currency), has_receipt: !!r.receipt_id }));
  const unreviewed = items.filter(i => i.status === 'unreviewed').length;
  return { count: items.length, unreviewed, items, spend_by_currency: spendOf(items.filter(i => i.status === 'purchase' || i.status === 'recurring' || (i.status === 'unreviewed' && i.amount < 0))) };
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
    .map(r => ({ ...r, amount_display: money(r.amount, r.currency) }));
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
  return { statuses, cadences: ['weekly', 'monthly', 'yearly'], categories, vendors, subscriptions: subs, unreviewed,
    note: categories.length ? 'Propose from these categories and vendors first; a new word is fine when nothing fits, but say it is new.' : 'No categories yet — propose plain words and let the person rename them before writing.' };
}

module.exports = { vocabulary, transactionView, receiptView, subscriptionView, subscriptions, transactions, purchases, receipts, sources, sourceView, receiptCandidates, addPeriod, norm, vendorName };
