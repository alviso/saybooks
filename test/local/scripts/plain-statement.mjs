// A card statement, pasted in the way a chat client pastes an attached file, and three
// sentences a person would actually say. The rows are fictional and reconcile.
const ROWS = [
  ['2026-09-01', 'VERIZON WIRELESS PMT', -8912], ['2026-09-02', 'STARBUCKS #4471 PORTLAND OR', -675], ['2026-09-03', 'AMAZON WEB SERVICES', -14320],
  ['2026-09-04', 'CHEVRON 0091 BEAVERTON', -5210], ['2026-09-05', 'ADOBE *CREATIVE CLOUD', -5999], ['2026-09-08', 'NEW SEASONS MARKET', -8744],
  ['2026-09-09', 'UBER TRIP', -2380], ['2026-09-10', 'ZOOM.US', -1599], ['2026-09-11', 'OFFICE DEPOT #2210', -4360], ['2026-09-12', 'POWELLS BOOKS', -3250],
  ['2026-09-15', 'PAYMENT THANK YOU', 180000], ['2026-09-16', 'GITHUB INC', -400], ['2026-09-17', 'ALASKA AIR 0272', -31840], ['2026-09-18', 'HILTON PORTLAND', -42918],
  ['2026-09-19', 'LYFT RIDE', -1875], ['2026-09-22', 'COSTCO WHSE #0692', -21633], ['2026-09-23', 'SPOTIFY', -1199], ['2026-09-24', 'USPS PO 4102', -1120],
  ['2026-09-25', 'ANNUAL FEE', -9500], ['2026-09-26', 'INTEREST CHARGE', -2288],
];
const OPEN = -412055, CLOSE = OPEN + ROWS.reduce((s, r) => s + r[2], 0);
const m = (c) => `${c < 0 ? '-' : ''}$${Math.floor(Math.abs(c) / 100).toLocaleString('en-US')}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
const CSV = ['Harborline Studio LLC', 'Business Card ending 4421', 'Statement period: 2026-09-01 to 2026-09-30',
  `Previous balance,${m(OPEN)}`, `New balance,${m(CLOSE)}`, `Transactions,${ROWS.length}`, '', 'Date,Description,Amount',
  ...ROWS.map(r => `${r[0]},${r[1]},${m(r[2])}`)].join('\n');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);
export default {
  name: 'plain statement',
  mounts: ['core', 'purchases'],
  steps: [
    { say: `Here is my September card statement.\n\n${CSV}`,
      check: (db) => { const s = one(db, 'SELECT * FROM purch_source ORDER BY id DESC LIMIT 1'); if (!s) return 'nothing imported';
        if (s.rows_in !== 20) return `${s.rows_in} rows landed, not 20`;
        const sum = one(db, 'SELECT SUM(amount) s FROM purch_transaction WHERE source_id = ?', s.id).s;
        if (sum !== CLOSE - OPEN) return `rows sum to ${sum}, statement moves ${CLOSE - OPEN}`; return true; } },
    { say: 'Sort these into categories and tell me which ones are subscriptions. Show me before you write anything.',
      check: (db, calls, all) => { const n = one(db, "SELECT COUNT(*) n FROM purch_transaction WHERE status IS NOT NULL AND status != 'unreviewed'").n;
        if (n) return `${n} rows were written before the person saw the proposal`;
        if (!all.some(c => c.name === 'purch_vocabulary')) return 'proposed categories without ever reading the vocabulary'; return true; } },
    { say: 'Looks right, except the $1,800 payment is our own money from checking, not income. Go ahead and write it all.',
      check: (db) => { const left = one(db, "SELECT COUNT(*) n FROM purch_transaction WHERE status IS NULL OR status = 'unreviewed'").n;
        if (left) return `${left} rows still unreviewed`;
        const pay = one(db, "SELECT status, category FROM purch_transaction WHERE description LIKE 'PAYMENT%'");
        if (pay.status !== 'transfer') return `the card payment is ${pay.status}, not a transfer`;
        if (!/check/i.test(pay.category || '')) return `transfer category is "${pay.category}", not the checking account it came from`;
        const rec = one(db, "SELECT COUNT(*) n FROM purch_transaction WHERE status = 'recurring'").n; if (rec < 3) return `only ${rec} recurring, expected Adobe, Zoom, Spotify at least`;
        const fee = one(db, "SELECT COUNT(*) n FROM purch_transaction WHERE status = 'fee'").n; if (fee !== 2) return `${fee} fees, expected the annual fee and the interest charge`; return true; } },
    { say: 'What did I spend this month, and what am I subscribed to?',
      check: (db, calls) => calls.some(c => c.ok && /purch_spend|purch_subscriptions|purch_purchases/.test(c.name)) || 'answered without reading the books' },
  ],
};
