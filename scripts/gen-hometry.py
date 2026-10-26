#!/usr/bin/env python3
"""
Generates fixtures/hometry.json: the household demo for personal finances (try-p sandboxes).

Maya's household: a checking and a savings account, a Chase Visa, a Toyota loan, a mortgage, a house
and a car. Three statement periods relative to the day the sandbox is made (dates are {{today-N}}), so
the books always look current. The first two periods are fully reviewed, paired and linked; the latest
leaves the things the videos do live: a card payment and a savings transfer to pair, an Amazon return to
link, this period's loan payments to link, and a work trip's payback to tie.

Every figure is computed here, so statements add up to their printed balances, card payments pay the
previous statement in full, and the mortgage's stated balance ties to the schedule.

    python3 scripts/gen-hometry.py
"""
import json, math, os

D = lambda n: '{{today%+d}}' % n if n else '{{today}}'
cents = lambda x: int(round(x * 100))
jsround = lambda x: int(math.floor(x + 0.5))      # Math.round, as the loans area rounds
steps = []
def step(cmd, args, reason=None, when=None):
    s = [cmd, args, reason or None]
    if when: s += [None, None, None, when]
    steps.append(s)

PERIODS = [(-95, -66), (-65, -36), (-35, -6)]
tid = [0]
def next_t(): tid[0] += 1; return 'T-%04d' % tid[0]

# ---------------------------------------------------------------- accounts
step('purch_add_account', {'name': 'Wells Fargo Checking ending 3301', 'kind': 'checking', 'currency': 'USD', 'institution': 'Wells Fargo', 'last4': '3301'}, 'Maya: our joint checking')
step('purch_add_account', {'name': 'Wells Fargo Savings ending 3302', 'kind': 'savings', 'currency': 'USD', 'institution': 'Wells Fargo', 'last4': '3302'}, 'Maya: the savings account')
step('purch_add_account', {'name': 'Chase Sapphire Visa ending 4417', 'kind': 'credit_card', 'currency': 'USD', 'institution': 'Chase', 'last4': '4417'}, 'Maya: the everyday card')
CHK, SAV, CARD = 'ACC-0001', 'ACC-0002', 'ACC-0003'

# ---------------------------------------------------------------- loans, the house and the car
RATE_M, PAY_M, ESC_M, BAL_M = 625, 254000, 51240, 41230000
RATE_T, PAY_T, BAL_T = 490, 48700, 1840000
step('loan_add', {'name': 'Rocket Mortgage ending 5520', 'kind': 'mortgage', 'lender': 'Rocket Mortgage', 'currency': 'USD', 'balance': BAL_M, 'balance_date': D(-100),
                  'rate_bp': RATE_M, 'payment': PAY_M, 'escrow': ESC_M, 'due_day': 1, 'original_principal': 44000000, 'term_months': 360, 'source': 'Rocket Mortgage statement, the month before these books start'}, 'Maya: the mortgage')
step('loan_add', {'name': 'Toyota Financial auto loan ending 8812', 'kind': 'auto', 'lender': 'Toyota Financial Services', 'currency': 'USD', 'balance': BAL_T, 'balance_date': D(-100),
                  'rate_bp': RATE_T, 'payment': PAY_T, 'due_day': 15, 'original_principal': 2950000, 'term_months': 60, 'source': 'Toyota Financial statement'}, 'Maya: the car loan')
step('purch_add_account', {'name': 'Home, 214 Alder St', 'kind': 'asset', 'currency': 'USD', 'notes': 'bought 2019'}, 'Maya: the house')
step('purch_record_value', {'account_id': 'ACC-0006', 'as_of': D(-40), 'amount': 72500000, 'according_to': 'county assessment, this year'}, 'Maya: from the assessment letter')
step('purch_add_account', {'name': '2022 Toyota RAV4', 'kind': 'asset', 'currency': 'USD'}, 'Maya: the car')
step('purch_record_value', {'account_id': 'ACC-0007', 'as_of': D(-30), 'amount': 2350000, 'according_to': 'Kelley Blue Book, private party'}, 'Maya: looked it up')

# ---------------------------------------------------------------- bills that come every month
step('purch_declare_bill_series', {'vendor': 'PG&E', 'cadence': 'monthly', 'category': 'utilities', 'reason': 'Maya: gas and electric, every month'})
step('purch_declare_bill_series', {'vendor': 'Comcast', 'cadence': 'monthly', 'category': 'internet', 'typical_amount': 8999, 'reason': 'Maya: internet, every month'})
step('purch_set_autopay', {'series_id': 'BS-0002', 'account_id': CHK, 'reason': 'Maya: Comcast takes it from checking'}, 'Maya set it up when the account opened')

