#!/usr/bin/env node
'use strict';
/**
 * Saybooks workbench — surface #2, over the same registry.
 *
 * Workspace comes per request: ?ws=peter, remembered in a cookie. The same person's agent
 * session (OTC_WORKSPACE=peter) and browser tab therefore see the same rows — the whole
 * point of the pairing — while contributors never see each other's test data.
 * Localhost only, single trusted machine, no auth; the workspace is isolation of data,
 * not a security boundary.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const R = require('./src/registry.js');
const C = require('./src/conformance.js');
const wsp = require('./src/workspace.js');
const BASE = require('./src/base-doctrine.js');
const H = require('./src/db.js');
const CFG = require('./src/config.js');
const members = require('./src/members.js');
const users = require('./src/users.js');
const auth = require('./src/auth.js');

R.loadModules();

const PORT = Number(process.env.SAYBOOKS_PORT || process.env.OTC_PORT || 8140);
/**
 * Demo mode (OTC_DEMO=1): the hosted try-it deployment. Public bind; every visitor gets a
 * private sandbox workspace seeded with a story (fixtures/try.json), pinned by cookie, never
 * shown anyone else's data, and swept after 24h. The registry, guards and audit trail are the
 * real ones — the demo IS the product, scoped to a throwaway database per visitor.
 */
const DEMO = (process.env.SAYBOOKS_DEMO || process.env.OTC_DEMO) === '1';
const HOST = DEMO ? '0.0.0.0' : '127.0.0.1';
const UI = path.join(__dirname, 'ui');
const crypto = require('crypto');

const sandboxExists = (name) => fs.existsSync(path.join(wsp.DATA_DIR, `ws_${name}.db`));
// Sandbox flavor rides in the NAME: try-h… is a jobhunt demo (hunt mounts, hunt story),
// anything else is the business demo. 'h' is not a hex digit, so random names never collide.
const seedSandbox = (name) => {
  const fixture = name.startsWith('try-h') ? 'hunttry' : name.startsWith('try-s') ? 'solotry' : 'try';
  require('./src/fixtures.js').load(fixture, name);
  return name;
};

// Anonymous demo sandboxes mount the business modules only — jobhunt is a personal area
// and belongs to owned spaces (where it mounts in full, data or no data).
const DEMO_MOUNTS = ['core', 'o2c', 'crm'];
const HUNT_MOUNTS = ['core', 'jobhunt'];   // the free job-hunt offering: one module + the platform
const SOLO_MOUNTS = ['core', 'solo'];      // the freelancer invoice generator
const KIND_MOUNTS = { hunt: HUNT_MOUNTS, solo: SOLO_MOUNTS };
const mountsFor = (w) => { try {
  const sp = users.spaceOf(w);
  if (sp) return KIND_MOUNTS[sp.kind] || null;
  if (!DEMO) return null;
  return w.startsWith('try-h') ? HUNT_MOUNTS : w.startsWith('try-s') ? SOLO_MOUNTS : DEMO_MOUNTS;
} catch { return null; } };
const FLAVOR_PREFIX = { hunt: 'h', solo: 's' };   // both non-hex, so random names never collide
const newVisitorWs = (flavor) => seedSandbox(`try-${FLAVOR_PREFIX[flavor] || ''}${crypto.randomBytes(5).toString('hex')}`);

if (DEMO) {
  // Sweep: sandboxes older than 24h go; if a crowd shows up, cap at the 4000 newest.
  // (A sandbox is a few hundred KB; the cap protects against runaway scripts, not visitors —
  // 400 proved too tight the day the first X thread landed.)
  const sweep = () => {
    try {
      const tries = wsp.list().filter(w => w.startsWith('try-') && !users.isOwnedSpace(w))
        .map(w => ({ w, at: wsp.ageOf(w) })).sort((a, b) => b.at - a.at);
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const t of tries.slice(4000)) { wsp.destroy(t.w); members.purge(t.w); }
      for (const t of tries.slice(0, 4000)) if (t.at < cutoff) { wsp.destroy(t.w); members.purge(t.w); }
      // Evidence, not analytics: the sweep destroys the files that prove yesterday's traffic,
      // so it writes one line of what it saw. data/ is the volume — the series survives deploys.
      const live = wsp.list().filter(w => w.startsWith('try-') && !users.isOwnedSpace(w)).length;
      fs.appendFileSync(path.join(wsp.DATA_DIR, 'metrics.csv'), `${new Date().toISOString()},${live}\n`);
    } catch (e) { console.error('sweep failed:', e.message); }
  };
  setInterval(sweep, 30 * 60 * 1000).unref();
  sweep();
}

