'use strict';
/**
 * Shared helpers. db() resolves to the *current workspace's* database — set by execute()
 * for every command, or by workspace.use() for the rare caller outside the registry.
 * Domain read models live in their owning module (src/modules/o2c/views.js), not here.
 */
const wsp = require('./workspace.js');

const db = wsp.db;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
// Payment terms: "immediate", or "netN" for any whole number of days (net7, net15, net30, net60,
// net45...). The four common ones were once the whole list; a customer on net 7 is not unusual.
const TERMS = { immediate: 0, net15: 15, net30: 30, net60: 60 };
const TERMS_RE = /^(immediate|net[1-9]\d{0,2})$/;
const termsDays = (t) => t === 'immediate' ? 0 : (/^net(\d{1,3})$/.exec(String(t || '')) ? Number(RegExp.$1) : 30);
const normTerms = (t) => { const v = String(t ?? '').trim().toLowerCase().replace(/\s+/g, ''); return v.replace(/^net-/, 'net'); };
// ---------------------------------------------------------------- money and dates, per space
// The company profile says where the business is (country -> locale) and what it bills in
// (a default currency and an allowed set). money() formats minor units in a currency, in the
// space's locale: a New Zealand space prints NZD as "$2,700.00", a US space prints CZK as
// "CZK 2,700.00". Amounts are integers everywhere; formatting is the only place a decimal appears.
const LOCALES = { US: 'en-US', NZ: 'en-NZ', AU: 'en-AU', GB: 'en-GB', IE: 'en-IE', CA: 'en-CA', CZ: 'cs-CZ', HU: 'hu-HU', DE: 'de-DE', AT: 'de-AT', CH: 'de-CH', NL: 'nl-NL', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', PL: 'pl-PL', SK: 'sk-SK', SE: 'sv-SE', DK: 'da-DK', NO: 'nb-NO', FI: 'fi-FI', PT: 'pt-PT', SG: 'en-SG', IN: 'en-IN', ZA: 'en-ZA', JP: 'ja-JP' };
const CUR_RE = /^[A-Z]{3}$/;
/** The space's money settings, defaults filled in. Safe before the profile exists or the column migration ran. */
function locale() {
  let p = null;
  try { p = db().prepare('SELECT country, currency, currencies, tax_label, tax_rate_bp, tax_registered, tax_decided, tax_id_label, number_format FROM company_profile WHERE id = 1').get() || null; } catch { p = null; }
  const currency = (p && p.currency) || 'USD';
  let currencies = null;
  try { currencies = p && p.currencies ? JSON.parse(p.currencies) : null; } catch { currencies = null; }
  if (!Array.isArray(currencies) || !currencies.length) currencies = [currency];
  if (!currencies.includes(currency)) currencies.unshift(currency);
  const country = (p && p.country) || null;
  return { country, locale: LOCALES[country] || 'en-US', currency, currencies,
           tax_label: (p && p.tax_label) || null, tax_rate_bp: (p && p.tax_rate_bp) || 0, tax_registered: !!(p && p.tax_registered), tax_decided: !!(p && p.tax_decided),
           tax_id_label: (p && p.tax_id_label) || null, number_format: (p && p.number_format) || null };
}
const fmtCache = new Map();
function money(cents, currency, loc) {
  const l = (currency && loc) ? { currency, locale: loc } : locale();
  const cur = CUR_RE.test(currency || '') ? currency : l.currency;
  const key = `${l.locale}|${cur}`;
  let f = fmtCache.get(key);
  if (!f) { try { f = new Intl.NumberFormat(l.locale, { style: 'currency', currency: cur }); } catch { f = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }); } fmtCache.set(key, f); }
  return f.format((cents || 0) / 100);
}
/** A date as people in the space write it: "May 10, 2026" in the US, "10 May 2026" in New Zealand. */
function fmtDate(iso, loc) {
  if (!iso) return '';
  const l = loc || locale().locale;
  return new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString(l, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Human-legible sequential ids. An operator reading SO-0007 in an email can find it. */
function nextId(prefix, table) {
  const row = db().prepare(`SELECT id FROM "${table}" ORDER BY id DESC LIMIT 1`).get();
  const n = row ? Number(String(row.id).split('-')[1]) + 1 : 1;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

const get = (table, id) => db().prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id);
const need = (table, id, label) => {
  const row = get(table, id);
  if (!row) throw new Error(`${label || table} ${id} does not exist.`);
  return row;
};

/** The registry owns command_log; this is its read side. */
const auditTrail = (limit = 50, subjectId = null) => db().prepare(`
  SELECT * FROM command_log ${subjectId ? 'WHERE subject_id = ?' : ''} ORDER BY id DESC LIMIT ?`)
  .all(...(subjectId ? [subjectId, limit] : [limit]));

module.exports = { db, today, addDays, TERMS, TERMS_RE, termsDays, normTerms, money, fmtDate, locale, CUR_RE, nextId, get, need, auditTrail };
