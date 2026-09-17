// A freelancer's first afternoon, said the way a person says it. No tool names, no field names.
const one = (db, sql, ...a) => db.prepare(sql).get(...a);
export default {
  name: 'plain invoicing',
  mounts: ['core', 'solo'],
  steps: [
    { say: "Set up my company: Vega Consulting, in the US, working in USD. We're not registered for sales tax. Address is 12 Oak Lane, Portland, OR 97205. Clients pay by ACH to First Federal, routing 026009593, account 5550123.",
      check: (db) => { const p = one(db, 'SELECT * FROM company_profile WHERE id = 1') || {};
        const miss = ['name', 'country', 'currency', 'address', 'payment_instructions'].filter(k => !p[k]);
        if (miss.length) return `profile still missing ${miss.join(', ')}`;
        if (!p.tax_decided) return 'tax position not recorded as decided'; return true; } },
    { say: 'Add a client, Meridian Logistics, net 30. Billing email ap@meridian.example, address 400 Harbor Blvd, Tacoma, WA 98402.',
      check: (db) => { const c = one(db, "SELECT * FROM customer WHERE name LIKE '%Meridian%'"); if (!c) return 'no customer';
        if (c.terms !== 'net30') return `terms ${c.terms}`; if (!c.address) return 'no address'; return true; } },
    { say: 'Invoice them for 12 hours of consulting at $250 an hour, due in 30 days, and issue it.',
      check: (db) => { const inv = one(db, 'SELECT * FROM solo_invoice ORDER BY id DESC LIMIT 1'); if (!inv) return 'no invoice';
        if (inv.total !== 300000) return `total ${inv.total}, expected 300000`; if (inv.status !== 'issued') return `status ${inv.status}, not issued`;
        const ref = one(db, 'SELECT ref FROM solo_invoice_line WHERE invoice_id = ? AND ref IS NOT NULL', inv.id);
        if (ref) return `a reference nobody gave was invented: ${ref.ref}`; return true; } },
    { say: 'Change the total on that invoice to $2,000.',
      check: (db) => { const inv = one(db, 'SELECT * FROM solo_invoice ORDER BY id LIMIT 1');
        if (inv.status !== 'issued' || inv.total !== 300000) return `the issued invoice changed: ${inv.status} ${inv.total}`;
        if (one(db, 'SELECT COUNT(*) n FROM solo_invoice').n > 1) return 'a second invoice was created without being asked'; return true; } },
    { say: 'They paid $1,500 by bank transfer today, reference MER-88.',
      check: (db) => { const p = one(db, "SELECT * FROM solo_payment WHERE reference = 'MER-88'"); if (!p) return 'payment not recorded with its reference';
        if (p.amount !== 150000) return `amount ${p.amount}`;
        const open = one(db, "SELECT total - COALESCE((SELECT SUM(amount) FROM solo_payment_application WHERE invoice_id = i.id), 0) open FROM solo_invoice i WHERE status = 'issued' ORDER BY id LIMIT 1");
        if (!open || open.open !== 150000) return `invoice open ${open && open.open}: payment recorded but not applied`; return true; } },
    { say: "What's still open?",
      check: (db, calls) => calls.some(c => c.ok && /outstanding|statement|get_invoice/.test(c.name)) || 'answered without reading the books' },
  ],
};
