'use strict';
/**
 * The OAuth 2.0 front door for the hosted MCP endpoint.
 *
 * The capability-key model stays the identity underneath: an OAuth access token is a
 * pointer to a member key (`m-…`) minted for one space and one role, exactly what a person
 * mints by hand in "Share this space…". What OAuth adds is the flow a directory-listed
 * connector needs: a client registers itself, sends the person here, the person signs in
 * with Google, picks the space and the role the agent gets, and the client receives tokens.
 * Revoking the key (or the token) ends it; the audit trail shows the agent by the name the
 * person chose at consent.
 *
 * Endpoints (served through the SDK's router, mounted on an Express app the raw server
 * delegates to): /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp,
 * /register (dynamic client registration), /authorize, /token, /revoke — plus our own
 * /oauth/consent. The protected resource is the bare /mcp with `Authorization: Bearer`.
 */
const crypto = require('crypto');
const express = require('express');
const { mcpAuthRouter } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const users = require('./users.js');
const members = require('./members.js');

const ACCESS_TTL = 30 * 86400;        // seconds; the key underneath outlives it
const REFRESH_TTL = 365 * 86400;
const CODE_TTL = 600;
const PEND_TTL = 900;
const now = () => Math.floor(Date.now() / 1000);
const rand = (n = 24) => crypto.randomBytes(n).toString('hex');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let ready = false;
function db() {
  const d = users.db();
  if (!ready) {
    d.exec(`
    CREATE TABLE IF NOT EXISTS oauth_client (client_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_pending (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, json TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_code (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, key TEXT NOT NULL, ws TEXT NOT NULL, user_id TEXT NOT NULL,
      challenge TEXT NOT NULL, redirect_uri TEXT, resource TEXT, scope TEXT, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_token (token TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, key TEXT NOT NULL, ws TEXT NOT NULL,
      user_id TEXT NOT NULL, scope TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_oauth_token_key ON oauth_token(key);`);
    ready = true;
  }
  return d;
}

// ---------------------------------------------------------------- clients (dynamic registration)
const clientsStore = {
  getClient(clientId) {
    const r = db().prepare('SELECT json FROM oauth_client WHERE client_id = ?').get(clientId);
    return r ? JSON.parse(r.json) : undefined;
  },
  registerClient(client) {
    // Public clients only: no secret is issued or required (PKCE carries the proof). A
    // client that asks for a secret method is downgraded to none; the SDK validates the rest.
    const full = { ...client, client_id: 'c-' + rand(12), client_id_issued_at: now(), token_endpoint_auth_method: 'none' };
    delete full.client_secret; delete full.client_secret_expires_at;
    db().prepare('INSERT INTO oauth_client (client_id, json, created_at) VALUES (?,?,?)').run(full.client_id, JSON.stringify(full), now());
    return full;
  },
};

// ---------------------------------------------------------------- the provider
const provider = {
  get clientsStore() { return clientsStore; },

  /** Phase 1 of consent: park the request, make sure a person is signed in, send them to /oauth/consent. */
  async authorize(client, params, res) {
    const req = res.req;
    const auth = require('./auth.js');
    const id = rand(12);
    db().prepare('INSERT INTO oauth_pending (id, client_id, json, expires_at) VALUES (?,?,?,?)').run(id, client.client_id, JSON.stringify({
      state: params.state || null, scopes: params.scopes || [], codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri, resource: params.resource ? String(params.resource) : null,
    }), now() + PEND_TTL);
    const user = auth.enabled() && auth.sessionUser(req);
    if (!user) return auth.loginRedirect(res, null, null, `/oauth/consent?pend=${id}`);
    res.redirect(302, `/oauth/consent?pend=${id}`);
  },

  async challengeForAuthorizationCode(client, code) {
    const r = db().prepare('SELECT challenge, client_id, expires_at FROM oauth_code WHERE code = ?').get(code);
    if (!r || r.client_id !== client.client_id || r.expires_at < now()) throw new Error('invalid authorization code');
    return r.challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const r = db().prepare('SELECT * FROM oauth_code WHERE code = ?').get(code);
    if (!r || r.client_id !== client.client_id) throw new Error('invalid authorization code');
    db().prepare('DELETE FROM oauth_code WHERE code = ?').run(code);   // one use, success or not
    if (r.expires_at < now()) throw new Error('authorization code expired');
    if (redirectUri && r.redirect_uri && redirectUri !== r.redirect_uri) throw new Error('redirect_uri mismatch');
    if (!members.resolve(r.key)) throw new Error('the key behind this authorization was revoked');
    return issueTokens(r.client_id, r.key, r.ws, r.user_id, r.scope);
  },

  async exchangeRefreshToken(client, refreshToken) {
    const r = db().prepare("SELECT * FROM oauth_token WHERE token = ? AND kind = 'refresh'").get(refreshToken);
    if (!r || r.client_id !== client.client_id) throw new Error('invalid refresh token');
    if (r.expires_at < now()) { db().prepare('DELETE FROM oauth_token WHERE token = ?').run(refreshToken); throw new Error('refresh token expired'); }
    if (!members.resolve(r.key)) throw new Error('the key behind this token was revoked');
    db().prepare('DELETE FROM oauth_token WHERE token = ?').run(refreshToken);   // rotate
    return issueTokens(r.client_id, r.key, r.ws, r.user_id, r.scope);
  },

  async verifyAccessToken(token) {
    const r = db().prepare("SELECT * FROM oauth_token WHERE token = ? AND kind = 'access'").get(token);
    if (!r) throw new Error('unknown token');
    if (r.expires_at < now()) throw new Error('token expired');
    const m = members.resolve(r.key);
    if (!m) throw new Error('the key behind this token was revoked');
    return { token, clientId: r.client_id, scopes: r.scope ? r.scope.split(' ') : [], expiresAt: r.expires_at, extra: { ws: r.ws, key: r.key, member: m, user_id: r.user_id } };
  },

  async revokeToken(client, request) {
    const r = db().prepare('SELECT * FROM oauth_token WHERE token = ?').get(request.token);
    if (!r || r.client_id !== client.client_id) return;   // RFC 7009: revoking an unknown token succeeds
    db().prepare('DELETE FROM oauth_token WHERE token = ?').run(request.token);
  },
};

