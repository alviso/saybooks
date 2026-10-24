'use strict';
/**
 * Closing the books: the checklist for a close, adjusting entries and their reversals, the
 * closes and what they kept, and the corrections the record now asks for. Core's journal asks
 * closedBooks() which periods are closed and puts them back as they were kept (GL-3, GL-4).
 */
const H = require('../../db.js');
const db = () => H.db();
const money = (c, cur) => H.money(c, cur || H.locale().currency || 'USD');
const KINDS = ['asset', 'liability', 'equity', 'income', 'expense'];
const area = (name) => (require('../../registry.js').MODULES.find(m => m.name === name) || {}).api || null;

/** Active closes, oldest first; the last one is the period the books are closed through. */
const activeCloses = () => { try { return db().prepare('SELECT * FROM gl_close WHERE reopened_at IS NULL ORDER BY through, id').all(); } catch { return []; } };
const closedThrough = () => { const c = activeCloses(); return c.length ? c[c.length - 1].through : null; };

function closedBooks() {
  const closes = activeCloses();
  if (!closes.length) return null;
  const entries = db().prepare(`SELECT e.* FROM gl_closed_entry e JOIN gl_close c ON c.id = e.close_id WHERE c.reopened_at IS NULL ORDER BY e.date, e.close_id, e.seq`).all()
    .map(r => ({ date: r.date, memo: r.memo, customer: r.customer, currency: r.currency, lines: JSON.parse(r.lines_json) }));
  return { through: closes[closes.length - 1].through, entries };
}

function entryView(id) {
  const e = H.need('gl_entry', id, 'adjusting entry');
  const lines = db().prepare('SELECT * FROM gl_entry_line WHERE entry_id = ? ORDER BY pos').all(id).map(l => ({ ...l, debit_display: l.debit ? money(l.debit) : '', credit_display: l.credit ? money(l.credit) : '' }));
  const total = lines.reduce((n, l) => n + l.debit, 0);
  return { ...e, name: e.memo, status: e.voided_at ? 'voided' : 'posted', lines, total, total_display: money(total) };
}
const entries = () => { const rows = db().prepare('SELECT id FROM gl_entry ORDER BY date DESC, id DESC').all(); const items = rows.map(r => entryView(r.id)); return { count: items.length, items }; };

/** GL-5/GL-6: adjusting entries, and the reversal of each accrual on the 1st of the next month. */
function journalLines() {
  let rows = []; try { rows = db().prepare('SELECT id FROM gl_entry WHERE voided_at IS NULL ORDER BY date, id').all(); } catch { return []; }
  const derivation = new Set(((area('bridge') || {}).views || { accounts: () => [] }).accounts().map(a => a.account));
  const cur = H.locale().currency || 'USD';
  const out = [];
  for (const r of rows) {
    const e = entryView(r.id);
    const line = (l, flip) => ({ account: l.account, ...(derivation.has(l.account) ? {} : { map: { kind: 'category', key: l.account, role: l.kind } }),
      ...((flip ? l.credit : l.debit) ? { debit: flip ? l.credit : l.debit } : { credit: flip ? l.debit : l.credit }) });
    out.push({ date: e.date, memo: `${e.id} · ${e.memo}`, customer: null, currency: cur, source: e.id, lines: e.lines.map(l => line(l, false)) });
    if (e.reverse_on) out.push({ date: e.reverse_on, memo: `Reversal of ${e.id} · ${e.memo}`, customer: null, currency: cur, source: e.id, lines: e.lines.map(l => line(l, true)) });
  }
  return out;
}

