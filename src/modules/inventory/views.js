'use strict';
/**
 * What the stock is worth: each item's moves (core's stock_move) replayed in order. A costed
 * inflow moves the average; an outflow leaves at the average of that moment (STK-4); stock that
 * came in without a cost makes the item's cost unknown until a person states its opening cost
 * (STK-3, STK-5). Nothing here is stored except opening costs; everything else is derived.
 */
const H = require('../../db.js');
const db = () => H.db();
const money = (c) => (c == null ? null : H.money(c, H.locale().currency || 'USD'));
const cents = (x) => Math.round(x);

const openingCost = (itemId) => db().prepare('SELECT * FROM inv_opening_cost WHERE item_id = ?').get(itemId) || null;
const moves = (itemId) => db().prepare('SELECT * FROM stock_move WHERE item_id = ? ORDER BY date, id').all(itemId);
const stockedItems = () => db().prepare('SELECT * FROM item WHERE stocked = 1 ORDER BY id').all();

/**
 * Replay one item's moves up to a day. Each move comes back with what it did to the value and,
 * for an outflow, what it cost (null when the cost is unknown).
 */
function replay(itemId, { to } = {}) {
  const oc = openingCost(itemId);
  let qty = 0, value = 0, known = true, uncosted = 0, lastAvg = null;
  const out = [];
  for (const m of moves(itemId)) {
    if (to && m.date > to) break;
    const avgNow = qty > 0 && known ? value / qty : lastAvg;
    const row = { ...m, value_change: null, cost: null, unit_cost_used: null };
    if (m.qty > 0) {
      let cost = m.unit_cost;
      if (cost == null && m.kind === 'opening') cost = oc ? oc.unit_cost : null;
      if (cost == null && ['return', 'count', 'adjustment'].includes(m.kind)) cost = avgNow != null ? avgNow : (oc ? oc.unit_cost : null);
      if (cost == null) { known = false; uncosted += m.qty; }
      else { const v = cents(m.qty * cost); value += v; row.value_change = v; row.unit_cost_used = cost; }
      qty += m.qty;
    } else if (m.qty < 0) {
      const q = -m.qty;
      if (known && qty > 0) { const c = q >= qty ? value : cents(value * q / qty); value -= c; row.cost = c; row.value_change = -c; row.unit_cost_used = c / q; }
      qty -= q;
      if (!known) uncosted = Math.max(0, uncosted - q);
    }
    if (qty === 0) { if (known) value = 0; known = true; uncosted = 0; }
    if (qty > 0 && known) lastAvg = value / qty;
    row.qty_after = qty; row.known_after = known; row.value_after = known ? value : null; row.avg_after = qty > 0 && known ? value / qty : null;
    out.push(row);
  }
  const avg = qty > 0 && known ? value / qty : null;
  return { item_id: itemId, qty, value: known ? value : null, costed_value: value, known, uncosted_qty: known ? 0 : Math.max(uncosted, 0), avg, opening_cost: oc, moves: out };
}

const unit = (avg) => (avg == null ? null : money(Math.round(avg)));
const KIND_WORDS = { opening: 'opening stock', receipt: 'received', shipment: 'shipped', return: 'returned', count: 'count', adjustment: 'adjusted' };

function itemStock(itemId, { to } = {}) {
  const item = H.need('item', itemId, 'item');
  const r = replay(itemId, { to });
  return {
    id: item.id, name: item.name, item_id: item.id, item_name: item.name, stocked: !!item.stocked, on_hand: item.on_hand, sale_price: item.unit_price, sale_price_display: money(item.unit_price),
    qty: r.qty, average_cost: r.avg == null ? null : Math.round(r.avg), average_cost_display: unit(r.avg), value: r.value, value_display: money(r.value),
    cost_known: r.known, uncosted_qty: r.uncosted_qty,
    opening_cost: r.opening_cost ? r.opening_cost.unit_cost : null, opening_cost_display: r.opening_cost ? money(r.opening_cost.unit_cost) : null, opening_cost_reason: r.opening_cost ? r.opening_cost.reason : null,
    status: r.known ? 'costed' : 'cost unknown',
    note: r.known ? null : `${r.uncosted_qty} came in without a cost. State the opening cost (what one was worth) and everything after it is derived.`,
    moves: r.moves.map(m => ({ id: m.id, date: m.date, kind: m.kind, kind_words: KIND_WORDS[m.kind] || m.kind, ref: m.ref, qty: m.qty, note: m.note,
      unit_cost_display: m.unit_cost_used == null ? null : money(Math.round(m.unit_cost_used)), value_change: m.value_change, value_change_display: money(m.value_change),
      qty_after: m.qty_after, average_after_display: unit(m.avg_after), value_after_display: money(m.value_after) })).reverse(),
  };
}

function stock() {
  const items = stockedItems().map(i => { const s = itemStock(i.id); delete s.moves; return s; });
  const total = items.reduce((n, i) => n + (i.value || 0), 0);
  const unknown = items.filter(i => !i.cost_known);
  return { count: items.length, value: total, value_display: money(total), uncosted_items: unknown.map(i => ({ item_id: i.item_id, uncosted_qty: i.uncosted_qty })),
    note: unknown.length ? `${unknown.length} item${unknown.length === 1 ? ' has' : 's have'} stock without a cost (${unknown.map(i => `${i.uncosted_qty} ${i.item_id}`).join(', ')}): not in the value until an opening cost is stated.` : null,
    items };
}

