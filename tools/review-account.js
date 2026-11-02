#!/usr/bin/env node
/**
 * Make a directory reviewer's account for /auth/review.
 *
 *   node tools/review-account.js openai-review@saybooks.io > ~/private/openai-review.txt
 *
 * Writes three lines: the email, a fresh password for the reviewer's form, and the
 * email=salt:hash entry for SAYBOOKS_REVIEW_ACCOUNTS on the host (comma-separate several).
 * Only the hash goes on the server; keep the output file to yourself.
 */
'use strict';
const crypto = require('crypto');
const { hashPassword } = require('../src/auth.js');

const email = (process.argv[2] || '').trim().toLowerCase();
if (!/^[^@\s,=]+@[^@\s,=]+\.[^@\s,=]+$/.test(email)) { console.error('usage: node tools/review-account.js <email>'); process.exit(1); }
const password = crypto.randomBytes(18).toString('base64url');
console.log(`email: ${email}\npassword: ${password}\nSAYBOOKS_REVIEW_ACCOUNTS entry: ${email}=${hashPassword(password)}`);
