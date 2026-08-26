'use strict';
/**
 * The honest funnel: born → opened → engaged → wrote → agent → signed in → claimed.
 * Run inside the container: node scripts/engagement.js
 * Biases stated in the output — a report that hides its own blind spots is the thing
 * this exists to prevent.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const DATA = path.join(__dirname, '..', 'data');

const born = fs.readdirSync(DATA).filter(f => /^ws_try-.*\.db$/.test(f)).length;

let t = { touched: 0, engaged: 0, wrote: 0, agent: 0 };
try {
  const tdb = new Database(path.join(DATA, 'telemetry.db'), { readonly: true });
  t = tdb.prepare(`SELECT COUNT(*) touched, COALESCE(SUM(api_calls >= 3),0) engaged,
    COALESCE(SUM(writes > 0),0) wrote, COALESCE(SUM(agent_calls > 0),0) agent FROM ws_activity`).get();
} catch { /* telemetry.db not born yet */ }

let users = { signed_in: 0, claimed: 0, spaces: 0 };
try {
  const udb = new Database(path.join(DATA, 'users.db'), { readonly: true });
  users = {
    signed_in: udb.prepare('SELECT COUNT(*) n FROM user').get().n,
    claimed: udb.prepare("SELECT COUNT(*) n FROM space WHERE ws LIKE 'try-%'").get().n,
    spaces: udb.prepare('SELECT COUNT(*) n FROM space').get().n,
  };
} catch { /* no users store */ }

console.log(JSON.stringify({
  as_of: new Date().toISOString(),
  live_sandboxes_under_24h: born,
  opened_app: t.touched,          // registry bootstrap or any command — JS-executing browser or agent
  engaged_3plus_calls: t.engaged, // clicked around: three or more API calls
  wrote_something: t.wrote,       // submitted a form / agent write
  agent_connected: t.agent,       // MCP requests against the sandbox
  google_sign_ins: users.signed_in,
  sandboxes_claimed: users.claimed,
  owned_spaces_total: users.spaces,
  honesty_notes: [
    'telemetry starts 2026-08-26; sandboxes born before that show opened_app=0 even if visited',
    'live_sandboxes counts births in the trailing 24h only (the sweep deletes older)',
    'before the mint-gate fix (2026-08-26) cookie-less scanner requests also minted sandboxes; birth counts before then are noise-dominated',
    'sign-ins/claims include the founder',
  ],
}, null, 2));
