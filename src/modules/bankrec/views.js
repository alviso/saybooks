'use strict';
/**
 * The bank statement against the books. Statement rows come from the purchases area, payments
 * and refunds from the areas that record them (o2c, solo), each through its api; this area keeps
 * only the matches between them and the sign-offs. The reconciliation is derived every time.
 */
const crypto = require('crypto');
const H = require('../../db.js');
const { Rejected } = require('../../registry.js');
const db = () => H.db();
const money = (c, cur) => (c == null ? null : H.money(c, cur || H.locale().currency || 'USD'));
const MODULES = () => require('../../registry.js').MODULES;
const AREA_WORD = { o2c: 'Orders', solo: 'Invoicing' };
const STALE_DAYS = 10;

const purchases = () => { const m = MODULES().find(x => x.name === 'purchases'); return m ? m.api : null; };
const statementAccounts = () => { const p = purchases(); return p ? p.statementAccounts() : []; };
const statementRows = () => { const p = purchases(); return p ? p.statementRows() : []; };

/** Payments and refunds recorded here, from every area that offers them. */
function cashItems() {
  const out = [];
  for (const m of MODULES()) if (m.api && typeof m.api.cashMovements === 'function') for (const c of m.api.cashMovements() || []) out.push({ ...c, area: m.name });
  // Two areas can both have a P-0001; say which, when both are here.
  if (new Set(out.map(c => c.area)).size > 1) for (const c of out) c.label = `${c.label} (${AREA_WORD[c.area] || c.area})`;
  return out.map(c => ({ ...c, amount_display: money(c.amount, c.currency) }));
}

function activeMatches() {
  let ms = [];
  try { ms = db().prepare('SELECT * FROM bankrec_match WHERE unmatched_at IS NULL ORDER BY id').all(); } catch { return []; }
  const items = db().prepare('SELECT * FROM bankrec_match_item WHERE match_id = ? ORDER BY item_key');
  return ms.map(m => ({ ...m, items: items.all(m.id) }));
}

/** For purchases: statement rows matched to money already recorded here, as id -> what. */
function statementRowMatches() {
  const byKey = new Map(cashItems().map(c => [c.key, c]));
  return activeMatches().map(m => [m.transaction_id, `${m.items.map(i => (byKey.get(i.item_key) || {}).label || i.item_key).join(' + ')} (${m.id})`]);
}

function matchView(id) {
  const m = H.need('bankrec_match', id, 'match');
  const byKey = new Map(cashItems().map(c => [c.key, c]));
  const row = statementRows().find(t => t.id === m.transaction_id) || null;
  const items = db().prepare('SELECT * FROM bankrec_match_item WHERE match_id = ? ORDER BY item_key').all(id)
    .map(i => ({ ...i, amount_display: money(i.amount, row && row.currency), label: (byKey.get(i.item_key) || {}).label || i.item_key, date: (byKey.get(i.item_key) || {}).date || null }));
  return { ...m, id: m.id, name: m.id, state: m.unmatched_at ? 'unmatched' : 'matched', row: row && { id: row.id, date: row.date, description: row.description, account: row.account, amount: row.amount, amount_display: row.amount_display },
    items, row_was: JSON.parse(m.row_was || '{}') };
}

function matches() {
  const all = (() => { try { return db().prepare('SELECT id FROM bankrec_match ORDER BY id DESC').all(); } catch { return []; } })();
  const items = all.map(r => matchView(r.id));
  return { count: items.filter(m => m.state === 'matched').length, items };
}

const findAccount = (name, currency) => {
  const accs = statementAccounts();
  if (!accs.length) throw new Rejected('No statement has been imported yet. Import a bank statement first (purch_import_statement).');
  const n = String(name || '').trim().toLowerCase();
  const hits = accs.filter(a => a.account.toLowerCase() === n && (!currency || a.currency === String(currency).toUpperCase()));
  const loose = hits.length ? hits : accs.filter(a => a.account.toLowerCase().includes(n) && n);
  if (loose.length === 1) return loose[0];
  throw new Rejected(`${loose.length ? 'Which one' : `No statement account called "${name}"`}: ${accs.map(a => `${a.account} (${a.currency})`).join(', ')}.`);
};

