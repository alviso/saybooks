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
  const intent = ['hunt', 'solo'].includes(next) ? ':' + next : '';
  const back = returnWs && /^[a-z0-9-]{4,40}$/.test(returnWs) && !/^try-/.test(returnWs) ? ':ws-' + returnWs : '';
  // A relative path to come back to (the OAuth consent page). Only our own paths, base64url so the cookie stays one token.
  const rt = !back && returnTo && /^\/oauth\/consent\?pend=[a-f0-9]+$/.test(returnTo) ? ':rt-' + Buffer.from(returnTo).toString('base64url') : '';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account',
  });
  res.writeHead(302, { location: url, 'set-cookie': `sb_oauth=${state}${intent}${back}${rt}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` });
  res.end();
}

const post = (url, form) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
}).then(r => r.json());

async function callback(req, res, url) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const [, cookieState, intent, returnWs, returnTo] = /(?:^|;\s*)sb_oauth=([a-f0-9]+)(?::(hunt|solo))?(?::ws-([a-z0-9-]+))?(?::rt-([A-Za-z0-9_-]+))?/.exec(req.headers.cookie || '') || [];
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
  if (intent === 'hunt' || intent === 'solo') {
    // A flavored door: find or create their kind-matching space (empty books — real work
    // starts from zero), and land them in it. No demo fixtures, no 'My books'.
    const name = intent === 'hunt' ? 'My job hunt' : 'My invoices';
    let sp = users.spacesFor(user.id).map(s => users.spaceOf(s.ws)).find(s => s && s.kind === intent);
    if (!sp) { sp = users.createSpace(user.id, name, undefined, intent); wsp.dbFor(sp.ws); users.recordAcquisition(sp.ws, 'space', users.parseSrcCookie(req.headers.cookie)); }
    landing = '/app?ws=' + sp.ws;
  } else if (!users.spacesFor(user.id).length) {
    const cur = (/(?:^|;\s*)otc_ws=(try-[a-z0-9]+)/.exec(req.headers.cookie || '') || [])[1];
    if (cur && fs.existsSync(path.join(wsp.DATA_DIR, `ws_${cur}.db`))) {
      // A flavored demo sandbox claims as a matching-kind space — the visitor keeps the flavor too.
      if (cur.startsWith('try-h')) users.claimSpace(user.id, cur, 'My job hunt', 'hunt');
      else if (cur.startsWith('try-s')) users.claimSpace(user.id, cur, 'My invoices', 'solo');
      else users.claimSpace(user.id, cur, 'My books');
      // A claimed sandbox keeps the source it was minted with; mark that it became a space.
      users.recordAcquisition(cur, 'space', users.parseSrcCookie(req.headers.cookie));
    }
    else {
      const sp = users.createSpace(user.id, 'My books');
      require('./fixtures.js').load('try', sp.ws);
      users.recordAcquisition(sp.ws, 'space', users.parseSrcCookie(req.headers.cookie));
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

module.exports = { enabled, loginRedirect, callback, logout, sessionUser };
