'use strict';
/**
 * Google sign-in, the boring standard way: authorization-code flow, server-side session.
 * Enabled only when GOOGLE_CLIENT_ID/SECRET are present (the hosted demo); local
 * workbenches never see any of this.
 *
 * ID-token verification uses Google's tokeninfo endpoint — one extra HTTPS call per LOGIN
 * (not per request), traded against bundling a JWKS/JWT library. Honest tradeoff, revisit
 * if login volume ever makes it matter.
 */
const crypto = require('crypto');
const users = require('./users.js');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const enabled = () => !!(CLIENT_ID && CLIENT_SECRET);

const REDIRECT = 'https://saybooks.io/auth/google/callback';

function loginRedirect(res, next, returnWs, returnTo) {
  const state = crypto.randomBytes(12).toString('hex');
  // Intent rides in the state COOKIE, not the URL — the callback trusts only what we set.
  // A private link (?ws=) opened signed-out rides along the same way and is honoured only if
  // the user who comes back is a member of that space.
  const intent = ['hunt', 'solo', 'home'].includes(next) ? ':' + next : '';
  const back = returnWs && /^[a-z0-9-]{4,40}$/.test(returnWs) && !/^try-/.test(returnWs) ? ':ws-' + returnWs : '';
  // A relative path to come back to (the OAuth consent page). Only our own paths, base64url so the cookie stays one token.
  const rt = !back && returnTo && /^\/oauth\/consent\?pend=[a-f0-9]+$/.test(returnTo) ? ':rt-' + Buffer.from(returnTo).toString('base64url') : '';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account',
  });
  const prior = res.getHeader('set-cookie'); res.removeHeader('set-cookie');
  res.writeHead(302, { location: url, 'set-cookie': [`sb_oauth=${state}${intent}${back}${rt}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`].concat(prior || []) });
  res.end();
}

const post = (url, form) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
}).then(r => r.json());

async function callback(req, res, url) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const [, cookieState, intent, returnWs, returnTo] = /(?:^|;\s*)sb_oauth=([a-f0-9]+)(?::(hunt|solo|home))?(?::ws-([a-z0-9-]+))?(?::rt-([A-Za-z0-9_-]+))?/.exec(req.headers.cookie || '') || [];
  const fail = (why) => { res.writeHead(302, { location: '/?login=failed' }); res.end(); console.error('[auth]', why); };
  if (!code || !state || state !== cookieState) return fail('state mismatch or missing code');

  const tok = await post('https://oauth2.googleapis.com/token', {
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code',
  });
  if (!tok.id_token) return fail('no id_token: ' + JSON.stringify(tok).slice(0, 200));
  const info = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok.id_token)).then(r => r.json());
  if (info.aud !== CLIENT_ID || info.email_verified !== 'true') return fail('bad token claims');

  const user = users.upsertUser({ sub: info.sub, email: info.email, name: info.name, picture: info.picture });

  // First login with a sandbox in hand: claim it — the visitor keeps everything they did.
  const wsp = require('./workspace.js');
  const fs = require('fs');
  const path = require('path');
  let landing = '/app';
  if (intent === 'hunt' || intent === 'solo' || intent === 'home') {
    // A flavored door: find or create their kind-matching space (empty books — real work
    // starts from zero), and land them in it. No demo fixtures, no 'My books'.
    const name = intent === 'hunt' ? 'My job hunt' : intent === 'home' ? 'My household' : 'My invoices';
    let sp = users.spacesFor(user.id).map(s => users.spaceOf(s.ws)).find(s => s && s.kind === intent && !s.demo);   // never the example books
    if (!sp) { sp = users.createSpace(user.id, name, undefined, intent); wsp.dbFor(sp.ws); users.recordAcquisition(sp.ws, 'space', users.parseSrcCookie(req.headers.cookie)); }
    landing = '/app?ws=' + sp.ws;
  } else if (!users.spacesFor(user.id).length) {
    const cur = (/(?:^|;\s*)otc_ws=(try-[a-z0-9]+)/.exec(req.headers.cookie || '') || [])[1];
    if (cur && fs.existsSync(path.join(wsp.DATA_DIR, `ws_${cur}.db`))) {
      // A flavored demo sandbox claims as a matching-kind space — the visitor keeps the flavor too.
      if (cur.startsWith('try-h')) users.claimSpace(user.id, cur, 'My job hunt', 'hunt');
      else if (cur.startsWith('try-s')) users.claimSpace(user.id, cur, 'My invoices', 'solo');
      else if (cur.startsWith('try-p')) {
        // Maya's household is example books, not theirs: it stays as a demo space, and their own household starts empty.
        users.claimSpace(user.id, cur, 'Demo household', 'home', null, true);
        const sp = users.createSpace(user.id, 'My household', undefined, 'home'); wsp.dbFor(sp.ws);
        landing = '/app?ws=' + sp.ws;
      }
      else {
        // The demo they poked at stays, sample data and all, as its own space; their real books
        // start empty from the chooser, which is where the workbench lands them next.
        users.claimSpace(user.id, cur, 'Demo books', null, ['o2c', 'crm', 'solo', 'purchases'], true);
        landing = '/app?ws=' + cur + '#newspace';
      }
      // A claimed sandbox keeps the source it was minted with; mark that it became a space.
      users.recordAcquisition(cur, 'space', users.parseSrcCookie(req.headers.cookie));
    }
    else {
      const sp = users.createSpace(user.id, 'Demo books', undefined, null, ['o2c', 'crm', 'solo', 'purchases'], true);
      require('./fixtures.js').load('try', sp.ws);
      users.recordAcquisition(sp.ws, 'space', users.parseSrcCookie(req.headers.cookie));
      landing = '/app?ws=' + sp.ws + '#newspace';
    }
  }

  // Back to the private link they came in on — if, and only if, they are a member of it.
  if (returnWs) landing = users.roleFor(user.id, returnWs) ? '/app?ws=' + returnWs : '/app?notmember=' + returnWs;
  if (returnTo) { const back = Buffer.from(returnTo, 'base64url').toString('utf8'); if (/^\/oauth\/consent\?pend=[a-f0-9]+$/.test(back)) landing = back; }

  const sess = users.createSession(user.id);
  res.writeHead(302, { location: landing, 'set-cookie': [
    `sb_sess=${sess}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`,
    'sb_oauth=; Path=/; Max-Age=0',
  ] });
  res.end();
}