function issueTokens(clientId, key, ws, userId, scope) {
  const access = 'at-' + rand(24), refresh = 'rt-' + rand(24), t = now();
  const ins = db().prepare('INSERT INTO oauth_token (token, kind, client_id, key, ws, user_id, scope, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run(access, 'access', clientId, key, ws, userId, scope || null, t + ACCESS_TTL, t);
  ins.run(refresh, 'refresh', clientId, key, ws, userId, scope || null, t + REFRESH_TTL, t);
  return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh, ...(scope ? { scope } : {}) };
}

/** The bearer check for the bare /mcp: returns the member (with ws) or null. */
async function memberForBearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  try { const info = await provider.verifyAccessToken(m[1]); return { ...info.extra.member, oauth: { client_id: info.clientId, user_id: info.extra.user_id } }; }
  catch { return null; }
}

// ---------------------------------------------------------------- consent page (ours)
const PAGE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Saybooks</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"><style>
body{font:16px/1.55 'IBM Plex Sans',-apple-system,'Segoe UI',sans-serif;color:hsl(215 40% 16%);background:hsl(210 20% 98%);display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.wrap{max-width:520px;width:100%;padding:2em} .mark{font-weight:700;letter-spacing:.14em;font-size:14px;margin-bottom:1.6em}
h1{font-weight:700;letter-spacing:-.015em;font-size:24px;margin:0 0 .5em} p{color:hsl(215 20% 36%);margin:0 0 1.2em}
label{display:block;font-weight:600;font-size:14px;margin:14px 0 4px} select,input{width:100%;font:inherit;padding:9px 11px;border:1px solid hsl(215 25% 88%);border-radius:6px;background:#fff}
.row{display:flex;gap:10px;margin-top:22px} button{font:600 15px 'IBM Plex Sans',sans-serif;padding:11px 18px;border-radius:6px;border:1px solid hsl(215 25% 88%);background:#fff;color:hsl(215 60% 22%);cursor:pointer}
button.primary{background:hsl(215 60% 22%);color:#fff;border-color:hsl(215 60% 22%)} .fine{font-size:13px;color:hsl(215 15% 46%);margin-top:16px}
.who{background:#fff;border:1px solid hsl(215 25% 88%);border-radius:8px;padding:12px 14px;font-size:14.5px;margin-bottom:6px} .who b{display:block;font-size:16px}
</style></head><body><div class="wrap"><div class="mark">SAYBOOKS</div>${body}</div></body></html>`;

function consentGet(req, res, url, user) {
  const pend = db().prepare('SELECT * FROM oauth_pending WHERE id = ?').get(url.searchParams.get('pend') || '');
  if (!pend || pend.expires_at < now()) return res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Expired', '<h1>This sign-in request expired.</h1><p>Go back to the app that sent you here and connect again.</p>'));
  const client = clientsStore.getClient(pend.client_id) || {};
  const spaces = users.spacesFor(user.id).map(s => ({ ...s, kind: (users.spaceOf(s.ws) || {}).kind || null }));
  if (!spaces.length) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('No space yet', `<h1>You have no books yet.</h1><p>Open <a href="/app">saybooks.io/app</a> once to create your space, then connect again.</p>`));
  const opts = spaces.map(s => `<option value="${esc(s.ws)}">${esc(s.display_name)}${s.kind ? ` · ${esc(s.kind)}` : ''} (${esc(s.role)})</option>`).join('');
  const body = `<h1>Let ${esc(client.client_name || 'this app')} into your books?</h1>
  <div class="who"><b>${esc(client.client_name || pend.client_id)}</b>${client.client_uri ? `<span>${esc(client.client_uri)}</span>` : ''}</div>
  <p>It will act as your delegate through a key minted for it, under the role you pick, and every action it takes lands in that space's audit trail under its own name. You can revoke the key at any time from <b>Share this space…</b>.</p>
  <form method="post" action="/oauth/consent">
    <input type="hidden" name="pend" value="${esc(pend.id)}">
    <label for="ws">Which books</label><select id="ws" name="ws">${opts}</select>
    <label for="role">What it may do</label><select id="role" name="role">
      <option value="controller">controller — every business act, no invitations or deletions</option>
      <option value="clerk">clerk — day-to-day writes, no credit authority</option>
      <option value="viewer">viewer — read only</option>
    </select>
    <label for="name">Name in the audit log</label><input id="name" name="name" value="${esc((client.client_name || 'agent').replace(/[^a-z0-9 ._-]/gi, '').slice(0, 30) || 'agent')}" maxlength="40">
    <div class="row"><button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></div>
    <div class="fine">Signed in as ${esc(user.email)}. Not you? <a href="/auth/logout">Sign out</a>.</div>
  </form>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Allow access', body));
}

function consentPost(req, res, form, user) {
  const pend = db().prepare('SELECT * FROM oauth_pending WHERE id = ?').get(form.pend || '');
  if (!pend || pend.expires_at < now()) return res.writeHead(400, { 'content-type': 'text/plain' }).end('expired');
  db().prepare('DELETE FROM oauth_pending WHERE id = ?').run(pend.id);
  const p = JSON.parse(pend.json);
  const back = (extra) => { const u = new URL(p.redirectUri); for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v); if (p.state) u.searchParams.set('state', p.state); res.writeHead(302, { location: u.href }).end(); };
  if (form.decision !== 'allow') return back({ error: 'access_denied', error_description: 'The person declined.' });
  const ws = String(form.ws || ''); const role = String(form.role || 'controller');
  const myRole = users.roleFor(user.id, ws);
  if (!myRole) return back({ error: 'access_denied', error_description: 'Not a member of that space.' });
  if (!['controller', 'clerk', 'viewer'].includes(role)) return back({ error: 'invalid_request', error_description: 'bad role' });
  // Delegate ceiling: a clerk cannot mint a controller; a viewer mints nothing.
  const rank = { owner: 3, controller: 2, clerk: 1, viewer: 0 };
  if (rank[role] > rank[myRole] || rank[myRole] === 0) return back({ error: 'access_denied', error_description: `Your role in that space (${myRole}) cannot delegate ${role}.` });
  let name = String(form.name || 'agent').replace(/[^a-z0-9 ._-]/gi, '').trim().slice(0, 30) || 'agent';
  let key;
  for (let i = 0; i < 5 && !key; i++) {
    try { key = members.mint(ws, i ? `${name} ${i + 1}` : name, role).token; } catch (e) { if (!/already a member/.test(e.message)) return back({ error: 'server_error', error_description: e.message }); }
  }
  if (!key) return back({ error: 'server_error', error_description: 'could not mint a key' });
  const code = 'ac-' + rand(24);
  db().prepare('INSERT INTO oauth_code (code, client_id, key, ws, user_id, challenge, redirect_uri, resource, scope, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(code, pend.client_id, key, ws, user.id, p.codeChallenge, p.redirectUri, p.resource, (p.scopes || []).join(' ') || null, now() + CODE_TTL);
  back({ code });
}

// ---------------------------------------------------------------- mounting
let app = null;
function build(publicUrl) {
  const issuer = new URL(publicUrl);
  app = express();
  app.set('trust proxy', 1);
  app.use(mcpAuthRouter({
    provider, issuerUrl: issuer, resourceServerUrl: new URL('/mcp', issuer), scopesSupported: ['books'],
    serviceDocumentationUrl: new URL('/docs', issuer),
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  return app;
}
const PATHS = /^\/(?:\.well-known\/oauth-(?:authorization-server|protected-resource)(?:\/.*)?|authorize|token|register|revoke)\/?$/;
/** True when the raw server should hand this request to the OAuth app. */
const handles = (p) => PATHS.test(p);
function handle(req, res, publicUrl) { if (!app) build(publicUrl); return app(req, res); }

function sweep() { const t = now(); db().prepare('DELETE FROM oauth_pending WHERE expires_at < ?').run(t); db().prepare('DELETE FROM oauth_code WHERE expires_at < ?').run(t); db().prepare('DELETE FROM oauth_token WHERE expires_at < ?').run(t); }

module.exports = { provider, clientsStore, handles, handle, memberForBearer, consentGet, consentPost, sweep };
