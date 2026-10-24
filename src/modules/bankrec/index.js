'use strict';
/**
 * bankrec — the bank statement against the books. Matches between statement rows (the purchases
 * area's) and the payments and refunds recorded here (o2c's and solo's), the reconciliation of an
 * account through a statement's last day, and the sign-off a person gives it. The reconciliation is
 * derived every time; only matches and sign-offs are stored.
 */
const R = require('../../registry.js');
const V = require('./views.js');

const mod = R.defineModule({
  name: 'bankrec', prefix: 'rec',
  tables: ['bankrec_match', 'bankrec_match_item', 'bankrec_signoff'],
  ids: { match: 'BM-0001', signoff: 'BR-0001' },
  lifecycles: {
    match: 'matched (a statement row and the payments it is, adding up exactly, reasoned) -> unmatched (reasoned; the row back to its earlier review)',
    signoff: 'signed by a person through a statement\'s last day, kept as it stood; never withdrawn, shows as changed since when the record moves',
  },
  rules: [
    'A match adds up to its row exactly; a matched row posts nothing itself, so the money is in the books once.',
    'Only a row that posts nothing can be matched; a row already booked as income or spending is refused.',
    'The reconciliation names every item between the statement and the books; a leftover difference is never absorbed.',
    'Signing off is a person\'s act, refused while the difference is not zero or a row is unaccounted for.',
  ],
  doctrine: `Bank reconciliation: the statement against the books, per account. Read rec_reconciliation for
the account (it defaults to the latest statement): the statement's balance, the books', and the items
between them. Payments recorded here and not on the statement yet are in transit, which is normal for a
few days; one in transit for weeks is worth a question. Rows on the statement and not in the books are
either not reviewed (review them in purchases) or deposits that are payments already recorded here:
read rec_candidates, show the person what fits and why, and match with rec_match and a reason. Never
match "close enough" and never record a payment to have something to match. When nothing blocks, tell
the person it is ready; signing it off is theirs, in the app.`,
  implements: {
    area: 'bankrec', spec: '0.1',
    argmap: { transaction: 'transaction_id', match: 'match_id' },
    acts: {
      match: 'rec_match', unmatch: 'rec_unmatch', sign_off: 'rec_sign_off',
      accounts: 'rec_accounts', reconciliation: 'rec_reconciliation', candidates: 'rec_candidates', signoffs: 'rec_signoffs',
    },
  },
  api: { views: V, statementRowMatches: V.statementRowMatches, reconciliationStanding: V.standing },
});

R.defineSubject('bankrec_match', { load: (id) => V.matchView(id) });
R.defineSubject('bankrec_signoff', { load: (id) => require('../../db.js').need('bankrec_signoff', id, 'sign-off') });

R.inModule(mod, () => {
  require('./commands/match.js');
  require('./commands/reads.js');
});

module.exports = mod;