const send = (res, code, body, type = 'application/json; charset=utf-8', headers = {}) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

/**
 * Who is here, and where: resolves the request to { ws, member: {name, role} }.
 * Three demo entries, in priority order:
 *   ?join=<member-token>  — accept an invite; cookie re-pins to the token
 *   ?ws=try-* / legacy    — bare sandbox name = owner access (the original capability;
 *                            still the frictionless anonymous entry)
 *   cookie                — a member token or a legacy sandbox name
 * Locally everything is the owner; identity games are a demo/multi-user concern.
 */
const entryOf = (req, url, allowMint = false) => {
  if (!DEMO) {
    const q = url.searchParams.get('ws');
    if (q) return { ws: q, member: { name: process.env.USER || 'operator', role: 'owner' } };
    const m = /(?:^|;\s*)otc_ws=([a-z0-9_-]+)/.exec(req.headers.cookie || '');
    return { ws: m ? m[1] : 'main', member: { name: process.env.USER || 'operator', role: 'owner' } };
  }
  const join = url.searchParams.get('join');
  if (join) {
    const m = members.resolve(join);
    if (m && sandboxExists(m.workspace)) return { ws: m.workspace, member: m, cookie: join };
  }
  // Signed-in users: named spaces, persistent, owned. ?ws= may select any space they can
  // reach (or a try-* capability, which stays a capability); the choice sticks via sb_space.
  const user = auth.enabled() && auth.sessionUser(req);
  if (user) {
    const spaces = users.spacesFor(user.id);
    const pick = url.searchParams.get('ws') || (/(?:^|;\s*)sb_space=([a-z0-9-]+)/.exec(req.headers.cookie || '') || [])[1];
    let ws = null, role = null;
    if (pick && /^try-[a-z0-9]{6,24}$/.test(pick)) { if (!sandboxExists(pick)) seedSandbox(pick); ws = pick; role = 'owner'; }
    else if (pick) { role = users.roleFor(user.id, pick); if (role && sandboxExists(pick)) ws = pick; }
    if (!ws) {
      const first = spaces[0];
      if (first) { ws = first.ws; role = first.role; if (!sandboxExists(ws)) wsp.dbFor(ws); }
      else { const sp = users.createSpace(user.id, 'My books'); seedSandbox(sp.ws); ws = sp.ws; role = 'owner'; }
    }
    return { ws, member: { name: user.name || user.email.split('@')[0], role, email: user.email }, user, spaces, spaceCookie: ws };
  }
  const q = url.searchParams.get('ws');
  if (q && /^try-[a-z0-9]{6,24}$/.test(q)) {
    if (!sandboxExists(q)) { if (!birthAllowed(ipOf(req))) throw Object.assign(new Error('sandbox limit reached for now — try again in an hour'), { status: 429 }); seedSandbox(q); }
    return { ws: q, member: { name: 'owner', role: 'owner' }, cookie: q };
  }
  // A private space's link, signed out: never a minted demo in its place (found 2026-09-04 —
  // the address bar said one space, the page showed another). Sign in, then the link works.
  if (q) throw Object.assign(new Error('this link opens a private space — sign in to open it'), { status: 401 });
  const ck = /(?:^|;\s*)otc_ws=([a-z0-9-]+)/.exec(req.headers.cookie || '');
  if (ck) {
    const m = members.resolve(ck[1]);
    if (m && sandboxExists(m.workspace)) return { ws: m.workspace, member: m, cookie: ck[1] };
    if (/^try-[a-z0-9]+$/.test(ck[1]) && sandboxExists(ck[1])) return { ws: ck[1], member: { name: 'owner', role: 'owner' }, cookie: ck[1] };
  }
  // Minting is DELIBERATE: only the SPA's own bootstrap call births a sandbox. A cookie-less
  // request to any other path gets a wsless entry — scanners were minting hundreds of
  // databases a day and drowning the birth metric in noise (found 2026-08-26).
  if (!allowMint) return { ws: null, member: { name: 'visitor', role: 'viewer' } };
  if (!birthAllowed(ipOf(req))) throw Object.assign(new Error('sandbox limit reached for now — try again in an hour'), { status: 429 });
  const fresh = newVisitorWs(url.searchParams.get('demo'));
  return { ws: fresh, member: { name: 'owner', role: 'owner' }, cookie: fresh };
};