# ---------------------------------------------------------------- the statements
PGE = [14210, 15830, 23680]           # the third is well above the usual
CARD_OPEN = -148240                   # the balance before these books, paid in the first period
chk_bal, sav_bal, card_bal = 642000, 1250000, CARD_OPEN
bal_m, bal_t = BAL_M, BAL_T
review = {CHK: [], SAV: [], CARD: []}
later = {'pairs': [], 'loans': [], 'bills': [], 'receipts': [], 'reimbursable': [], 'values': []}

def stmt(acct, name, kind, k, rows, opening, extra=None):
    start, end = PERIODS[k]
    out, ids = [], []
    for i, (off, amt, desc) in enumerate(rows):
        t = next_t(); ids.append(t)
        out.append({'date': D(start + off), 'amount': amt, 'description': desc, 'row_index': i + 1})
    closing = opening + sum(r['amount'] for r in out)
    a = {'name': name, 'hash': f'hometry-{acct.lower()}-p{k + 1}', 'kind': kind, 'account_id': acct, 'currency': 'USD', 'period_start': D(start), 'period_end': D(end),
         'opening_balance': opening, 'closing_balance': closing, 'rows': out}
    if extra: a.update(extra)
    step('purch_import_statement', a, f'the {["first", "second", "latest"][k]} statement')
    return ids, closing

