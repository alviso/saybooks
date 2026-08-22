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
const HOST = '127.0.0.1';
const UI = path.join(__dirname, 'ui');

const send = (res, code, body, type = 'application/json; charset=utf-8', headers = {}) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const wsOf = (req, url) => {
  const q = url.searchParams.get('ws');
  if (q) return q;
  const m = /(?:^|;\s*)otc_ws=([a-z0-9_-]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : 'main';
};

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return send(res, 403, { error: 'localhost only' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const ws = wsOf(req, url);
  const cookie = { 'set-cookie': `otc_ws=${ws}; Path=/; SameSite=Lax` };

  try {
    // The whole UI contract: the command specs, plus enough master data for the lookups.
    if (req.method === 'GET' && p === '/api/registry') {
      return wsp.use(ws, () => send(res, 200, {
        workspace: ws,
        workspaces: [...new Set([ws, ...wsp.list()])].filter(w => w === ws || !/^(spec-|test-)/.test(w)).sort(),
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
    // Replay one scenario live, right now, in its scratch workspace. This is the teaching
    // surface: the response is every step — act, command, args, doctrine, what came back.
    if (req.method === 'POST' && p === '/api/spec/replay') {
      const area = url.searchParams.get('area') || 'o2c';
      const file = url.searchParams.get('file');
      try {
        const result = C.runScenario(area, file, { actor: process.env.USER || 'operator' });
        C.runArea(area, { actor: process.env.USER || 'operator' });   // refresh persisted evidence
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
  console.log(`otc workbench → http://${HOST}:${PORT}   (workspaces in ${wsp.DATA_DIR})`);
});