const walks = new Map();          // walkthrough ordering: workspace -> next expected step

/** The printable invoice, rendered server-side for /doc links — same look as the workbench's
 *  print view. The esc() matters: everything here is user-entered text on a public-ish URL. */
const { renderInvoiceHtml, renderInvoicePdf } = require('./src/document.js');

/**
 * Demo abuse guard — deliberately light: a token bucket per IP for requests, and a separate
 * hourly cap on sandbox creation (each sandbox is a database on disk). nginx supplies
 * X-Forwarded-For. Honest scope: this keeps a stray script from being expensive; it is not
 * DDoS protection, which lives at other layers.
 */
const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const buckets = new Map();        // ip -> { tokens, at }   (300 req / 5 min)
const births = new Map();         // ip -> [timestamps]     (20 sandboxes / hour)
function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: 300, at: now };
  b.tokens = Math.min(300, b.tokens + (now - b.at) * (300 / 300000));
  b.at = now;
  if (b.tokens < 1) { buckets.set(ip, b); return true; }
  b.tokens -= 1; buckets.set(ip, b);
  return false;
}
function birthAllowed(ip) {
  const now = Date.now();
  const list = (births.get(ip) || []).filter(t => now - t < 3600000);
  if (list.length >= 20) { births.set(ip, list); return false; }
  list.push(now); births.set(ip, list);
  return true;
}
if (DEMO) setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.at > 600000) buckets.delete(ip);
  for (const [ip, l] of births) if (!l.some(t => now - t < 3600000)) births.delete(ip);
}, 600000).unref();