/** Each cash item's account: the account of the row it is matched to; unmatched, the only bank account in its currency. */
function placement(accs = statementAccounts(), ms = activeMatches(), rows = statementRows()) {
  const rowOf = new Map(rows.map(r => [r.id, r]));
  const matchedTo = new Map();
  for (const m of ms) for (const i of m.items) matchedTo.set(i.item_key, { match: m, row: rowOf.get(m.transaction_id) });
  const banks = (cur) => accs.filter(a => a.currency === cur && a.kind !== 'card');
  return (item) => {
    const mt = matchedTo.get(item.key);
    if (mt && mt.row) return { account: mt.row.account, currency: mt.row.currency, row: mt.row, match: mt.match };
    const b = banks(item.currency);
    return b.length === 1 ? { account: b[0].account, currency: b[0].currency, row: null, match: null } : null;
  };
}

const why = (t) => t.status === 'unreviewed' ? 'not reviewed yet'
  : t.status === 'ignored' ? 'marked as not theirs to track'
  : 'marked as money already recorded here, but matched to nothing';

/**
 * REC-2: the account through a statement's last day. statement = books - in transit + not in
 * books + timing; whatever is left over is the difference, named.
 */
function reconciliation({ account, currency, through } = {}) {
  const acc = findAccount(account, currency);
  const cur = acc.currency;
  const stmts = acc.statements.slice().sort((x, y) => (x.period_end < y.period_end ? -1 : 1));
  const stmt = through ? stmts.find(s => s.period_end === through) : stmts[stmts.length - 1];
  if (!stmt) throw new Rejected(`${acc.account} has no statement ending ${through}. Its statements end ${stmts.map(s => s.period_end).join(', ')}.`);
  const D = stmt.period_end;
  const rows = statementRows().filter(t => t.account === acc.account && t.currency === cur);
  const ms = activeMatches();
  const place = placement(undefined, ms, statementRows());
  const matchedRow = new Map(ms.map(m => [m.transaction_id, m]));
  const items = cashItems().filter(c => c.currency === cur).map(c => ({ ...c, at: place(c) })).filter(c => c.at && c.at.account === acc.account);

  const upTo = rows.filter(t => t.date <= D);
  const posted = upTo.filter(t => t.posts).reduce((n, t) => n + t.amount, 0);
  const booked = items.filter(c => c.date <= D);
  const books = acc.opening + posted + booked.reduce((n, c) => n + c.amount, 0);

  const inTransit = booked.filter(c => !(c.at.row && c.at.row.date <= D))
    .map(c => ({ key: c.key, date: c.date, label: c.label, amount: c.amount, amount_display: c.amount_display,
      stale: c.date < H.addDays(D, -STALE_DAYS), note: c.at.row ? `on the statement on ${c.at.row.date} (${c.at.row.id})` : (c.date < H.addDays(D, -STALE_DAYS) ? `recorded ${c.date}, more than ${STALE_DAYS} days before the statement ends and not on it: check it was really deposited` : 'not on the statement yet') }));
  const notInBooks = upTo.filter(t => !t.posts && !matchedRow.has(t.id))
    .map(t => ({ transaction_id: t.id, date: t.date, description: t.description, amount: t.amount, amount_display: t.amount_display, status: t.status, why: why(t),
      blocks: t.status !== 'ignored' }));
  const timing = upTo.filter(t => matchedRow.has(t.id)).map(t => {
    const late = items.filter(c => c.at.row && c.at.row.id === t.id && c.date > D);
    const amt = late.reduce((n, c) => n + c.amount, 0);
    return amt ? { transaction_id: t.id, date: t.date, description: t.description, amount: amt, amount_display: money(amt, cur), note: `recorded here on ${late.map(c => c.date).join(', ')}, after the statement` } : null;
  }).filter(Boolean);

  const sum = (xs) => xs.reduce((n, x) => n + x.amount, 0);
  const explained = books - sum(inTransit) + sum(notInBooks) + sum(timing);
  const difference = stmt.closing - explained;
  // A leftover difference is the statements themselves: a gap or a jump between two of them.
  const gaps = [];
  for (let i = 1; i < stmts.length && stmts[i].period_end <= D; i++) {
    const a = stmts[i - 1], b = stmts[i];
    if (b.opening !== a.closing) gaps.push(`${b.id} opens at ${money(b.opening, cur)}, ${a.id} closed at ${money(a.closing, cur)}`);
    else if (b.period_start > H.addDays(a.period_end, 1)) gaps.push(`no statement for ${H.addDays(a.period_end, 1)} to ${H.addDays(b.period_start, -1)}`);
  }
  const blocking = [];
  if (difference) blocking.push(`A difference of ${money(difference, cur)} is not explained${gaps.length ? `: ${gaps.join('; ')}` : ''}.`);
  const unrev = notInBooks.filter(t => t.status === 'unreviewed');
  if (unrev.length) blocking.push(`${unrev.length} row${unrev.length === 1 ? ' is' : 's are'} not reviewed (${money(sum(unrev), cur)}): say what ${unrev.length === 1 ? 'it is' : 'they are'}.`);
  const orphan = notInBooks.filter(t => t.status === 'transfer');
  if (orphan.length) blocking.push(`${orphan.length} row${orphan.length === 1 ? ' is' : 's are'} marked as money already recorded here but matched to nothing (${money(sum(orphan), cur)}): match ${orphan.length === 1 ? 'it' : 'them'} to the payment, or review ${orphan.length === 1 ? 'it' : 'them'} again.`);
  const stale = inTransit.filter(c => c.stale);

  const kept = { account: acc.account, currency: cur, through: D, printed: stmt.closing, books,
    in_transit: inTransit.map(c => [c.key, c.amount]), not_in_books: notInBooks.map(t => [t.transaction_id, t.amount, t.status]), timing: timing.map(t => [t.transaction_id, t.amount]) };
  const hash = crypto.createHash('sha256').update(JSON.stringify(kept)).digest('hex').slice(0, 16);
  const so = signoffRow(acc.account, cur, D);
  const signoff = so ? { id: so.id, signed_by: so.signed_by, signed_at: so.signed_at, reason: so.reason, hash: so.hash, changed_since: so.hash !== hash } : null;

  const total = (xs) => ({ items: xs, count: xs.length, total: sum(xs), total_display: money(sum(xs), cur) });
  return {
    account: acc.account, currency: cur, kind: acc.kind, statement_id: stmt.id, from: stmt.period_start, through: D, statements: stmts.map(s => s.period_end),
    printed: stmt.closing, printed_display: money(stmt.closing, cur), books, books_display: money(books, cur),
    in_transit: total(inTransit), not_in_books: total(notInBooks), timing: total(timing),
    difference, difference_display: money(difference, cur), matched: upTo.filter(t => matchedRow.has(t.id)).length,
    ready: blocking.length === 0, blocking, stale: stale.length, hash, signoff,
    note: `${acc.account} through ${D}: the statement says ${money(stmt.closing, cur)}, the books ${money(books, cur)}.`
      + (inTransit.length ? ` ${inTransit.length} item${inTransit.length === 1 ? '' : 's'} recorded here ${inTransit.length === 1 ? 'is' : 'are'} not on the statement yet (${money(sum(inTransit), cur)}).` : '')
      + (notInBooks.length ? ` ${notInBooks.length} row${notInBooks.length === 1 ? '' : 's'} on the statement ${notInBooks.length === 1 ? 'is' : 'are'} not in the books (${money(sum(notInBooks), cur)}).` : '')
      + (timing.length ? ` ${timing.length} matched row${timing.length === 1 ? ' was' : 's were'} recorded here after the statement (${money(sum(timing), cur)}).` : '')
      + (blocking.length ? ` Not ready to sign off: ${blocking.join(' ')}` : ` Explained to the cent${signoff ? `; signed off as ${signoff.id}${signoff.changed_since ? ', and the record has changed since' : ''}` : '; ready for a person to sign off'}.`)
      + (stale.length ? ` ${stale.length} item${stale.length === 1 ? ' has' : 's have'} been in transit more than ${STALE_DAYS} days.` : ''),
  };
}

