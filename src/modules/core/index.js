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
  tables: ['customer', 'item'],
  env_acts: { create_customer: 'core_create_customer', create_item: 'core_create_item', receive_stock: 'core_receive_stock', set_price: 'core_set_price',
              set_credit_limit: 'core_set_credit_limit', hold_customer: 'core_hold_customer', release_customer: 'core_release_customer' },
  env_argmap: { item: 'item_id', customer: 'customer_id' },
  doctrine: `Master data is slow-moving and load-bearing. A credit limit of 0 means prepay only —
a real position, not a missing value. Set stocked=false for services; they never deplete and
never block a shipment. Never invent a customer to make another command work.`,
  api: {
    needCustomer: (id) => H.need('customer', id, 'customer'),
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