const server = http.createServer(async (req, res) => {
  CFG.learn(req);   // the public origin, for links handed to people
  const host = (req.headers.host || '').split(':')[0];
  if (!DEMO && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return send(res, 403, { error: 'localhost only' });
  if (DEMO && rateLimited(ipOf(req))) return send(res, 429, { error: 'slow down — this is a demo, and it is being fair to everyone else' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // Google sign-in (hosted demo only; a local workbench has no auth and needs none).
  if (DEMO && auth.enabled()) {
    if (p === '/auth/google') return auth.loginRedirect(res, url.searchParams.get('next'), url.searchParams.get('ws'));
    if (p === '/auth/google/callback') { auth.callback(req, res, url).catch(e => { console.error('[auth]', e); if (!res.headersSent) send(res, 500, { error: 'login failed' }); }); return undefined; }
    if (p === '/auth/logout') return auth.logout(req, res);
  }

  // Hosted MCP: /mcp/<workspace>. The workspace is the URL — no cookie, no session store.
  // In demo mode only try-* names are addressable, and an unknown one is seeded on first
  // contact so an agent can arrive before a browser ever has.
  const mcpMatch = /^\/mcp(?:\/([a-z0-9][a-z0-9_-]{0,40}))?$/.exec(p);
  if (mcpMatch) {
    let mws = mcpMatch[1] || (DEMO ? null : 'main');
    let mMember = { name: 'owner', role: 'owner' };
    if (DEMO) {
      const tok = mws && members.resolve(mws);
      if (tok && sandboxExists(tok.workspace)) { mws = tok.workspace; mMember = tok; }
      else if (mws && /^try-[a-z0-9]{6,24}$/.test(mws)) {
        if (!sandboxExists(mws)) {
          if (!birthAllowed(ipOf(req))) return send(res, 429, { error: 'sandbox limit reached for now — try again in an hour' });
          seedSandbox(mws);
        }
      }
      else {
        return send(res, 404, { error: 'connect to /mcp/<your-sandbox> or /mcp/<member-token> — the browser demo at https://saybooks.io shows yours' });
      }
    }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { return send(res, 400, { error: 'invalid JSON body' }); }
      if (DEMO && /^try-/.test(mws) && !users.isOwnedSpace(mws)) require('./src/telemetry.js').record(mws, 'agent');
      require('./src/mcp-http.js').handleMcp(req, res, body, mws, DEMO, mMember, mountsFor(mws))
        .catch(e => { if (!res.headersSent) send(res, 500, { error: e.message }); });
    });
    return undefined;
  }

  // The document link (S-7): a capability to view ONE issued invoice, nothing else. No
  // cookie, no session — the URL is workspace + per-invoice token, both required.
  const docMatch = /^\/doc\/([a-z0-9-]{4,40})\/([a-f0-9]{24})(\.pdf)?$/.exec(p);
  if (docMatch && req.method === 'GET') {
    const [, dws, dtok, wantPdf] = docMatch;
    if (!sandboxExists(dws)) return send(res, 404, 'Not found', 'text/plain');
    try {
      // Drafts render too, marked DRAFT — the preview a person sees before the point of no return (S-7).
      const { v, logo } = wsp.use(dws, () => {
        const inv = H.db().prepare('SELECT id FROM solo_invoice WHERE doc_token = ? AND status IN (\'draft\',\'issued\',\'paid\',\'void\')').get(dtok);   // void stays readable, stamped
        if (!inv) return {};
        // Branding, not a fact: the logo is read live, never from the frozen blocks.
        return { v: require('./src/modules/solo/views.js').invoiceView(inv.id), logo: (H.db().prepare('SELECT logo FROM company_profile WHERE id = 1').get() || {}).logo || null };
      });
      if (!v) return send(res, 404, 'Not found', 'text/plain');
      if (!wantPdf) return send(res, 200, renderInvoiceHtml(v, logo), 'text/html; charset=utf-8');
      if (v.status === 'draft') return send(res, 409, 'A draft has no final numbers — issue it first, then the PDF exists.', 'text/plain');
      const pdf = await renderInvoicePdf(v, logo);
      return send(res, 200, pdf, 'application/pdf', { 'content-disposition': `inline; filename="${v.id}.pdf"` });
    } catch (e) { console.error('[doc]', e.message); return send(res, 404, 'Not found', 'text/plain'); }
  }

  // A private space's link. Signed out: a door that comes back here after sign-in. Signed in
  // but not a member: say so, never silently open a different space.
  const wsParam = url.searchParams.get('ws');
  if (DEMO && (p === '/app' || p === '/app/') && req.method === 'GET' && auth.enabled() && wsParam && !/^try-/.test(wsParam)) {
    const u = auth.sessionUser(req);
    if (u && users.roleFor(u.id, wsParam)) { /* a member: fall through to the workbench */ }
    else {
      const signedIn = !!u;
      return send(res, signedIn ? 403 : 401, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saybooks — a private space</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"><style>
  body{font:16px/1.55 'IBM Plex Sans',-apple-system,'Segoe UI',sans-serif;color:hsl(215 40% 16%);background:hsl(210 20% 98%);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .wrap{max-width:560px;padding:2em} .mark{font-weight:700;letter-spacing:.14em;font-size:14px}
  h1{font-weight:700;letter-spacing:-.015em;font-size:26px;margin:.6em 0 .4em} p{color:hsl(215 20% 36%);margin:0 0 1.4em}
  a.btn{display:inline-block;background:hsl(215 60% 22%);color:#fff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:6px}
  .back{margin-top:2em;font-size:13px} .back a{color:hsl(215 15% 46%)}</style></head><body><div class="wrap">
  <div class="mark">SAYBOOKS</div>
  ${signedIn
    ? `<h1>You're not a member of this space.</h1><p>The link points to a private space that ${u.email} has no role in. Ask its owner for an invitation, or open your own books.</p><a class="btn" href="/app">Open my books</a>`
    : `<h1>This link opens a private space.</h1><p>Sign in with the Google account that has access, and you'll land in it.</p><a class="btn" href="/auth/google?ws=${encodeURIComponent(wsParam)}">Sign in with Google →</a>`}
  <div class="back"><a href="/">← saybooks.io</a></div>
</div></body></html>`, 'text/html; charset=utf-8');
    }
  }
  if (DEMO && (p === '/app' || p === '/app/') && req.method === 'GET' && url.searchParams.get('notmember')) {
    return send(res, 302, '', 'text/plain', { location: '/app?ws=' + encodeURIComponent(url.searchParams.get('notmember')) });
  }

  // Sign-in-first door: an anonymous FIRST visit to /app gets a choice, never a silent
  // sandbox. Returning visitors (cookie), joins, ?ws links, and ?demo skip straight through.
  if (DEMO && (p === '/app' || p === '/app/') && req.method === 'GET'
      && auth.enabled() && !auth.sessionUser(req)
      && !url.searchParams.get('join') && !url.searchParams.get('ws') && !url.searchParams.has('demo')
      && !/(?:^|;\s*)otc_ws=/.test(req.headers.cookie || '')) {
    return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saybooks — whose books?</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"><style>
  body{font:16px/1.55 'IBM Plex Sans',-apple-system,'Segoe UI',sans-serif;color:hsl(215 40% 16%);background:hsl(210 20% 98%);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .wrap{max-width:700px;padding:2em}
  .mark{font-family:'IBM Plex Sans',sans-serif;font-weight:700;letter-spacing:.06em;font-size:14px} .tag{color:hsl(215 15% 46%);font-size:13px;margin-bottom:2.4em}
  h1{font-family:'IBM Plex Sans',sans-serif;font-weight:700;letter-spacing:-.02em;font-size:30px;margin:.2em 0 1.1em}
  .doors{display:flex;gap:16px;flex-wrap:wrap}
  a.door{flex:1;min-width:250px;text-decoration:none;color:inherit;border-radius:8px;padding:1.3em 1.4em;background:#fff;border:1px solid hsl(215 25% 88%)}
  a.door:hover{border-color:hsl(215 60% 22%)} a.door b{display:block;margin-bottom:.4em;font-family:'IBM Plex Sans',sans-serif;font-size:18px;font-weight:700}
  a.door span{font-size:13.5px;color:hsl(215 20% 36%)}
  .in b{color:hsl(215 60% 22%)} .back{margin-top:2.2em;font-size:13px}
  .back a{color:hsl(215 15% 46%)}</style></head><body><div class="wrap">
  <div class="mark" style="display:flex;align-items:center;gap:7px"><svg class="wv" width="16" height="18" viewBox="0 0 22 26" fill="none" stroke="hsl(215 60% 22%)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 10a5 5 0 0 1 0 6" opacity=".3"/><path d="M10.5 7a9.5 9.5 0 0 1 0 12" opacity=".6"/><path d="M16.5 3.5a14.5 14.5 0 0 1 0 19"/></svg><span>SAYBOOKS</span><svg class="wv" width="16" height="18" viewBox="0 0 22 26" fill="none" stroke="hsl(215 60% 22%)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 10a5 5 0 0 1 0 6"/><path d="M10.5 7a9.5 9.5 0 0 1 0 12" opacity=".6"/><path d="M16.5 3.5a14.5 14.5 0 0 1 0 19" opacity=".3"/></svg></div><div class="tag">the books you can talk to — that stay books</div>
  <h1>Whose books are these?</h1>
  <div class="doors">
    <a class="door in" href="/auth/google"><b>Sign in with Google →</b><span>Your own space: named, persistent, private. Invite people by email, mint keys for agents — every act on the record.</span></a>
    <a class="door" href="/app?demo=1"><b>Try the demo</b><span>A private sandbox seeded with example data, swept after 24 hours. No account — and if you sign in later, you keep it.</span></a>
  </div>
  <div class="back"><a href="/">← saybooks.io</a></div>
</div></body></html>`, 'text/html; charset=utf-8');
  }

  let entry;
  try { entry = entryOf(req, url, req.method === 'GET' && p === '/api/registry'); }
  catch (e) { return send(res, e.status || 500, { error: e.message }); }
  const ws = entry.ws, member = entry.member;
  if (!ws && p.startsWith('/api')) {
    return send(res, 401, { error: 'no active books — open https://saybooks.io/app to start' });
  }
  const cookie = !ws ? {} : { 'set-cookie': entry.user
    ? `sb_space=${entry.spaceCookie}; Path=/; SameSite=Lax; Max-Age=${180 * 86400}`
    : `otc_ws=${entry.cookie || ws}; Path=/; SameSite=Lax` };

  try {
    // The whole UI contract: the command specs, plus enough master data for the lookups.
    if (req.method === 'GET' && p === '/api/registry') {
      // The "opened the app" event — a JS-executing browser bootstrapping the SPA.
      if (DEMO && /^try-/.test(ws) && !users.isOwnedSpace(ws)) require('./src/telemetry.js').record(ws, 'read');
      const mounts = mountsFor(ws);
      return wsp.use(ws, () => send(res, 200, {
        workspace: ws,
        demo: DEMO,
        auth_enabled: DEMO && auth.enabled(),
        user: entry.user ? { name: entry.user.name, email: entry.user.email, picture: entry.user.picture } : null,
        space: entry.user ? (users.spaceOf(ws) ? users.spaceOf(ws).display_name : ws) : null,
        spaces: entry.user ? entry.spaces.map(sp => ({ ws: sp.ws, name: sp.display_name, role: sp.role })) : undefined,
        member: { name: member.name, role: member.role },
        grants: [...(R.ROLE_GRANTS[member.role] || R.ROLE_GRANTS.viewer)],
        workspaces: DEMO ? [ws] : [...new Set([ws, ...wsp.list()])].filter(w => w === ws || !/^(spec-|test-|try-)/.test(w)).sort(),
        doctrine: R.instructions(BASE, { modules: mounts }),
        modules: R.MODULES.filter(m => !mounts || mounts.includes(m.name)).map(m => ({ name: m.name, doctrine: m.doctrine.trim() })),
        commands: R.formSpec({ modules: mounts }),
        // Presentation bootstrap, not a command: the Orders table's rows. Agents get the
        // same facts through o2c_backorders / core_search / o2c_get_order.
        orders: H.db().prepare(`SELECT o.*, c.name AS customer_name,
            (SELECT COALESCE(SUM(qty*unit_price),0) FROM order_line WHERE order_id = o.id) AS total
          FROM "order" o JOIN customer c ON c.id = o.customer_id ORDER BY o.id DESC`).all(),
        items: H.db().prepare('SELECT * FROM item ORDER BY id').all(),
        solo_invoices: H.db().prepare(`SELECT i.id, i.status, i.total, i.issued_at, i.due_at, c.name AS customer_name,
            i.total - COALESCE((SELECT SUM(amount) FROM solo_payment_application WHERE invoice_id = i.id), 0) AS open
          FROM solo_invoice i JOIN customer c ON c.id = i.customer_id ORDER BY i.id DESC`).all(),
        lookups: {
          customer: H.db().prepare('SELECT id, name AS label FROM customer ORDER BY name').all(),
          item:     H.db().prepare('SELECT id, name AS label FROM item ORDER BY id').all(),
          order:    H.db().prepare('SELECT id, id AS label FROM "order" ORDER BY id DESC').all(),
          quote:    H.db().prepare('SELECT id, id AS label FROM quote ORDER BY id DESC').all(),
          invoice:  H.db().prepare('SELECT id, id AS label FROM invoice ORDER BY id DESC').all(),
          payment:  H.db().prepare('SELECT id, id AS label FROM payment ORDER BY id DESC').all(),
          credit_note: H.db().prepare('SELECT id, id AS label FROM credit_note ORDER BY id DESC').all(),
          account:  H.db().prepare('SELECT id, name AS label FROM account ORDER BY name').all(),
          campaign: H.db().prepare('SELECT id, name AS label FROM campaign ORDER BY status = \'active\' DESC, name').all(),
        },
        areas: R.MODULES.filter(m => m.implements && (!mounts || mounts.includes(m.name))).map(m => m.implements.area),
      }, undefined, cookie));
    }
    // Operator dashboard data — gated to the SAYBOOKS_ADMIN Google account, nobody else.
    if (req.method === 'GET' && p === '/api/admin/stats') {
      const admin = process.env.SAYBOOKS_ADMIN;
      const u = auth.enabled() && auth.sessionUser(req);
      if (!admin || !u || u.email.toLowerCase() !== admin.toLowerCase()) return send(res, 403, { error: 'admin only' });
      try {
        const born = fs.readdirSync(wsp.DATA_DIR).filter(f => /^ws_try-.*\.db$/.test(f)).length;
        let funnel = { touched: 0, engaged: 0, wrote: 0, agent: 0 };
        let top = [];
        try {
          const tdb = require('./src/telemetry.js').db();
          // Engaged = came back for more after the first render: 3+ calls AND 30+ seconds of
          // dwell. A single page load fires up to 3 calls in half a second — that is not engagement.
          funnel = tdb.prepare(`SELECT COUNT(*) touched,
            COALESCE(SUM(api_calls >= 3 AND (julianday(last_at) - julianday(first_at)) * 86400 >= 30),0) engaged,
            COALESCE(SUM(writes > 0),0) wrote, COALESCE(SUM(agent_calls > 0),0) agent FROM ws_activity`).get();
          top = tdb.prepare('SELECT ws, first_at, last_at, api_calls, writes, agent_calls FROM ws_activity ORDER BY api_calls DESC LIMIT 12').all();
        } catch { /* telemetry not born yet */ }
        const udb = users.db();
        const allUsers = udb.prepare('SELECT id, email, name, created_at FROM user ORDER BY created_at DESC LIMIT 100').all()
          .map(u2 => ({ ...u2, spaces: udb.prepare('SELECT ws, display_name, kind, created_at FROM space WHERE owner_user_id = ? ORDER BY created_at').all(u2.id) }));
        const huntSpaces = udb.prepare("SELECT COUNT(*) n FROM space WHERE kind = 'hunt'").get().n;
        let metrics = [];
        try {
          metrics = fs.readFileSync(path.join(wsp.DATA_DIR, 'metrics.csv'), 'utf8').split('\n')
            .filter(l => /^\d{4}-/.test(l)).map(l => { const [t2, n2] = l.split(','); return [t2, Number(n2)]; });
        } catch { /* no metrics yet */ }
        return send(res, 200, {
          as_of: new Date().toISOString(),
          funnel: { live_sandboxes_under_24h: born, opened_app: funnel.touched, engaged_3plus_calls: funnel.engaged,
            wrote_something: funnel.wrote, agent_connected: funnel.agent,
            google_sign_ins: allUsers.length, hunt_spaces: huntSpaces },
          users: allUsers, top_active: top, metrics,
          notes: ['telemetry starts 2026-08-26; earlier sandboxes show as untouched',
            'birth counts before the 2026-08-26 mint-gate fix are scanner-noise-dominated',
            'sign-ins include the founder'],
        });
      } catch (e) { return send(res, 500, { error: e.message }); }
    }

    // The whole workspace as one JSON document — every table, audit log included. Owner only.
    // "Your data is yours" is a claim; this is the mechanism.
    if (req.method === 'GET' && p === '/api/export') {
      if (member.role !== 'owner') return send(res, 403, { error: 'export is owner-only' });
      return wsp.use(ws, () => {
        const db2 = H.db();
        const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
        const dump = { exported_at: new Date().toISOString(), workspace: ws, tables: {} };
        for (const t2 of tables) dump.tables[t2] = db2.prepare(`SELECT * FROM "${t2}"`).all();
        return send(res, 200, JSON.stringify(dump, null, 1), 'application/json; charset=utf-8',
          { 'content-disposition': `attachment; filename="saybooks-export-${ws}-${new Date().toISOString().slice(0, 10)}.json"` });
      });
    }
    // Permanent space deletion — the other half of "your data is yours". Owner only, and the
    // workspace database, capability tokens, and space rows all go together.
    if (req.method === 'POST' && p === '/api/space/delete' && entry.user) {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
        const target = String(body.ws || '');
        if (!users.spaceOf(target)) return send(res, 404, { error: 'not a space' });
        if (!users.deleteSpace(target, entry.user.id)) return send(res, 403, { error: 'only the owner can delete a space' });
        try { wsp.destroy(target); } catch (e) { console.error('space delete: db removal failed:', e.message); }
        members.purge(target);
        return send(res, 200, { ok: true, deleted: target }, undefined,
          { 'set-cookie': 'sb_space=; Path=/; Max-Age=0' });
      });
      return undefined;
    }
    if (req.method === 'POST' && p === '/api/space/create' && entry.user) {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) return send(res, 400, { error: 'a space needs a name' });
        const sp = users.createSpace(entry.user.id, name);
        wsp.dbFor(sp.ws);                       // empty books; Reset loads demo data if wanted
        return send(res, 200, { ws: sp.ws, name: sp.display_name });
      });
      return undefined;
    }

    // The spec, as a live object: status from the last full run, acts from the implements
    // map, scenarios with their step-by-step evidence.
    if (req.method === 'GET' && p === '/api/spec') {
      const area = url.searchParams.get('area') || 'o2c';
      return send(res, 200, { report: C.lastReport(area), spec: C.specOf(area) });
    }
    // The walkthrough: the step list (with args already translated to command arguments)
    // for the UI to render as filled forms, and one-step execution with ordering enforced.
    if (req.method === 'GET' && p === '/api/spec/plan') {
      try { return send(res, 200, C.walkPlan(url.searchParams.get('area') || 'o2c', url.searchParams.get('file'))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/spec/walk') {
      const area = url.searchParams.get('area') || 'o2c';
      const file = url.searchParams.get('file');
      const step = Number(url.searchParams.get('step') || 0);
      const walkWs = `${ws}-walk`.slice(0, 41);
      const expected = walks.get(walkWs) ?? 0;
      if (step !== 0 && step !== expected) {
        return send(res, 409, { error: `walkthrough is at step ${expected}; restart from 0 or continue in order` });
      }
      try {
        const result = C.walkStep(area, file, step, walkWs, { actor: DEMO ? 'visitor' : (process.env.USER || 'operator') });
        walks.set(walkWs, step + 1);
        if (result.done) walks.delete(walkWs);
        return send(res, 200, result);
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    // Replay one scenario live, right now, in its scratch workspace. This is the teaching
    // surface: the response is every step — act, command, args, doctrine, what came back.
    if (req.method === 'POST' && p === '/api/spec/replay') {
      const area = url.searchParams.get('area') || 'o2c';
      const file = url.searchParams.get('file');
      try {
        const result = C.runScenario(area, file, { actor: DEMO ? 'visitor' : (process.env.USER || 'operator'),
          wsSuffix: DEMO ? `-${crypto.randomBytes(3).toString('hex')}` : '' });
        if (!DEMO) C.runArea(area, { actor: process.env.USER || 'operator' });   // refresh persisted evidence
        else wsp.destroy(result.workspace);                                      // demo scratch: replay, show, discard
        return send(res, 200, result);
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && p === '/api/next-actions') {
      return wsp.use(ws, () => {
        try { return send(res, 200, R.nextActions(url.searchParams.get('type'), url.searchParams.get('id'), member.role)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      });
    }

    // One endpoint for every command. The UI cannot reach a handler any other way than the
    // agent does, which is the point — one choke point, one log, one set of rules.
    if (req.method === 'POST' && p.startsWith('/api/cmd/')) {
      const name = p.slice('/api/cmd/'.length);
      if (!R.byName[name]) return send(res, 404, { error: `unknown command ${name}` });
      const cmdMounts = mountsFor(ws);
      if (cmdMounts && !cmdMounts.includes(R.byName[name].module)) return send(res, 404, { error: `unknown command ${name}` });
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(); });
      req.on('end', async () => {
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid JSON body' }); }
        const { _reason, ...args } = body;
        if (DEMO && /^try-/.test(ws) && !users.isOwnedSpace(ws)) {
          require('./src/telemetry.js').record(ws, R.byName[name].intent === 'read' ? 'read' : 'write');
        }
        try {
          const result = await R.execute(name, await R.prepare(name, args), {
            workspace: ws, actor: member.name, actor_kind: 'human', role: member.role,
            session: `workbench-${ws}`, reason: _reason,
          });
          // Binary attachments are for agents; the workbench has the links. Report what was rendered, not the bytes.
          if (result && result._attachments) {
            const { _attachments, ...rest } = result;
            rest.attachments = _attachments.map(x => ({ kind: x.kind, mime: x.mime, name: x.name, bytes: Math.floor(x.data.length * 3 / 4) }));
            return send(res, 200, { ok: true, result: rest });
          }
          return send(res, 200, { ok: true, result });
        } catch (e) {
          return send(res, 400, { ok: false, error: e.message });
        }
      });
      return undefined;
    }
  } catch (e) {
    return send(res, 500, { error: e.message });
  }

  if (req.method === 'GET') {
    // In demo mode the root is the landing page and the workbench lives at /app;
    // locally the root stays the workbench.
    const file = p === '/' ? (DEMO ? 'landing.html' : 'index.html')
               : (p === '/app' || p === '/app/') ? 'index.html'
               : (p === '/hunt' || p === '/hunt/') ? 'hunt.html'
               : (p === '/solo' || p === '/solo/') ? 'solo.html'
               : (p === '/admin' || p === '/admin/') ? 'admin.html'
               : path.basename(p);
    const full = path.join(UI, file);
    if (full.startsWith(UI) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
                     '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ico': 'image/x-icon',
                     '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.gif': 'image/gif', '.mp4': 'video/mp4' };
      // The social card may be cached hard; everything else stays no-store.
      const headers = /\.(png|mp4)$/.test(full) ? { 'cache-control': 'public, max-age=86400' } : {};
      return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream', headers);
    }
  }
  return send(res, 404, { error: 'not found' });
});

// Conformance evidence self-heals at boot: the data volume can shadow anything baked into
// the image, and a Spec tab with report:null is a broken shop window. ~1s per area, once.
for (const m of R.MODULES.filter(m => m.implements)) {
  const area = m.implements.area;
  const prior = C.lastReport(area);
  if (!prior || prior.spec !== m.implements.spec) {
    try { C.runArea(area, { actor: 'startup' }); console.log(`conformance evidence generated for ${area}`); }
    catch (e) { console.error(`conformance ${area} failed at startup:`, e.message); }
  }
}

server.listen(PORT, HOST, () => {
  console.log(`${DEMO ? 'Saybooks demo' : 'Saybooks workbench'} → http://${HOST}:${PORT}   (workspaces in ${wsp.DATA_DIR})`);
});