const signoffRow = (account, currency, through) => { try { return db().prepare('SELECT * FROM bankrec_signoff WHERE account = ? AND currency = ? AND through = ?').get(account, currency, through) || null; } catch { return null; } };

function signoffs() {
  let rows = []; try { rows = db().prepare('SELECT * FROM bankrec_signoff ORDER BY through DESC, id DESC').all(); } catch { return { count: 0, items: [] }; }
  const items = rows.map(r => {
    let now = null; try { now = reconciliation({ account: r.account, currency: r.currency, through: r.through }); } catch { /* the statement is gone */ }
    return { ...r, name: r.id, printed_display: money(r.printed, r.currency), books_display: money(r.books, r.currency), kept: JSON.parse(r.kept_json),
      changed_since: !now || now.hash !== r.hash, state: !now || now.hash !== r.hash ? 'changed since' : 'signed' };
  });
  return { count: items.length, items };
}

/** Every bank and card account with its latest statement and where its reconciliation stands. */
function accounts() {
  const items = statementAccounts().map(a => {
    const r = reconciliation({ account: a.account, currency: a.currency });
    const last = (() => { try { return db().prepare('SELECT MAX(through) d FROM bankrec_signoff WHERE account = ? AND currency = ?').get(a.account, a.currency).d; } catch { return null; } })();
    return { account: a.account, currency: a.currency, kind: a.kind, statements: a.statements.length, latest_through: r.through, printed_display: r.printed_display, books_display: r.books_display,
      in_transit: r.in_transit.count, not_in_books: r.not_in_books.count, difference_display: r.difference_display, ready: r.ready, signed_through: last || null,
      state: r.signoff ? (r.signoff.changed_since ? 'changed since' : 'signed') : r.ready ? 'ready to sign' : 'open' };
  });
  return { count: items.length, items };
}

