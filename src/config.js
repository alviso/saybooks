'use strict';
/**
 * The public origin — what a link handed to a person must start with. Set it with
 * SAYBOOKS_PUBLIC_URL; otherwise it is learned from the first request's forwarded headers
 * (good enough for a local run, wrong behind a proxy that hides the scheme — so set it).
 */
let publicUrl = (process.env.SAYBOOKS_PUBLIC_URL || '').replace(/\/+$/, '') || null;
const fromEnv = !!publicUrl;
function learn(req) {
  if (publicUrl) return publicUrl;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (host) publicUrl = `${proto}://${host}`;
  return publicUrl;
}
module.exports = { get publicUrl() { return publicUrl; }, fromEnv, learn, absolute: (p) => (p && publicUrl ? publicUrl + p : null) };
