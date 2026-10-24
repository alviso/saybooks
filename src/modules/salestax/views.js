'use strict';
/**
 * Sales tax: the return for a period, derived from what was invoiced and credited (o2c, solo, each
 * through its api), the filings people record, the payments that follow, and the liability in the
 * books beside it. Only filings and payments are stored; every figure is derived.
 */
const crypto = require('crypto');
const H = require('../../db.js');
const { Rejected } = require('../../registry.js');
const db = () => H.db();
const cur0 = () => H.locale().currency || 'USD';
const money = (c, cur) => (c == null ? null : H.money(c, cur || cur0()));
const MODULES = () => require('../../registry.js').MODULES;
const pct = (bp) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}%`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-09", "2026-Q3", "2026", or from/to. */
function periodOf({ period, from, to } = {}) {
  if (period) {
    const p = String(period).trim().toUpperCase();
    let m;
    if ((m = /^(\d{4})-(\d{2})$/.exec(p))) { const y = +m[1], mo = +m[2]; if (mo < 1 || mo > 12) throw new Rejected(`${period} is not a month.`); return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${lastDay(y, mo)}`, label: `${MONTHS[mo - 1]} ${y}` }; }
    if ((m = /^(\d{4})-Q([1-4])$/.exec(p))) { const y = +m[1], q = +m[2], mo = q * 3; return { from: `${y}-${String(mo - 2).padStart(2, '0')}-01`, to: `${y}-${String(mo).padStart(2, '0')}-${lastDay(y, mo)}`, label: `Q${q} ${y}` }; }
    if ((m = /^(\d{4})$/.exec(p))) return { from: `${p}-01-01`, to: `${p}-12-31`, label: p };
    throw new Rejected(`A period is a month (2026-09), a quarter (2026-Q3) or a year (2026); or pass from and to.`);
  }
  if (!from || !to) throw new Rejected('Say which period: period (2026-09, 2026-Q3) or from and to.');
  if (from > to) throw new Rejected(`The period ends before it starts: ${to} is before ${from}.`);
  return { from, to, label: `${from} to ${to}` };
}

function taxData() {
  const lines = [], credits = [];
  for (const m of MODULES()) if (m.api && typeof m.api.salesTaxLines === 'function') { const d = m.api.salesTaxLines() || {}; lines.push(...(d.lines || [])); credits.push(...(d.credits || [])); }
  return { lines, credits };
}

/** TAX-2: what was charged and given back in a period, and what that leaves due. */
function figures(from, to, currency, data = taxData()) {
  const inP = (d) => d >= from && d <= to;
  const ls = data.lines.filter(l => l.currency === currency && inP(l.date));
  const cs = data.credits.filter(c => c.currency === currency && inP(c.date));
  const sum = (xs, k) => xs.reduce((n, x) => n + x[k], 0);
  const rates = {};
  for (const l of ls.filter(x => x.rate_bp > 0)) { const r = rates[l.rate_bp] = rates[l.rate_bp] || { rate_bp: l.rate_bp, base: 0, tax: 0, lines: 0 }; r.base += l.net; r.tax += l.tax; r.lines++; }
  const given = cs.filter(c => c.kind !== 'write_off');
  const writeOffs = cs.filter(c => c.kind === 'write_off');
  const collected = sum(ls, 'tax'), back = sum(given, 'tax');
  return { from, to, currency, gross: sum(ls, 'net'), nontaxable: sum(ls.filter(x => !x.rate_bp), 'net'), taxable: sum(ls.filter(x => x.rate_bp > 0), 'net'),
    by_rate: Object.values(rates).sort((a, b) => a.rate_bp - b.rate_bp), collected, credits_net: sum(given, 'net'), credits_tax: back, due: collected - back,
    documents: [...new Set(ls.filter(x => x.tax).map(x => x.doc))].length, credit_docs: given.map(c => c.doc), write_offs: writeOffs.map(c => ({ doc: c.doc, invoice_id: c.invoice_id, total: c.total })) };
}

const keptOf = (f) => ({ from: f.from, to: f.to, currency: f.currency, gross: f.gross, nontaxable: f.nontaxable, taxable: f.taxable, by_rate: f.by_rate.map(r => [r.rate_bp, r.base, r.tax]), collected: f.collected, credits_tax: f.credits_tax, due: f.due });
const hashOf = (k) => crypto.createHash('sha256').update(JSON.stringify(k)).digest('hex').slice(0, 16);

const filingRows = () => { try { return db().prepare('SELECT * FROM tax_filing ORDER BY period_from, id').all(); } catch { return []; } };
const paymentRows = (filingId) => { try { return filingId ? db().prepare('SELECT * FROM tax_payment WHERE filing_id = ? ORDER BY paid_on, id').all(filingId) : db().prepare('SELECT * FROM tax_payment ORDER BY paid_on, id').all(); } catch { return []; } };