/** REC-7: per unmatched row, the payments that would fit it, and why. Never matches anything. */
function candidates({ account } = {}) {
  const accs = account ? [findAccount(account)] : statementAccounts().filter(a => a.kind !== 'card');
  const ms = activeMatches();
  const taken = new Set(ms.flatMap(m => m.items.map(i => i.item_key)));
  const matchedRow = new Set(ms.map(m => m.transaction_id));
  const free = cashItems().filter(c => !taken.has(c.key));
  const out = [];
  for (const acc of accs) {
    for (const t of statementRows().filter(r => r.account === acc.account && r.currency === acc.currency && !r.posts && r.status !== 'ignored' && !matchedRow.has(r.id))) {
      const near = free.filter(c => c.currency === t.currency && Math.sign(c.amount) === Math.sign(t.amount) && c.date >= H.addDays(t.date, -14) && c.date <= H.addDays(t.date, 3));
      const fits = [];
      for (const c of near) if (c.amount === t.amount) fits.push([c]);
      if (!fits.length) {   // one deposit for several checks
        const xs = near.slice(0, 12);
        for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
          if (xs[i].amount + xs[j].amount === t.amount) fits.push([xs[i], xs[j]]);
          for (let k = j + 1; k < xs.length; k++) if (xs[i].amount + xs[j].amount + xs[k].amount === t.amount) fits.push([xs[i], xs[j], xs[k]]);
        }
      }
      const desc = t.description.toLowerCase();
      const scored = fits.map(set => {
        const named = set.filter(c => c.customer && c.customer.split(/\s+/).some(w => w.length > 2 && desc.includes(w.toLowerCase())));
        const days = Math.max(...set.map(c => Math.abs((Date.parse(t.date) - Date.parse(c.date)) / 864e5)));
        return { items: set.map(c => ({ key: c.key, label: c.label, date: c.date, amount_display: c.amount_display })), days,
          score: named.length * 10 - days - set.length,
          why: `${set.length === 1 ? 'same amount' : `${set.length} items adding up to it`}, ${days} day${days === 1 ? '' : 's'} apart${named.length ? `, ${named.map(c => c.customer).join(' and ')} in the description` : ''}` };
      }).sort((x, y) => y.score - x.score).slice(0, 3);
      if (!scored.length && t.status !== 'transfer') continue;   // spending nothing could be: review it, not a match
      out.push({ transaction_id: t.id, account: acc.account, date: t.date, description: t.description, amount: t.amount, amount_display: t.amount_display, status: t.status, candidates: scored,
        note: scored.length ? null : 'Nothing recorded here fits it. If it is money in from a customer, record the payment first; otherwise review the row as what it is.' });
    }
  }
  const unmatched = free.filter(c => c.date <= H.today()).length;
  return { count: out.length, rows: out, unmatched_items: unmatched,
    note: out.length ? `${out.length} row${out.length === 1 ? '' : 's'} on the statements could be money already recorded here. Suggestions only: show the person, then match with rec_match and a reason.` : 'No statement row is waiting for a match.' };
}

/** For gl's checklist and bridge's ties: is this account explained through a day, and is it signed? */
function standing(account, currency, through) {
  try {
    const acc = findAccount(account, currency);
    const ends = acc.statements.map(s => s.period_end).filter(d => !through || d <= through).sort();
    if (!ends.length) return null;
    const r = reconciliation({ account: acc.account, currency: acc.currency, through: ends[ends.length - 1] });
    return { through: r.through, ready: r.ready, difference: r.difference, in_transit: r.in_transit.total, signed: !!(r.signoff && !r.signoff.changed_since), blocking: r.blocking, note: r.note };
  } catch { return null; }
}

module.exports = { cashItems, activeMatches, statementRowMatches, matchView, matches, reconciliation, signoffs, accounts, candidates, standing, findAccount, signoffRow };