/** GL-7: what stands between the books and a close through this day. */
function checklist({ through }) {
  const last = closedThrough();
  const from = last ? H.addDays(last, 1) : null;
  if (last && through <= last) return { through, from, closed_through: last, ready: false, already_closed: true, blocking: [], open: [],
    note: `The books are already closed through ${last}. Pick a later date to check the next close.` };
  const blocking = [], open = [];
  // Statement rows nobody has reviewed yet, dated in the period.
  try {
    const u = db().prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount), 0) amt FROM purch_transaction WHERE status = 'unreviewed' AND date <= ? ${from ? 'AND date >= ?' : ''}`).get(through, ...(from ? [from] : []));
    if (u.n) blocking.push({ item: 'unreviewed', count: u.n, text: `${u.n} statement row${u.n === 1 ? '' : 's'} in the period ${u.n === 1 ? 'is' : 'are'} not reviewed (${money(u.amt)} net).`, fix: 'Review them in Personal finances, Transactions; suggestions from standing rules are accepted in one step.' });
  } catch { /* no statements */ }
  // Bank and card accounts must tie to their statements at the period's end.
  const bridge = area('bridge');
  if (bridge && bridge.views && bridge.views.financials) {
    try {
      const f = bridge.views.financials({ from: from || '1900-01-01', to: through });
      for (const t of f.ties || []) if (!t.ties) blocking.push({ item: 'ties', account: t.account, text: `${t.account} does not tie: ${t.note}`, fix: 'Usually rows not reviewed yet, or a transfer with no other side named.' });
    } catch (e) { open.push({ item: 'financials', text: `The financials could not be derived: ${e.message}` }); }
  }
  // Open, listed, not blocking.
  try {
    const b = db().prepare("SELECT COUNT(*) n, COALESCE(SUM(amount), 0) amt FROM purch_bill WHERE status = 'open' AND bill_date <= ?").get(through);
    if (b.n) open.push({ item: 'bills', text: `${b.n} bill${b.n === 1 ? '' : 's'} received by ${through} ${b.n === 1 ? 'is' : 'are'} waiting for approval (${money(b.amt)}).`, fix: 'Approve or reject them, or accrue them with an adjusting entry.' });
  } catch { /* no bills */ }
  const p2p = area('p2p');
  if (p2p && p2p.views) { try { const g = p2p.views.unbilled(); const v = Object.values(g.by_currency)[0]; if (g.count) open.push({ item: 'grni', text: `Goods received and not billed: ${v.value_display} on ${g.count} line${g.count === 1 ? '' : 's'}. They are in the books as goods received not invoiced.` }); } catch { /* none */ } }
  const inv = area('inventory');
  if (inv && inv.views) { try { const s = inv.views.stock(); if (s.uncosted_items.length) open.push({ item: 'stock', text: s.note, fix: 'State the opening cost in Inventory.' }); } catch { /* none */ } }
  return { through, from, closed_through: last, ready: blocking.length === 0, blocking, open,
    note: blocking.length ? `${blocking.length} thing${blocking.length === 1 ? '' : 's'} to do before the books can close through ${through}.` : `Nothing blocks a close through ${through}.${open.length ? ` ${open.length} open item${open.length === 1 ? '' : 's'} listed for the record.` : ''}` };
}

/** GL-4: what the record now says differently about closed periods, per account. */
function changes() {
  const j = require('../core/index.js').journal({});
  const corr = j.entries.filter(e => e.correction);
  const lines = corr.flatMap(e => e.lines.map(l => ({ date: e.date, account: l.account, debit: l.debit || 0, credit: l.credit || 0, debit_display: l.debit_display, credit_display: l.credit_display })));
  return { closed_through: closedThrough(), count: lines.length, lines,
    note: lines.length ? `The record has changed since the books were closed through ${closedThrough()}: the differences land on ${corr[0].date}, account by account. The closed period stays as it was.` : 'Nothing has changed in closed periods since they were closed.' };
}

function closes() {
  const rows = db().prepare('SELECT * FROM gl_close ORDER BY through DESC, id DESC').all();
  const ch = changes();
  return { closed_through: closedThrough(), count: rows.length,
    items: rows.map((c, i) => ({ ...c, debits_display: money(c.debits), state: c.reopened_at ? 'reopened' : 'closed', latest: !c.reopened_at && c.through === closedThrough(),
      changed_since: !c.reopened_at && c.through === closedThrough() ? ch.count > 0 : null })) };
}

const lastDayOfPrevMonth = () => { const t = H.today(); return H.addDays(`${t.slice(0, 7)}-01`, -1); };

module.exports = { KINDS, activeCloses, closedThrough, closedBooks, entryView, entries, journalLines, checklist, changes, closes, lastDayOfPrevMonth };
