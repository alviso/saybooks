#!/usr/bin/env node
'use strict';
/**
 * A full order-to-cash run where the human and the agent take alternating steps.
 * Nothing here is special-cased for the demo: `ui()` and `bot()` differ only in the ctx they
 * pass to execute(), exactly as server.js and mcp-server.js differ.
 */
const R = require('./src/registry.js');
R.loadModules();
const { mcpTools, formSpec, nextActions } = R;
const wsp = require('./src/workspace.js');
const H = require('./src/db.js');
const V = require('./src/modules/o2c/views.js');
const WS = 'demo';
wsp.wipe(WS); wsp.wipe('ana');           // rerunnable: the demo owns these two workspaces

const B = (s) => `\x1b[1m${s}\x1b[0m`, DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`, RED = (s) => `\x1b[31m${s}\x1b[0m`, CYAN = (s) => `\x1b[36m${s}\x1b[0m`;

const run = (ctx, tag) => (name, args, why) => {
  try {
    const out = R.execute(name, args, { ...ctx, workspace: WS, reason: why });
    console.log(`${tag} ${GREEN('ok')}  ${name}${why ? DIM('  — ' + why) : ''}`);
    return out;
  } catch (e) {
    console.log(`${tag} ${RED('refused')}  ${name}`);
    console.log(`      ${RED(e.message)}`);
    return null;
  }
};
const ui  = run({ actor: 'peter',  actor_kind: 'human', session: 'workbench' }, CYAN('[ui   ]'));
const bot = run({ actor: 'claude', actor_kind: 'agent', session: 'mcp-1' },     `\x1b[35m[agent]\x1b[0m`);

console.log(B('\n═══ 1. master data ═══════════════════════════════════════════'));
const nw = ui('core_create_customer', { name: 'Northwind Traders', email: 'ap@northwind.example', terms: 'net30', credit_limit: 5000000 });
ui('core_create_customer', { name: 'Contoso Ltd', terms: 'net15', credit_limit: 100000 });
ui('core_create_item', { sku: 'WIDGET-A', name: 'Widget, type A', unit_price: 12500, on_hand: 40 });
ui('core_create_item', { sku: 'WIDGET-B', name: 'Widget, type B', unit_price: 8000, on_hand: 5 });
ui('core_create_item', { sku: 'INSTALL',  name: 'On-site installation', unit_price: 50000, stocked: false });

console.log(B('\n═══ 2. quote → order ═════════════════════════════════════════'));
const q = bot('o2c_create_quote', { customer_id: nw.id, lines: [
  { item_id: 'WIDGET-A', qty: 20 }, { item_id: 'WIDGET-B', qty: 10 }, { item_id: 'INSTALL', qty: 1 },
] }, 'customer asked for a quote on the phone');
console.log(`      quote ${q.id}: ${q.total_display}`);
bot('o2c_send_quote', { quote_id: q.id });
const so = ui('o2c_accept_quote', { quote_id: q.id, po_ref: 'NW-88231' }, 'PO arrived by email');
console.log(`      order ${so.id} raised in ${so.status}, total ${so.total_display}`);

console.log(B('\n═══ 3. the credit gate ═══════════════════════════════════════'));
const co = bot('o2c_create_order', { customer_id: 'C-0002', lines: [{ item_id: 'WIDGET-A', qty: 20 }] });
bot('o2c_confirm_order', { order_id: co.id }, 'trying to push a large order through a small limit');
bot('o2c_confirm_order', { order_id: so.id }, 'PO is in hand, credit is fine');

console.log(B('\n═══ 4. fulfilment — a short ship ═════════════════════════════'));
bot('o2c_ship_order', { order_id: so.id, carrier: 'UPS' }, 'ship everything open');
const d = bot('o2c_ship_order', { order_id: so.id, carrier: 'UPS', tracking: '1Z-88231-A', lines: [
  { order_line_id: 1, qty: 20 }, { order_line_id: 2, qty: 5 }, { order_line_id: 3, qty: 1 },
] }, 'shipping what we actually have, B is short 5');
console.log(`      ${d.delivery_id} out; order still ${d.status}, ${d.open_qty} unit(s) open`);

console.log(B('\n═══ 5. billing — what shipped, not what was ordered ══════════'));
const inv = ui('o2c_invoice_shipped', { order_id: so.id });
console.log(`      ${inv.id} ${inv.total_display}, due ${inv.due_at}  ${DIM('(order stays ' + inv.order_status + ' — 5 units still owed)')}`);

console.log(B('\n═══ 6. cash ══════════════════════════════════════════════════'));
const p = ui('o2c_record_payment', { customer_id: nw.id, amount: 200000, method: 'ach', reference: 'ACH-55120' }, 'bank feed, no remittance advice');
console.log(`      ${p.id} ${p.amount_display} received, unapplied`);
bot('o2c_apply_payment', { payment_id: p.id, invoice_id: inv.id, amount: 500000 }, 'over-applying on purpose');
const ap = bot('o2c_apply_payment', { payment_id: p.id, invoice_id: inv.id }, 'remittance confirmed by AR clerk');
console.log(`      applied ${ap.applied}; ${inv.id} now owes ${ap.invoice.open_display}`);

console.log(B('\n═══ 7. one evaluation, two surfaces ══════════════════════════'));
const na = wsp.use(WS, () => nextActions('order', so.id));
console.log(DIM('      the UI greys a button and shows `reason` as its tooltip;'));
console.log(DIM('      core_next_actions returns this same array to the agent.'));
for (const a of na.actions) console.log(`      ${a.available ? GREEN('●') : DIM('○')} ${a.title.padEnd(16)} ${a.available ? '' : DIM(a.reason)}`);

console.log(B('\n═══ 8. AR aging ══════════════════════════════════════════════'));
const aging = wsp.use(WS, () => V.arAging());
console.log('      ' + Object.entries(aging.buckets_display).map(([k, v]) => `${k} ${v}`).join('   ') + `   total ${aging.total}`);
console.log('      unapplied cash: ' + (wsp.use(WS, () => V.unappliedCash()).map(u => `${u.id} ${H.money(u.unapplied)} (${u.customer_name})`).join(', ') || 'none'));

console.log(B('\n═══ 9. the log both surfaces wrote to ════════════════════════'));
for (const r of wsp.use(WS, () => H.auditTrail(40)).reverse()) {
  const who = r.actor_kind === 'agent' ? '\x1b[35magent\x1b[0m' : `${CYAN('human')}`;
  console.log(`      ${r.ok ? GREEN('✓') : RED('✗')} ${who}  ${r.command.padEnd(22)} ${String(r.subject_id || '').padEnd(9)} ${DIM(r.reason || r.error || '')}`);
}

console.log(B('\n═══ 10. workspaces do not leak ═══════════════════════════════'));
const ana = (name, args, why) => R.execute(name, args, { workspace: 'ana', actor: 'ana', actor_kind: 'human', session: 'workbench-ana', reason: why });
console.log(`      ana's workspace, o2c_backorders: ${JSON.stringify(ana('o2c_backorders', {}))}`);
ana('core_create_customer', { name: 'Fabrikam', credit_limit: 1000000 }, "ana's own test data");
console.log(`      ana sees Fabrikam: ${JSON.stringify(R.execute('core_search', { q: 'Fabrikam' }, { workspace: 'ana', actor: 'ana' }).customers.map(c => c.id))}`);
console.log(`      demo workspace never does: ${JSON.stringify(wsp.use(WS, () => H.db().prepare("SELECT id FROM customer WHERE name='Fabrikam'").get()) ?? null)}`);

console.log(B('\n═══ derived, not maintained ══════════════════════════════════'));
const tools = mcpTools(), forms = formSpec();
console.log(`      ${tools.length} MCP tools and ${forms.length} UI forms from ${tools.length} declarations.`);
console.log(`      module mounts: core-only session gets ${mcpTools({modules:['core']}).length} tools, o2c adds ${mcpTools({modules:['o2c']}).length}.`);
const ship = tools.find(t => t.name === 'o2c_ship_order');
console.log(DIM(`      o2c_ship_order → MCP: ${Object.keys(ship.inputSchema.properties).join(', ')}`));
console.log(DIM(`                     → UI : ${forms.find(f => f.name === 'o2c_ship_order').fields.map(f => `${f.label}[${f.widget}]`).join(', ')}`));
console.log('');
