#!/usr/bin/env node
'use strict';
/**
 * otc workbench — surface #2, over the same registry.
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

R.loadModules();

const PORT = Number(process.env.OTC_PORT || 8140);
/**
 * Demo mode (OTC_DEMO=1): the hosted try-it deployment. Public bind; every visitor gets a
 * private sandbox workspace seeded with a story (fixtures/try.json), pinned by cookie, never
 * shown anyone else's data, and swept after 24h. The registry, guards and audit trail are the
 * real ones — the demo IS the product, scoped to a throwaway database per visitor.
 */
const DEMO = process.env.OTC_DEMO === '1';
const HOST = DEMO ? '0.0.0.0' : '127.0.0.1';
const UI = path.join(__dirname, 'ui');
const crypto = require('crypto');

const newVisitorWs = () => {
  const ws = `try-${crypto.randomBytes(5).toString('hex')}`;
  require('./src/fixtures.js').load('try', ws);
  return ws;
};

if (DEMO) {
  // Sweep: sandboxes older than 24h go; if a crowd shows up, cap at the 400 newest.
  const sweep = () => {
    try {
      const tries = wsp.list().filter(w => w.startsWith('try-'))
        .map(w => ({ w, at: wsp.ageOf(w) })).sort((a, b) => b.at - a.at);
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const t of tries.slice(400)) wsp.destroy(t.w);
      for (const t of tries.slice(0, 400)) if (t.at < cutoff) wsp.destroy(t.w);
    } catch (e) { console.error('sweep failed:', e.message); }
  };
  setInterval(sweep, 30 * 60 * 1000).unref();
  sweep();
}

const send = (res, code, body, type = 'application/json; charset=utf-8', headers = {}) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const wsOf = (req, url) => {
  if (DEMO) {
    // Cookie only, and only try-* names: visitors cannot address each other's sandboxes.
    const m = /(?:^|;\s*)otc_ws=(try-[a-z0-9]+)/.exec(req.headers.cookie || '');
    if (m && fs.existsSync(path.join(wsp.DATA_DIR, `ws_${m[1]}.db`))) return m[1];
    return newVisitorWs();
  }
  const q = url.searchParams.get('ws');
  if (q) return q;
  const m = /(?:^|;\s*)otc_ws=([a-z0-9_-]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : 'main';
};

const walks = new Map();          // walkthrough ordering: workspace -> next expected step

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (!DEMO && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return send(res, 403, { error: 'localhost only' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const ws = wsOf(req, url);
  const cookie = { 'set-cookie': `otc_ws=${ws}; Path=/; SameSite=Lax` };

  try {
    // The whole UI contract: the command specs, plus enough master data for the lookups.
    if (req.method === 'GET' && p === '/api/registry') {
      return wsp.use(ws, () => send(res, 200, {
        workspace: ws,
        demo: DEMO,
        workspaces: DEMO ? [ws] : [...new Set([ws, ...wsp.list()])].filter(w => w === ws || !/^(spec-|test-|try-)/.test(w)).sort(),
        doctrine: R.instructions(BASE),
        modules: R.MODULES.map(m => ({ name: m.name, doctrine: m.doctrine.trim() })),
        commands: R.formSpec(),
        // Presentation bootstrap, not a command: the Orders table's rows. Agents get the
        // same facts through o2c_backorders / core_search / o2c_get_order.
        orders: H.db().prepare(`SELECT o.*, c.name AS customer_name,
            (SELECT COALESCE(SUM(qty*unit_price),0) FROM order_line WHERE order_id = o.id) AS total
          FROM "order" o JOIN customer c ON c.id = o.customer_id ORDER BY o.id DESC`).all(),
        lookups: {
          customer: H.db().prepare('SELECT id, name AS label FROM customer ORDER BY name').all(),
          item:     H.db().prepare('SELECT id, name AS label FROM item ORDER BY id').all(),
          order:    H.db().prepare('SELECT id, id AS label FROM "order" ORDER BY id DESC').all(),
          quote:    H.db().prepare('SELECT id, id AS label FROM quote ORDER BY id DESC').all(),
          invoice:  H.db().prepare('SELECT id, id AS label FROM invoice ORDER BY id DESC').all(),
          payment:  H.db().prepare('SELECT id, id AS label FROM payment ORDER BY id DESC').all(),
          credit_note: H.db().prepare('SELECT id, id AS label FROM credit_note ORDER BY id DESC').all(),
        },
      }, undefined, cookie));
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
        try { return send(res, 200, R.nextActions(url.searchParams.get('type'), url.searchParams.get('id'))); }
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
            workspace: ws, actor: process.env.USER || 'operator', actor_kind: 'human',
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
    const file = p === '/' ? 'index.html' : path.basename(p);
    const full = path.join(UI, file);
    if (full.startsWith(UI) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      return send(res, 200, fs.readFileSync(full), full.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
    }
  }
  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`${DEMO ? 'Saybooks demo' : 'otc workbench'} → http://${HOST}:${PORT}   (workspaces in ${wsp.DATA_DIR})`);
});
