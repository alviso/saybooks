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
const seedSandbox = (name) => { require('./src/fixtures.js').load('try', name); return name; };
const newVisitorWs = () => seedSandbox(`try-${crypto.randomBytes(5).toString('hex')}`);

if (DEMO) {
  // Sweep: sandboxes older than 24h go; if a crowd shows up, cap at the 400 newest.
  const sweep = () => {
    try {
      const tries = wsp.list().filter(w => w.startsWith('try-') && !users.isOwnedSpace(w))
        .map(w => ({ w, at: wsp.ageOf(w) })).sort((a, b) => b.at - a.at);
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const t of tries.slice(400)) { wsp.destroy(t.w); members.purge(t.w); }
      for (const t of tries.slice(0, 400)) if (t.at < cutoff) { wsp.destroy(t.w); members.purge(t.w); }
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
const entryOf = (req, url) => {
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
  const ck = /(?:^|;\s*)otc_ws=([a-z0-9-]+)/.exec(req.headers.cookie || '');
  if (ck) {
    const m = members.resolve(ck[1]);
    if (m && sandboxExists(m.workspace)) return { ws: m.workspace, member: m, cookie: ck[1] };
    if (/^try-[a-z0-9]+$/.test(ck[1]) && sandboxExists(ck[1])) return { ws: ck[1], member: { name: 'owner', role: 'owner' }, cookie: ck[1] };
  }
  if (!birthAllowed(ipOf(req))) throw Object.assign(new Error('sandbox limit reached for now — try again in an hour'), { status: 429 });
  const fresh = newVisitorWs();
  return { ws: fresh, member: { name: 'owner', role: 'owner' }, cookie: fresh };
};

const walks = new Map();          // walkthrough ordering: workspace -> next expected step

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

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (!DEMO && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return send(res, 403, { error: 'localhost only' });
  if (DEMO && rateLimited(ipOf(req))) return send(res, 429, { error: 'slow down — this is a demo, and it is being fair to everyone else' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // Google sign-in (hosted demo only; a local workbench has no auth and needs none).
  if (DEMO && auth.enabled()) {
    if (p === '/auth/google') return auth.loginRedirect(res);
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
      require('./src/mcp-http.js').handleMcp(req, res, body, mws, DEMO, mMember)
        .catch(e => { if (!res.headersSent) send(res, 500, { error: e.message }); });
    });
    return undefined;
  }

  // Sign-in-first door: an anonymous FIRST visit to /app gets a choice, never a silent
  // sandbox. Returning visitors (cookie), joins, ?ws links, and ?demo skip straight through.
  if (DEMO && (p === '/app' || p === '/app/') && req.method === 'GET'
      && auth.enabled() && !auth.sessionUser(req)
      && !url.searchParams.get('join') && !url.searchParams.get('ws') && !url.searchParams.has('demo')
      && !/(?:^|;\s*)otc_ws=/.test(req.headers.cookie || '')) {
    return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saybooks — whose books?</title><style>
  body{font:16px/1.55 -apple-system,'Segoe UI',sans-serif;color:#1c2420;background:#f6f5f1;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .wrap{max-width:680px;padding:2em}
  .mark{font-weight:800;letter-spacing:.1em;font-size:14px} .tag{color:#6b7570;font-size:13px;margin-bottom:2.4em}
  h1{font-size:26px;margin:.2em 0 1.2em}
  .doors{display:flex;gap:16px;flex-wrap:wrap}
  a.door{flex:1;min-width:240px;text-decoration:none;color:inherit;border:1.5px solid #d8d5cc;border-radius:12px;padding:1.2em 1.3em;background:#fff}
  a.door:hover{border-color:#1e3a2f} a.door b{display:block;margin-bottom:.35em;font-size:17px}
  a.door span{font-size:13.5px;color:#5b665f}
  .in b{color:#1e3a2f} .back{margin-top:2.2em;font-size:13px}
  .back a{color:#5b665f}</style></head><body><div class="wrap">
  <div class="mark">SAYBOOKS</div><div class="tag">the books you can talk to — that stay books</div>
  <h1>Whose books are these?</h1>
  <div class="doors">
    <a class="door in" href="/auth/google"><b>Sign in with Google →</b><span>Your own space: named, persistent, private. Invite people by email, mint keys for agents — every act on the record.</span></a>
    <a class="door" href="/app?demo=1"><b>Try the demo</b><span>A private sandbox seeded with example data, swept after 24 hours. No account — and if you sign in later, you keep it.</span></a>
  </div>
  <div class="back"><a href="/">← saybooks.io</a></div>
</div></body></html>`, 'text/html; charset=utf-8');
  }

  let entry;
  try { entry = entryOf(req, url); }
  catch (e) { return send(res, e.status || 500, { error: e.message }); }
  const ws = entry.ws, member = entry.member;
  const cookie = { 'set-cookie': entry.user
    ? `sb_space=${entry.spaceCookie}; Path=/; SameSite=Lax; Max-Age=${180 * 86400}`
    : `otc_ws=${entry.cookie || ws}; Path=/; SameSite=Lax` };

  try {
    // The whole UI contract: the command specs, plus enough master data for the lookups.
    if (req.method === 'GET' && p === '/api/registry') {
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
        doctrine: R.instructions(BASE),
        modules: R.MODULES.map(m => ({ name: m.name, doctrine: m.doctrine.trim() })),
        commands: R.formSpec(),
        // Presentation bootstrap, not a command: the Orders table's rows. Agents get the
        // same facts through o2c_backorders / core_search / o2c_get_order.
        orders: H.db().prepare(`SELECT o.*, c.name AS customer_name,
            (SELECT COALESCE(SUM(qty*unit_price),0) FROM order_line WHERE order_id = o.id) AS total
          FROM "order" o JOIN customer c ON c.id = o.customer_id ORDER BY o.id DESC`).all(),
        items: H.db().prepare('SELECT * FROM item ORDER BY id').all(),
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
        areas: R.MODULES.filter(m => m.implements).map(m => m.implements.area),
      }, undefined, cookie));
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
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(); });
      req.on('end', () => {
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid JSON body' }); }
        const { _reason, ...args } = body;
        try {
          const result = R.execute(name, args, {
            workspace: ws, actor: member.name, actor_kind: 'human', role: member.role,
            session: `workbench-${ws}`, reason: _reason,
          });
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