for k in range(3):
    start, end = PERIODS[k]
    # card: what was spent this period, and the payment of the last statement in full
    pay_card = -card_bal
    card_rows = [(2, -8642 - 300 * k, "TRADER JOE'S #127"), (4, -11234 - 500 * k, 'SAFEWAY #1871'), (6, pay_card, 'AUTOMATIC PAYMENT - THANK YOU'),
                 (8, -5210 + 300 * k, 'SHELL OIL 57442'), (10, -1549, 'NETFLIX.COM'), (11, -1199, 'SPOTIFY USA'), (14, -1845 - 200 * k, 'CHIPOTLE 2231'),
                 (17, -9120, "TRADER JOE'S #127"), (20, -4890, 'SHELL OIL 57442')]
    if k == 0: card_rows += [(12, -2399, 'CVS/PHARMACY #9821'), (22, -6418, 'TARGET 00021'), (25, -3499, 'AMAZON.COM*2K4LM')]
    if k == 1: card_rows += [(9, -3000, 'KAISER PERMANENTE COPAY'), (15, -10000, 'AMERICAN RED CROSS'), (18, -9500, 'ANNUAL MEMBERSHIP FEE'), (23, -5998, 'AMAZON.COM*7H2QX')]
    if k == 2: card_rows += [(5, -41218, 'MARRIOTT SEATTLE'), (5, -28940, 'ALASKA AIR'), (12, 2999, 'AMAZON.COM*7H2QX RETURN'), (16, -64999, 'BEST BUY 00412'), (21, -1599, 'CVS/PHARMACY #9821')]
    card_rows.sort(key=lambda r: r[0])
    # checking: pay, mortgage, the card, savings, bills, the car, insurance
    chk_rows = [(2, 385000, 'ACME CORP PAYROLL'), (3, -(PAY_M + ESC_M), 'ROCKET MORTGAGE PMT 5520'), (5, -pay_card, 'CHASE CREDIT CRD AUTOPAY'),
                (7, -50000, 'TRANSFER TO SAV 3302'), (9, -PGE[k], 'PGANDE WEB ONLINE'), (12, -PAY_T, 'TOYOTA FINANCIAL PMT'), (14, -8999, 'COMCAST CABLE AUTOPAY'),
                (16, 385000, 'ACME CORP PAYROLL'), (20, -13250, 'GEICO AUTO INS')]
    if k == 2: chk_rows.append((25, 70158, 'ACME CORP EXP REIMB'))
    chk_rows.sort(key=lambda r: r[0])
    interest = jsround(sav_bal * 0.004 / 12)
    sav_rows = [(7, 50000, 'TRANSFER FROM CHK 3301'), (29, interest, 'INTEREST PAYMENT')]

    # bills arrive before the period that pays them
    step('purch_add_bill', {'vendor': 'PG&E', 'number': f'PGE-{7710 + k}', 'bill_date': D(start - 2), 'due_date': D(start + 12), 'amount': PGE[k], 'currency': 'USD', 'category': 'utilities', 'file_name': 'pge-statement.pdf'}, 'emailed by PG&E')
    step('purch_add_bill', {'vendor': 'Comcast', 'number': f'C-{4401 + k}', 'bill_date': D(start - 1), 'due_date': D(start + 14), 'amount': 8999, 'currency': 'USD', 'category': 'internet'}, 'emailed by Comcast')

    cids, chk_bal = stmt(CHK, f'checking-{k + 1}.pdf', 'bank', k, chk_rows, chk_bal)
    sids, sav_bal = stmt(SAV, f'savings-{k + 1}.pdf', 'bank', k, sav_rows, sav_bal)
    kids, card_bal = stmt(CARD, f'sapphire-{k + 1}.pdf', 'card', k, card_rows, card_bal)
    # card facts as printed: minimum 2% (at least $35), due 25 days after the statement closes
    owed_now = -card_bal
    steps[-1][1].update({'minimum_due': max(3500, jsround(owed_now * 0.02)), 'payment_due_date': D(end + 25), 'credit_limit': 1500000, 'apr_bp': 2449})

    C = dict(zip([r[2] + str(r[0]) for r in chk_rows], cids)); S = dict(zip([r[2] for r in sav_rows], sids)); K = {}
    for r, t in zip(card_rows, kids): K.setdefault(r[2], []).append(t)
    cid = lambda d: next(t for r, t in zip(chk_rows, cids) if r[2] == d)
    last = k == 2
    # reviews: everything but what pairs, links or ties later
    review[CHK] += [{'transaction_id': cid('ACME CORP PAYROLL'), 'status': 'income', 'category': 'salary', 'vendor': 'Acme Corp'}]
    review[CHK] += [{'transaction_id': t, 'status': 'income', 'category': 'salary', 'vendor': 'Acme Corp'} for r, t in zip(chk_rows, cids) if r[2] == 'ACME CORP PAYROLL' and t != cid('ACME CORP PAYROLL')]
    review[CHK] += [{'transaction_id': cid('PGANDE WEB ONLINE'), 'status': 'purchase', 'category': 'utilities', 'vendor': 'PG&E'},
                    {'transaction_id': cid('COMCAST CABLE AUTOPAY'), 'status': 'purchase', 'category': 'internet', 'vendor': 'Comcast'},
                    {'transaction_id': cid('GEICO AUTO INS'), 'status': 'recurring', 'category': 'insurance', 'vendor': 'GEICO'}]
    review[SAV] += [{'transaction_id': S['INTEREST PAYMENT'], 'status': 'income', 'category': 'interest', 'vendor': 'Wells Fargo'}]
    cat = {"TRADER JOE'S #127": ('purchase', 'groceries', "Trader Joe's"), 'SAFEWAY #1871': ('purchase', 'groceries', 'Safeway'), 'SHELL OIL 57442': ('purchase', 'fuel', 'Shell'),
           'NETFLIX.COM': ('recurring', 'streaming', 'Netflix'), 'SPOTIFY USA': ('recurring', 'streaming', 'Spotify'), 'CHIPOTLE 2231': ('purchase', 'dining', 'Chipotle'),
           'CVS/PHARMACY #9821': ('purchase', 'medical', 'CVS'), 'TARGET 00021': ('purchase', 'household', 'Target'), 'AMAZON.COM*2K4LM': ('purchase', 'household', 'Amazon'),
           'KAISER PERMANENTE COPAY': ('purchase', 'medical', 'Kaiser Permanente'), 'AMERICAN RED CROSS': ('purchase', 'donations', 'American Red Cross'),
           'ANNUAL MEMBERSHIP FEE': ('fee', 'annual fee', None), 'AMAZON.COM*7H2QX': ('purchase', 'household', 'Amazon'), 'BEST BUY 00412': ('purchase', 'electronics', 'Best Buy'),
           'MARRIOTT SEATTLE': ('purchase', 'travel', 'Marriott'), 'ALASKA AIR': ('purchase', 'travel', 'Alaska Airlines')}
    for d, ts in K.items():
        if d not in cat: continue
        st, c, v = cat[d]
        for t in ts: review[CARD].append({'transaction_id': t, 'status': st, 'category': c, **({'vendor': v} if v else {})})
    # what is done in the earlier periods and left for the videos in the latest
    if not last:
        later['pairs'] += [(cid('CHASE CREDIT CRD AUTOPAY'), K['AUTOMATIC PAYMENT - THANK YOU'][0], 'the card paid in full from checking'),
                           (cid('TRANSFER TO SAV 3302'), S['TRANSFER FROM CHK 3301'], 'the monthly move to savings')]
        later['loans'] += [('LN-0001', cid('ROCKET MORTGAGE PMT 5520'), 'the mortgage payment'), ('LN-0002', cid('TOYOTA FINANCIAL PMT'), 'the car payment')]
    later['bills'] += [(f'B-%04d' % (2 * k + 1), cid('PGANDE WEB ONLINE'), D(start + 9), 'PG&E'), (f'B-%04d' % (2 * k + 2), cid('COMCAST CABLE AUTOPAY'), D(start + 14), 'Comcast')] if not last else \
                      [(f'B-%04d' % (2 * k + 2), cid('COMCAST CABLE AUTOPAY'), D(start + 14), 'Comcast')]
    if k == 0: later['receipts'].append(({'name': 'cvs-receipt.jpg', 'hash': 'hometry-cvs-receipt', 'vendor': 'CVS', 'date': D(start + 12), 'total': 2399, 'currency': 'USD'}, K['CVS/PHARMACY #9821'][0]))
    if last:
        later['receipts'].append(({'name': 'bestbuy-receipt.jpg', 'hash': 'hometry-bestbuy-receipt', 'vendor': 'Best Buy', 'date': D(start + 16), 'total': 64999, 'currency': 'USD',
                                   'return_by': D(start + 16 + 30), 'warranty_until': D(start + 16 + 365)}, K['BEST BUY 00412'][0]))
        later['reimbursable'] += [K['MARRIOTT SEATTLE'][0], K['ALASKA AIR'][0]]
    # the mortgage's balance after this period's payment, for the lender's figure
    for _ in [0] if not last else []:
        i = jsround(bal_m * RATE_M / 10000 / 12); bal_m -= (PAY_M - i)
    if k == 1: later['values'].append(('ACC-0004', D(end), bal_m))