function allMoves({ item_id, limit = 200 } = {}) {
  const rows = db().prepare(`SELECT m.*, i.name AS item_name FROM stock_move m JOIN item i ON i.id = m.item_id ${item_id ? 'WHERE m.item_id = ?' : ''} ORDER BY m.date DESC, m.id DESC LIMIT ?`).all(...(item_id ? [item_id] : []), limit);
  return { count: rows.length, items: rows.map(m => ({ ...m, kind_words: KIND_WORDS[m.kind] || m.kind })) };
}

/** Each shipment line in a period: what it sold for, what it cost at the average, the margin. */
function costOfSales({ from, to } = {}) {
  const lines = [];
  for (const it of stockedItems()) {
    for (const m of replay(it.id).moves) {
      if (m.kind !== 'shipment' || (from && m.date < from) || (to && m.date > to)) continue;
      const sold = db().prepare(`SELECT ol.unit_price, dl.qty, o.id AS order_id, c.name AS customer FROM delivery_line dl JOIN order_line ol ON ol.id = dl.order_line_id
        JOIN "order" o ON o.id = ol.order_id JOIN customer c ON c.id = o.customer_id WHERE dl.delivery_id = ? AND ol.item_id = ?`).all(m.ref, it.id);
      const qty = -m.qty;
      const revenue = sold.reduce((n, s) => n + s.qty * s.unit_price, 0);
      lines.push({ date: m.date, delivery_id: m.ref, order_id: sold[0] ? sold[0].order_id : null, customer: sold[0] ? sold[0].customer : null, item_id: it.id, item_name: it.name, qty,
        revenue, revenue_display: money(revenue), cost: m.cost, cost_display: m.cost == null ? null : money(m.cost), unit_cost_display: m.cost == null ? null : money(Math.round(m.cost / qty)),
        margin: m.cost == null ? null : revenue - m.cost, margin_display: m.cost == null ? null : money(revenue - m.cost), margin_pct: m.cost == null || !revenue ? null : Number(((revenue - m.cost) / revenue * 100).toFixed(1)) });
    }
  }
  lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const costed = lines.filter(l => l.cost != null);
  const revenue = costed.reduce((n, l) => n + l.revenue, 0), cost = costed.reduce((n, l) => n + l.cost, 0);
  const left = lines.filter(l => l.cost == null);
  return { from: from || null, to: to || null, count: lines.length, revenue, revenue_display: money(revenue), cost, cost_display: money(cost), margin: revenue - cost, margin_display: money(revenue - cost),
    margin_pct: revenue ? Number(((revenue - cost) / revenue * 100).toFixed(1)) : null,
    left_out: left.length ? `${left.length} shipment line${left.length === 1 ? '' : 's'} (${left.map(l => `${l.qty} ${l.item_id}`).join(', ')}) left out: the item's cost is unknown until its opening cost is stated.` : null,
    lines };
}

/** STK-7: the value of the stock on a day, beside the Inventory balance the journal derives for it. */
function valuation({ as_of } = {}) {
  const day = as_of || H.today();
  const items = stockedItems().map(i => {
    const r = replay(i.id, { to: day });
    return { item_id: i.id, item_name: i.name, qty: r.qty, average_cost_display: unit(r.avg), value: r.costed_value, value_display: money(r.costed_value), cost_known: r.known, uncosted_qty: r.uncosted_qty };
  }).filter(i => i.qty !== 0 || i.value !== 0);
  const total = items.reduce((n, i) => n + i.value, 0);
  const j = require('../core/index.js').journal({ to: day });
  const books = j.entries.flatMap(e => e.lines).filter(l => l.account === 'Inventory').reduce((n, l) => n + (l.debit || 0) - (l.credit || 0), 0);
  return { as_of: day, items, value: total, value_display: money(total), books_inventory: books, books_inventory_display: money(books), ties: total === books,
    note: total === books ? `Ties: the stock is worth ${money(total)} on ${day}, the same as Inventory in the books.` : `Does not tie: the stock is worth ${money(total)}, Inventory in the books is ${money(books)}.` };
}

const DERIVATION_ACCOUNTS = [
  { account: 'Cost of Goods Sold', kind: 'expense', when: 'goods ship, at their moving average cost; a return reverses it' },
  { account: 'Inventory Adjustments', kind: 'expense', when: 'a count finds more or fewer than the record, valued at the average' },
  { account: 'Opening Balance Equity', kind: 'equity', when: 'stock on hand before the record gets its opening cost' },
  { account: 'Inventory', kind: 'asset', when: 'goods received at cost; leaves at the moving average when shipped' },
];

/** STK-8: postings for every costed move except receipts, which the p2p area posts (P2P-13). */
function journalLines({ from, to } = {}) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const out = [];
  let items = []; try { items = stockedItems(); } catch { return []; }
  for (const it of items) {
    for (const m of replay(it.id).moves) {
      if (!inRange(m.date) || m.value_change == null || m.value_change === 0 || m.kind === 'receipt') continue;
      const v = Math.abs(m.value_change), up = m.value_change > 0;
      const other = m.kind === 'opening' ? 'Opening Balance Equity' : (m.kind === 'shipment' || m.kind === 'return') ? 'Cost of Goods Sold' : 'Inventory Adjustments';
      const memo = `${KIND_WORDS[m.kind][0].toUpperCase()}${KIND_WORDS[m.kind].slice(1)} ${Math.abs(m.qty)} ${it.id}${m.ref ? ' · ' + m.ref : ''}`;
      out.push({ date: m.date, memo, customer: null, currency: H.locale().currency || 'USD', source: `move ${m.id}`,
        lines: up ? [{ account: 'Inventory', debit: v }, { account: other, credit: v }] : [{ account: other, debit: v }, { account: 'Inventory', credit: v }] });
    }
  }
  return out;
}

module.exports = { replay, itemStock, stock, allMoves, costOfSales, valuation, DERIVATION_ACCOUNTS, journalLines, openingCost };
