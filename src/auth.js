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

function loginRedirect(res, next) {
  const state = crypto.randomBytes(12).toString('hex');
  // Intent rides in the state COOKIE, not the URL — the callback trusts only what we set.
  const intent = next === 'hunt' ? ':hunt' : '';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account',
  });
  res.writeHead(302, { location: url, 'set-cookie': `sb_oauth=${state}${intent}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` });
  res.end();
}

const post = (url, form) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
}).then(r => r.json());

async function callback(req, res, url) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const [, cookieState, intent] = /(?:^|;\s*)sb_oauth=([a-f0-9]+)(?::([a-z]+))?/.exec(req.headers.cookie || '') || [];
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
  if (intent === 'hunt') {
    // The free job-hunt door: find or create their hunt-kind space (empty books — a real
    // hunt starts from zero), and land them in it. No demo fixtures, no 'My books'.
    let sp = users.spacesFor(user.id).map(s => users.spaceOf(s.ws)).find(s => s && s.kind === 'hunt');
    if (!sp) { sp = users.createSpace(user.id, 'My job hunt', undefined, 'hunt'); wsp.dbFor(sp.ws); }
    landing = '/app?ws=' + sp.ws;
  } else if (!users.spacesFor(user.id).length) {
    const cur = (/(?:^|;\s*)otc_ws=(try-[a-z0-9]+)/.exec(req.headers.cookie || '') || [])[1];
    if (cur && fs.existsSync(path.join(wsp.DATA_DIR, `ws_${cur}.db`))) {
      // A jobhunt demo sandbox claims as a hunt-kind space — the visitor keeps the flavor too.
      if (cur.startsWith('try-h')) users.claimSpace(user.id, cur, 'My job hunt', 'hunt');
      else users.claimSpace(user.id, cur, 'My books');
    }
    else {
      const sp = users.createSpace(user.id, 'My books');
      require('./fixtures.js').load('try', sp.ws);
    }
  }

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