function logout(req, res) {
  const t = (/(?:^|;\s*)sb_sess=(s-[a-f0-9]+)/.exec(req.headers.cookie || '') || [])[1];
  if (t) users.dropSession(t);
  res.writeHead(302, { location: '/', 'set-cookie': 'sb_sess=; Path=/; Max-Age=0' });
  res.end();
}

const sessionUser = (req) => {
  const t = (/(?:^|;\s*)sb_sess=(s-[a-f0-9]+)/.exec(req.headers.cookie || '') || [])[1];
  return t ? users.userForSession(t) : null;
};

// ---------------------------------------------------------------- directory reviewers
// A directory's reviewer must sign in without a code by email or text, which a Google account
// on a new device cannot promise. So each reviewing team gets an email and password of its own,
// set on the host as SAYBOOKS_REVIEW_ACCOUNTS="email=salt:hash,..." (tools/review-account.js
// makes one). The account is an ordinary user whose only books are a sample household, seeded
// on first sign-in; from there consent, keys and the audit log are the same as anyone's.
// Unset, /auth/review is a 404.
const reviewAccounts = () => Object.fromEntries((process.env.SAYBOOKS_REVIEW_ACCOUNTS || '').split(',')
  .map(x => x.trim().split('=')).filter(([e, h]) => e && h && h.includes(':')).map(([e, h]) => [e.toLowerCase(), h]));
const reviewEnabled = () => Object.keys(reviewAccounts()).length > 0;
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
function checkPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const want = Buffer.from(hex, 'hex'), got = crypto.scryptSync(String(password), salt, 32);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const failures = new Map();   // ip -> { n, at }: five wrong passwords in 15 minutes and the door shuts for the rest of them
const CONSENT = /^\/oauth\/consent\?pend=[a-f0-9]+$/;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function reviewPage(res, code, next, error) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reviewer sign-in · Saybooks</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/site.css">
<style>form{display:grid;gap:12px;max-width:360px;margin-top:1em}label{display:grid;gap:4px;font-weight:600}input{font:inherit;padding:9px 11px;border:1px solid #c9d2cc;border-radius:8px}.err{color:#a3361f;font-weight:600}</style>
</head><body><div class="wrap"><main class="prose"><div class="kicker">Directory review</div><h1>Reviewer sign-in</h1>
<p>For the teams reviewing Saybooks for an assistant's directory. Everyone else signs in with Google from <a href="/">the front page</a>. The account opens a sample household with made-up statements, a credit card, a mortgage and a car loan.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/auth/review"><input type="hidden" name="next" value="${esc(next || '')}">
<label>Email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button class="btn solid" type="submit">Sign in</button></form>
<p class="asof">After signing in, connect the assistant to <code>https://saybooks.io/mcp</code> in this same browser: its sign-in step comes straight to the page that asks which books to open. Questions: <a href="mailto:hello@saybooks.io">hello@saybooks.io</a>.</p>
</main></div></body></html>`);
}

function review(req, res, url, ip) {
  if (!reviewEnabled()) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); return res.end('{"error":"not found"}'); }
  if (req.method === 'GET') return reviewPage(res, 200, CONSENT.test(url.searchParams.get('next') || '') ? url.searchParams.get('next') : '');
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); return res.end(); }
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    const f = Object.fromEntries(new URLSearchParams(raw));
    const next = CONSENT.test(f.next || '') ? f.next : '';
    const now = Date.now(), fl = failures.get(ip);
    if (fl && now - fl.at > 15 * 60000) failures.delete(ip);
    if ((failures.get(ip) || { n: 0 }).n >= 5) return reviewPage(res, 429, next, 'Too many wrong passwords from this address. Try again in 15 minutes, or write to hello@saybooks.io.');
    const email = String(f.email || '').trim().toLowerCase(), stored = reviewAccounts()[email];
    if (!stored || !checkPassword(f.password || '', stored)) {
      const cur = failures.get(ip) || { n: 0, at: now }; failures.set(ip, { n: cur.n + 1, at: cur.at });
      console.error('[auth] review sign-in refused for', email || '(no email)');
      return reviewPage(res, 401, next, 'That email and password do not match a reviewer account.');
    }
    failures.delete(ip);
    const user = users.upsertUser({ sub: 'review:' + email, email, name: 'Directory reviewer' });
    let sp = users.spacesFor(user.id)[0];
    if (!sp) {
      sp = users.createSpace(user.id, 'Sample household', undefined, 'home');
      require('./fixtures.js').load('hometry', sp.ws);
    }
    const sess = users.createSession(user.id);
    res.writeHead(302, { location: next || '/app?ws=' + sp.ws, 'set-cookie': `sb_sess=${sess}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax` });
    res.end();
  });
  return undefined;
}

module.exports = { enabled, loginRedirect, callback, logout, sessionUser, review, reviewEnabled, hashPassword };
