'use strict';
/**
 * Full card numbers never reach the books or the audit log. Every write's arguments pass through
 * mask() in the registry, before the handler and before the log; a run of digits that is a card
 * number by its issuer prefix, its length and its check digit keeps only its last four:
 * "4111 1111 1111 1111" becomes "****1111". Accounts carry their last four by design, so nothing
 * that is kept needs more, and a directory's rule against storing card data holds by construction.
 *
 * A run is only matched whole, between characters that are not letters or digits, so a hash, an
 * id or a 20-digit tracking number is never cut into. A run glued to letters ("CARD4111...") is
 * missed; a reference number that happens to pass all three tests is cut to its last four.
 */

// Issuer prefixes and lengths: Visa, Mastercard (51-55, 2221-2720), Amex, Discover, UnionPay,
// JCB, Diners, Maestro.
const ISSUERS = [
  [/^4/, [13, 16, 19]],
  [/^5[1-5]/, [16]], [/^(222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/, [16]],
  [/^3[47]/, [15]],
  [/^(6011|64[4-9]|65)/, [16, 17, 18, 19]], [/^62/, [16, 17, 18, 19]],
  [/^35(2[89]|[3-8]\d)/, [16, 17, 18, 19]],
  [/^(30[0-5]|36|38)/, [14, 15, 16, 17, 18, 19]],
  [/^(50|5[6-8]|67)/, [13, 14, 15, 16, 17, 18, 19]],
];

function luhn(d) {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}

const isCardNumber = (d) => ISSUERS.some(([re, lens]) => re.test(d) && lens.includes(d.length)) && luhn(d);

// 13 or more digits, in groups split by single spaces or dashes, not touching another letter or digit.
const RUN = /(?<![A-Za-z0-9])(?<!\d[ -])\d(?:[ -]?\d){12,38}(?![ -]?\d)(?![A-Za-z])/g;

// A statement line read as text can run an amount or a date into the number ("4111 1111 1111 1111
// 125"), so when the whole run is not a card, the longest span of its groups that is one is cut.
function maskRun(m) {
  const d = m.replace(/[ -]/g, '');
  if (isCardNumber(d)) return '****' + d.slice(-4);
  const parts = m.split(/([ -])/), groups = parts.filter((_, i) => i % 2 === 0);
  for (let len = groups.length - 1; len >= 1; len--) for (let i = 0; i + len <= groups.length; i++) {
    const g = groups.slice(i, i + len).join('');
    if (g.length >= 13 && g.length <= 19 && isCardNumber(g)) return parts.slice(0, 2 * i).join('') + '****' + g.slice(-4) + parts.slice(2 * (i + len) - 1).join('');
  }
  return m;
}

const maskText = (s) => s.replace(RUN, maskRun);

/** A copy of args with every string masked, nested rows included. Fields in `skip` (binary blobs) pass untouched. */
function mask(args, skip = []) {
  const walk = (v) => typeof v === 'string' ? maskText(v)
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  if (!args || typeof args !== 'object') return args;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, skip.includes(k) ? v : walk(v)]));
}

module.exports = { mask, maskText, isCardNumber };