# ---------------------------------------------------------------- reviewed, paired, linked
for acct, rows in review.items():
    rows.sort(key=lambda r: int(r['transaction_id'][2:]))
    step('purch_review_batch', {'rows': rows, 'reason': 'Maya went through the statements with Claude'})
for t in later['reimbursable']:
    step('purch_review_transaction', {'transaction_id': t, 'status': 'purchase', 'category': 'travel', 'reimbursable_by': 'Acme Corp, expenses', 'claim_ref': 'ER-2207', 'reason': 'Maya: the Seattle client trip, on expense report ER-2207'})
for o, i, why in later['pairs']: step('purch_pair_transfer', {'out_transaction_id': o, 'in_transaction_id': i, 'reason': why})
for loan, t, why in later['loans']: step('loan_link_payment', {'loan_id': loan, 'transaction_id': t, 'reason': why})
for b, t, day, vendor in later['bills']:
    if vendor == 'PG&E': step('purch_approve_bill', {'bill_id': b, 'note': 'Maya: pay it'})
    step('purch_record_bill_payment', {'bill_id': b, 'paid_at': day, 'method': 'bank_transfer' if vendor == 'PG&E' else 'direct_debit', 'transaction_id': t})
for r, t in later['receipts']:
    step('purch_add_receipt', r, 'Maya took a photo')
for n, (r, t) in enumerate(later['receipts']):
    step('purch_match_receipt', {'receipt_id': 'R-%04d' % (n + 1), 'transaction_id': t, 'reason': 'same shop, same day, same total'})
for acct, day, owed in later['values']:
    step('purch_record_value', {'account_id': acct, 'as_of': day, 'amount': owed, 'according_to': 'Rocket Mortgage monthly statement'}, 'Maya: from the mortgage statement')
step('purch_add_bill', {'vendor': 'Alder Dental', 'number': 'AD-3381', 'bill_date': D(-10), 'due_date': D(10), 'amount': 18500, 'currency': 'USD', 'category': 'medical', 'file_name': 'alder-dental.pdf'}, 'the dentist\'s bill, in the mail')
step('purch_tag_category', {'category': 'medical', 'tag': 'medical', 'reason': 'Maya: for the medical deduction'})
step('purch_tag_category', {'category': 'donations', 'tag': 'charitable', 'reason': 'Maya: we itemize gifts'})

out = os.path.join(os.path.dirname(__file__), '..', 'fixtures', 'hometry.json')
json.dump(steps, open(out, 'w'), indent=1, ensure_ascii=False)
print(f'{len(steps)} steps, {tid[0]} statement rows -> fixtures/hometry.json')
