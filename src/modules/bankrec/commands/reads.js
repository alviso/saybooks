'use strict';
const { defineCommand, f } = require('../../../registry.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Bank reconciliation read', ...def });

read({ name: 'rec_accounts', title: 'Bank accounts', summary: 'Each bank and card account with its latest statement, where its reconciliation stands, and the last day signed off.', args: {}, handler: () => V.accounts() });
read({ name: 'rec_reconciliation', title: 'Reconciliation', summary: 'An account through a statement\'s last day: the statement\'s balance, the books\' balance, and every item between them, named. Says what blocks a sign-off.',
  args: { account: { ...f.text('The bank or card account, as the statement prints it.'), required: true }, through: f.date('The last day of one of its statements. Defaults to the latest.'), currency: f.text('Only when one account name holds two currencies.') },
  handler: (a) => V.reconciliation(a) });
read({ name: 'rec_candidates', title: 'Match suggestions', summary: 'Statement rows that could be money already recorded here, each with the payments that fit it and why. Suggestions only.',
  args: { account: f.text('One account; all bank accounts when left out.') }, handler: (a) => V.candidates(a) });
read({ name: 'rec_matches', title: 'Matches', summary: 'Every match between a statement row and payments recorded here, newest first, undone ones included.', args: {}, handler: () => V.matches() });
read({ name: 'rec_get_match', title: 'Match', summary: 'One match: the row, the payments, the reason.', args: { match_id: { ...f.text('e.g. BM-0001.'), required: true } }, handler: (a) => V.matchView(a.match_id) });
read({ name: 'rec_signoffs', title: 'Sign-offs', summary: 'Every signed reconciliation: account, through, figures, by whom, and whether the record has changed since.', args: {}, handler: () => V.signoffs() });