function filingView(id, data = taxData()) {
  const r = H.need('tax_filing', id, 'filing');
  const kept = JSON.parse(r.kept_json);
  const now = figures(r.period_from, r.period_to, r.currency, data);
  const pays = paymentRows(r.id);
  const paid = pays.reduce((n, p) => n + p.amount, 0);
  const change = now.due - kept.due;
  return { ...r, name: `${r.label || `${r.period_from} to ${r.period_to}`}`, kept, computed_due_display: money(r.computed_due, r.currency), filed_amount_display: money(r.filed_amount, r.currency),
    paid, paid_display: money(paid, r.currency), balance: r.filed_amount - paid, balance_display: money(r.filed_amount - paid, r.currency),
    payments: pays.map(p => ({ ...p, amount_display: money(p.amount, r.currency) })),
    changed_since: hashOf(keptOf(now)) !== r.hash, change, change_display: money(change, r.currency),
    state: r.filed_amount - paid > 0 ? 'filed, not paid' : 'filed and paid' };
}

/** The return for a period: its own figures, plus changes to periods already filed, named. */
function taxReturn(a = {}) {
  const per = periodOf(a);
  const currency = a.currency ? String(a.currency).toUpperCase() : cur0();
  const data = taxData();
  const f = figures(per.from, per.to, currency, data);
  const filed = filingRows().filter(r => r.currency === currency);
  const covering = filed.find(r => r.period_from <= per.from && r.period_to >= per.to) || null;
  const overlap = filed.filter(r => r.period_from <= per.to && r.period_to >= per.from);
  // TAX-4: a filed period the record now says differently about; the difference goes on the next return.
  const changes = filed.filter(r => r.period_to < per.from).map(r => filingView(r.id, data)).filter(v => v.change)
    .map(v => ({ filing_id: v.id, period: v.name, kept_due: v.kept.due, now_due: v.kept.due + v.change, change: v.change, change_display: v.change_display }));
  const changeTotal = changes.reduce((n, c) => n + c.change, 0);
  const notes = [];
  if (f.write_offs.length) notes.push(`${f.write_offs.length} invoice${f.write_offs.length === 1 ? ' was' : 's were'} written off in the period; the tax on ${f.write_offs.length === 1 ? 'it' : 'them'} stays in what is due. Bad-debt relief is a claim your accountant makes, not one these books assume.`);
  if (!f.collected && !f.credits_tax) notes.push(`No tax was charged in ${per.label}.`);
  if (per.to >= H.today()) notes.push(`${per.label} has not ended yet: these are the figures so far.`);
  if (changes.length) notes.push(`Periods already filed have changed since: ${changes.map(c => `${c.period} by ${c.change_display}`).join(', ')}. That difference belongs on this return, named, or on an amended one; your accountant decides which.`);
  return { period: per.label, from: per.from, to: per.to, currency,
    gross: f.gross, gross_display: money(f.gross, currency), nontaxable: f.nontaxable, nontaxable_display: money(f.nontaxable, currency), taxable: f.taxable, taxable_display: money(f.taxable, currency),
    by_rate: f.by_rate.map(r => ({ ...r, rate: pct(r.rate_bp), base_display: money(r.base, currency), tax_display: money(r.tax, currency) })),
    tax_collected: f.collected, tax_collected_display: money(f.collected, currency), credits_net: f.credits_net, credits_tax: f.credits_tax, credits_tax_display: money(f.credits_tax, currency), credit_docs: f.credit_docs,
    due: f.due, due_display: money(f.due, currency), prior_changes: changes, prior_changes_total: changeTotal, due_with_changes: f.due + changeTotal, due_with_changes_display: money(f.due + changeTotal, currency),
    write_offs: f.write_offs, filed: covering ? filingView(covering.id, data) : null, overlaps: covering ? [] : overlap.map(r => r.id),
    ended: per.to < H.today(), notes,
    note: `${per.label}: ${money(f.taxable, currency)} of taxable sales${f.by_rate.length ? ` (${f.by_rate.map(r => `${pct(r.rate_bp)} on ${money(r.base, currency)}`).join(', ')})` : ''} and ${money(f.nontaxable, currency)} not taxed. Tax charged ${money(f.collected, currency)}${f.credits_tax ? `, less ${money(f.credits_tax, currency)} given back on credits` : ''}: ${money(f.due, currency)} due${changeTotal ? `, ${money(changeTotal, currency)} more for changes to filed periods` : ''}.${covering ? ` Filed as ${covering.id}.` : f.due && per.to < H.today() ? ' Not filed yet.' : ''}` };
}

