'use strict';
/**
 * core — master data and the registry-wide reads (schema, search, audit, next_actions).
 *
 * Owns `customer` and `item`. Other modules read them freely (joins are fine) but never
 * write them: stock moves through api.adjustStock so there is exactly one place where
 * on_hand can change and one rule about going negative. The contract test greps for
 * cross-module writes; this api is what you use instead.
 */
const R = require('../../registry.js');
const H = require('../../db.js');

const mod = R.defineModule({
  name: 'core', prefix: 'core',
  tables: ['customer', 'item', 'company_profile'],
  env_acts: { create_customer: 'core_create_customer', create_item: 'core_create_item', receive_stock: 'core_receive_stock', set_price: 'core_set_price',
              set_credit_limit: 'core_set_credit_limit', hold_customer: 'core_hold_customer', release_customer: 'core_release_customer',
              set_company_profile: 'core_set_company_profile', update_customer: 'core_update_customer' },
  env_argmap: { item: 'item_id', customer: 'customer_id' },
  doctrine: `Master data is slow-moving and load-bearing. A credit limit of 0 means prepay only —
a real position, not a missing value. Set stocked=false for services; they never deplete and
never block a shipment. Never invent a customer to make another command work. A fresh space
is set up by conversation: core_setup_status lists what the company profile still needs and
the next question to ask; one question at a time, written as it is answered.`,
  api: {
    /** The journal as a derivation, shared by core_journal and the bridge module. Never posted, never stored. */
    journal(a = {}) {
    const db = H.db();
    // Entries carry the currency they happened in (solo invoices choose one; o2c is USD).
    // Sums are per currency and never cross — the ledger of record is fed one currency at a time.
    const money = (c, cur) => H.money(c, cur || 'USD');
    const day = (d) => String(d || '').slice(0, 10);
    const inRange = (d) => (!a.from || day(d) >= a.from) && (!a.to || day(d) <= a.to);
    const entries = [];
    const push = (date, memo, customer, lines, cur) => {
      const dr = lines.reduce((s, l) => s + (l.debit || 0), 0);
      const cr = lines.reduce((s, l) => s + (l.credit || 0), 0);
      if (dr !== cr) throw new Error(`journal derivation bug: unbalanced entry "${memo}" (${dr} vs ${cr})`);
      if (dr === 0) return;
      const currency = cur || 'USD';
      entries.push({ date: day(date), memo, customer, currency, lines: lines.filter(l => (l.debit || 0) + (l.credit || 0) > 0)
        .map(l => ({ ...l, currency, debit_display: l.debit ? money(l.debit, currency) : '', credit_display: l.credit ? money(l.credit, currency) : '' })) });
    };
    const cname = {}; for (const c of db.prepare('SELECT id, name FROM customer').all()) cname[c.id] = c.name;

    for (const i of db.prepare("SELECT * FROM invoice WHERE status <> 'void' ORDER BY id").all()) {
      if (!inRange(i.issued_at)) continue;
      // Goods and services credit separate revenue accounts (stocked flag decides); if the
      // line math ever disagrees with the invoice net, everything goes to Sales Revenue —
      // balanced beats beautifully classified.
      const net = i.total - i.tax_total;
      const sp = db.prepare(`SELECT COALESCE(SUM(CASE WHEN it.stocked = 1 THEN il.qty * il.unit_price ELSE 0 END), 0) goods,
                                    COALESCE(SUM(CASE WHEN it.stocked = 0 THEN il.qty * il.unit_price ELSE 0 END), 0) service
                             FROM invoice_line il JOIN item it ON it.id = il.item_id WHERE il.invoice_id = ?`).get(i.id);
      const goods = (sp.goods + sp.service === net) ? sp.goods : net;
      const service = (sp.goods + sp.service === net) ? sp.service : 0;
      push(i.issued_at, `Invoice ${i.id}`, cname[i.customer_id], [
        { account: 'Accounts Receivable', debit: i.total },
        { account: 'Sales Revenue', credit: goods },
        { account: 'Service Revenue', credit: service },
        { account: 'Sales Tax Payable', credit: i.tax_total },
      ]);
    }
    for (const p of db.prepare('SELECT * FROM payment ORDER BY id').all()) {
      if (!inRange(p.received_at)) continue;
      push(p.received_at, `Payment ${p.id}${p.reference ? ' · ' + p.reference : ''}`, cname[p.customer_id], [
        { account: 'Cash', debit: p.amount },
        { account: 'Customer Deposits', credit: p.amount },
      ]);
    }
    for (const ap of db.prepare(`SELECT pa.*, p.received_at, p.customer_id FROM payment_application pa
                                 JOIN payment p ON p.id = pa.payment_id ORDER BY pa.id`).all()) {
      const at2 = ap.applied_at || ap.received_at;
      if (!inRange(at2)) continue;
      push(at2, `Apply ${ap.payment_id} → ${ap.invoice_id}`, cname[ap.customer_id], [
        { account: 'Customer Deposits', debit: ap.amount },
        { account: 'Accounts Receivable', credit: ap.amount },
      ]);
    }
    for (const cn of db.prepare('SELECT * FROM credit_note ORDER BY id').all()) {
      if (!inRange(cn.created_at)) continue;
      if (cn.kind === 'write_off') {
        push(cn.created_at, `Write-off ${cn.id}${cn.invoice_id ? ' · ' + cn.invoice_id : ''}`, cname[cn.customer_id], [
          { account: 'Bad Debt Expense', debit: cn.total },
          { account: 'Accounts Receivable', credit: cn.total },
        ]);
      } else {
        push(cn.created_at, `Credit note ${cn.id} (${cn.kind})`, cname[cn.customer_id], [
          { account: 'Sales Returns & Allowances', debit: cn.total },
          { account: 'Customer Credits', credit: cn.total },
        ]);
      }
    }
    for (const ca of db.prepare(`SELECT ca.*, cn.created_at, cn.customer_id, cn.kind FROM credit_application ca
                                 JOIN credit_note cn ON cn.id = ca.credit_note_id WHERE cn.kind <> 'write_off' ORDER BY ca.id`).all()) {
      const at2 = ca.applied_at || ca.created_at;
      if (!inRange(at2)) continue;
      push(at2, `Apply ${ca.credit_note_id} → ${ca.invoice_id}`, cname[ca.customer_id], [
        { account: 'Customer Credits', debit: ca.amount },
        { account: 'Accounts Receivable', credit: ca.amount },
      ]);
    }
    for (const rf of db.prepare('SELECT * FROM refund ORDER BY id').all()) {
      if (!inRange(rf.recorded_at)) continue;
      push(rf.recorded_at, `Refund ${rf.id} (${rf.source_type} ${rf.source_id})`, null, [
        { account: rf.source_type === 'payment' ? 'Customer Deposits' : 'Customer Credits', debit: rf.amount },
        { account: 'Cash', credit: rf.amount },
      ]);
    }

    // Solo (freelancer invoicing) derives with the same accounts — S-9. All service revenue.
    for (const i of db.prepare("SELECT * FROM solo_invoice WHERE status IN ('issued','paid') ORDER BY id").all()) {
      if (!inRange(i.issued_at)) continue;
      push(i.issued_at, `Invoice ${i.id}`, cname[i.customer_id], [
        { account: 'Accounts Receivable', debit: i.total },
        { account: 'Service Revenue', credit: i.total - i.tax_total },
        { account: 'Sales Tax Payable', credit: i.tax_total },
      ], i.currency);
    }
    for (const p of db.prepare('SELECT * FROM solo_payment ORDER BY id').all()) {
      if (!inRange(p.received_at)) continue;
      push(p.received_at, `Payment ${p.id}${p.reference ? ' · ' + p.reference : ''}`, cname[p.customer_id], [
        { account: 'Cash', debit: p.amount },
        { account: 'Customer Deposits', credit: p.amount },
      ], p.currency);
    }
    for (const ap of db.prepare(`SELECT pa.*, p.currency, p.customer_id FROM solo_payment_application pa
                                 JOIN solo_payment p ON p.id = pa.payment_id ORDER BY pa.id`).all()) {
      if (!inRange(ap.applied_at)) continue;
      push(ap.applied_at, `Apply ${ap.payment_id} → ${ap.invoice_id}`, cname[ap.customer_id], [
        { account: 'Customer Deposits', debit: ap.amount },
        { account: 'Accounts Receivable', credit: ap.amount },
      ], ap.currency);
    }

    // Areas contribute their own postings (purchases brings the spending side); core owns the
    // stitching and the balance check, never another module's tables.
    for (const m of R.MODULES) {
      if (!m.api || typeof m.api.journalLines !== 'function') continue;
      for (const e of m.api.journalLines({ from: a.from, to: a.to })) push(e.date, e.memo, e.customer, e.lines, e.currency);
    }

    entries.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    const kept = a.currency ? entries.filter(e => e.currency === String(a.currency).toUpperCase()) : entries;
    const debits = kept.reduce((s, e) => s + e.lines.reduce((s2, l) => s2 + (l.debit || 0), 0), 0);
    const credits = kept.reduce((s, e) => s + e.lines.reduce((s2, l) => s2 + (l.credit || 0), 0), 0);
    const by = {};
    for (const e of kept) { const c = e.currency; by[c] = by[c] || { currency: c, entries: 0, debits: 0 }; by[c].entries++; by[c].debits += e.lines.reduce((s2, l) => s2 + (l.debit || 0), 0); }
    for (const c of Object.keys(by)) by[c].debits_display = money(by[c].debits, c);
    const currencies = Object.keys(by);
    return { from: a.from || null, to: a.to || null, currency: a.currency ? String(a.currency).toUpperCase() : null,
      entry_count: kept.length, currencies, by_currency: by,
      debits, credits, debits_display: money(debits, currencies.length === 1 ? currencies[0] : 'USD'), credits_display: money(credits, currencies.length === 1 ? currencies[0] : 'USD'),
      balanced: debits === credits, entries: kept };
    },
    needCustomer: (id) => H.need('customer', id, 'customer'),
    /**
     * The one door to creating a customer from another module (crm's promote bridge uses
     * it). Same rules as the command; a function because nested execute() would nest
     * transactions on one connection, which SQLite forbids.
     */
    createCustomer(db, { name, email, terms, credit_limit, address, tax_id }, at) {
      if (!name) throw new R.Rejected('A customer needs a name.');
      if (db.prepare('SELECT id FROM customer WHERE lower(name) = lower(?)').get(name)) {
        throw new R.Rejected(`A customer named ${name} already exists. Use it, or give this one a distinguishing name.`);
      }
      const id = H.nextId('C', 'customer');
      db.prepare('INSERT INTO customer (id,name,email,terms,credit_limit,address,tax_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, name, email || null, terms || 'net30', credit_limit || 0, address || null, tax_id || null, at || new Date().toISOString());
      return H.get('customer', id);
    },
    needItem: (id) => H.need('item', id, 'item'),
    /**
     * The only door to on_hand. delta<0 depletes (a shipment), delta>0 receives.
     * Throws rather than going negative; service items are a no-op by design so callers
     * do not need to special-case them.
     */
    adjustStock(db, itemId, delta, why) {
      const item = H.need('item', itemId, 'item');
      if (!item.stocked) return item;
      if (item.on_hand + delta < 0) throw new R.Rejected(`${item.id} (${item.name}): ${item.on_hand} on hand, ${-delta} needed${why ? ` for ${why}` : ''}. Stock cannot go negative.`);
      db.prepare('UPDATE item SET on_hand = on_hand + ? WHERE id = ?').run(delta, itemId);
      return H.get('item', itemId);
    },
  },
});

R.inModule(mod, () => {
  require('./commands/masterdata.js');
  require('./commands/reads.js');
});

module.exports = mod.api;