function filings() {
  const data = taxData();
  const items = filingRows().map(r => filingView(r.id, data)).reverse();
  return { count: items.length, items };
}

const isoMonth = (d) => d.slice(0, 7);
/** TAX-7: the liability in the books beside what the record says is owed, and each month's standing. */
function liability({ as_of } = {}) {
  const day = as_of || H.today();
  const currency = cur0();
  const data = taxData();
  const lines = data.lines.filter(l => l.currency === currency && l.date <= day), credits = data.credits.filter(c => c.currency === currency && c.date <= day && c.kind !== 'write_off');
  const pays = paymentRows().filter(p => p.paid_on <= day && p.currency === currency);
  const charged = lines.reduce((n, l) => n + l.tax, 0), back = credits.reduce((n, c) => n + c.tax, 0), paid = pays.reduce((n, p) => n + p.amount, 0);
  const owed = charged - back - paid;
  const j = require('../core/index.js').journal({ to: day, currency });
  const books = j.entries.flatMap(e => e.lines).filter(l => l.account === 'Sales Tax Payable').reduce((n, l) => n + (l.credit || 0) - (l.debit || 0), 0);
  const filed = filingRows().filter(r => r.currency === currency);
  const months = [...new Set([...lines.map(l => isoMonth(l.date)), ...credits.map(c => isoMonth(c.date))])].sort().reverse();
  const rows = months.map(mo => {
    const per = periodOf({ period: mo });
    const f = figures(per.from, per.to, currency, data);
    const by = filed.find(r => r.period_from <= per.from && r.period_to >= per.to);
    const v = by ? filingView(by.id, data) : null;
    return { month: mo, label: per.label, due: f.due, due_display: money(f.due, currency), filing_id: by ? by.id : null, filed_display: v ? v.filed_amount_display : null, paid_display: v ? v.paid_display : null,
      state: v ? (v.changed_since ? 'changed since filed' : v.state) : per.to >= H.today() ? 'this month, so far' : f.due ? 'not filed' : 'nothing due' };
  });
  const unfiled = rows.filter(r => r.state === 'not filed');
  return { as_of: day, currency, charged, charged_display: money(charged, currency), given_back: back, given_back_display: money(back, currency), paid, paid_display: money(paid, currency),
    owed, owed_display: money(owed, currency), books, books_display: money(books, currency), ties: books === owed, months: rows,
    unfiled: unfiled.map(r => ({ month: r.month, label: r.label, due: r.due, due_display: r.due_display })),
    note: `${money(owed, currency)} of sales tax is owed as of ${day}: ${money(charged, currency)} charged, ${money(back, currency)} given back on credits, ${money(paid, currency)} paid.`
      + (books === owed ? ' Sales Tax Payable in the books says the same.' : ` Sales Tax Payable in the books says ${money(books, currency)}: the ${money(books - owed, currency)} difference is an entry made to that account by hand.`)
      + (unfiled.length ? ` Not filed: ${unfiled.map(r => `${r.label} (${r.due_display})`).join(', ')}.` : '') };
}

/** For gl's checklist: tax for months ended by a day that no filing covers. */
function unfiledThrough(through) {
  try { return liability({ as_of: through }).unfiled.filter(u => periodOf({ period: u.month }).to <= through); } catch { return []; }
}

/** Payments to the tax agency, for bankrec to match to the statement row that shows them. */
function cashMovements() {
  return paymentRows().map(p => {
    const f = H.get('tax_filing', p.filing_id) || {};
    return { key: `salestax:payment:${p.id}`, kind: 'tax payment', id: p.id, date: p.paid_on, amount: -p.amount, currency: p.currency, customer: f.agency || null, reference: p.reference || null,
      label: `Sales tax payment ${p.id} · ${f.label || p.filing_id}${f.agency ? ' · ' + f.agency : ''}${p.reference ? ' · ' + p.reference : ''}` };
  });
}

/** A payment clears the liability; the money left the bank (Cash, which the bank reconciliation ties to the statement). */
function journalLines() {
  return paymentRows().map(p => ({ date: p.paid_on, memo: `Sales tax payment ${p.id} · ${p.filing_id}${p.reference ? ' · ' + p.reference : ''}`, customer: null, currency: p.currency, source: p.id,
    lines: [{ account: 'Sales Tax Payable', debit: p.amount }, { account: 'Cash', credit: p.amount }] }));
}

module.exports = { periodOf, figures, keptOf, hashOf, taxReturn, filingView, filings, filingRows, liability, unfiledThrough, cashMovements, journalLines, pct };
