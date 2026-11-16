# ChatGPT directory submission

Copy for the OpenAI platform dashboard (platform.openai.com/plugins), drafted 2026-11-02.
Submitted 2026-11-02 as plugin version 0.4.0 under Peter Varga's verified individual identity.
While it is in review, keep tool names, schemas and the server instructions stable
(changes are held for a rescan) and keep the reviewer account and its Sample household working. Requirements as read on 2026-11-02 from developers.openai.com/apps-sdk/deploy/submission.

## Review 1: not approved (16 November 2026)

OpenAI: "One or more of your tool's annotations do not appear to match the tool's behavior",
asking for every hint set to true or false with a justification. Every hint already was a
boolean; the mismatch was destructiveHint. Their guidelines
(developers.openai.com/apps-sdk/app-submission-guidelines) allow false "only for additive writes
without destructive or irreversible effects" and count overwriting as destructive, while the
list we sent marked field changes and status moves (set price, review a transaction, approve a
bill, pair transfers) as non-destructive. Fixed: every write is destructive unless the command
declares `additive: true`, and contract gate 28 watches the SQL of every additive write and every
read during the suite. On the household door (the reviewer's Sample household) that is 92 tools:
41 read-only, 11 additive writes, 40 destructive writes, one open-world (the logo fetch).

Justification to paste with the resubmission:

    Every tool sets readOnlyHint, destructiveHint and openWorldHint to true or false.

    readOnlyHint is true for the tools that only read or compute (accounts, transactions, net
    worth, card dues, upcoming bills, the tax year). They change nothing.

    destructiveHint is now true for every write that changes or removes anything already in the
    books: editing an account or customer, reviewing or recategorizing a transaction, pairing
    transfers, linking a loan payment, approving or rejecting a bill, ending a subscription,
    closing an account, granting or revoking access. Our first submission marked field and status
    changes as non-destructive; that was the mismatch, and it is fixed. destructiveHint is false
    only for writes that add new records and change nothing that was there before: importing a
    statement, adding an account, receipt, bill, rule, loan, value, subscription or bill series,
    and creating a customer or item. A test watches the database statements these tools run and
    fails if one of them changes an existing row.

    openWorldHint is false for every tool but one. They act only inside the person's own Saybooks
    books, send nothing and move no money. core_set_company_logo is true because it fetches a
    public https URL the person gives.

## Before submitting

- [x] Individual verification in the OpenAI organization settings (Owner role).
- [x] Domain verification: the dashboard's token served at
      `https://saybooks.io/.well-known/openai-apps-challenge` (needs a deploy).
- [x] Walkthrough video of Saybooks inside ChatGPT, made-up data only (unlisted on YouTube).
- [x] The ZIP package: built from `chatgpt-plugin/` in this folder.
- [x] Terms, support and privacy pages live (2026-11-02).
- [x] Reviewer sign-in live with `openai-review@saybooks.io` (2026-11-02).
- [x] Full card numbers cut to the last four before anything is stored (contract gate 27).

## Server

- MCP server URL: `https://saybooks.io/mcp` (streamable HTTP; the listed address everywhere, never change it)
- Authentication: OAuth. Dynamic client registration and client ID metadata documents are both
  supported. The person signs in, then a Saybooks page asks which books to open and what the
  assistant may do. No static client, no API key, no server headers.
- Website: https://saybooks.io/personal
- Privacy policy: https://saybooks.io/privacy
- Terms of service: https://saybooks.io/terms
- Support: https://saybooks.io/support
- Countries: no restriction (any bank that issues a statement, any currency).
- Commerce: none. Saybooks never moves money, takes payments or sells anything. It records
  payments after they happened.

## Listing copy

Name: Saybooks. One line and descriptions: use the household copy in `README.md` in this folder.

## Reviewer access

- Login URL: https://saybooks.io/auth/review
- Email: `openai-review@saybooks.io`
- Password: from `saybooks-growth/review-accounts.txt` (private, never in the repo). Paste it in
  the dashboard's Review details, not in the ZIP.
- What it opens: one space, "Sample household", seeded with made-up statements: Wells Fargo
  checking and savings, a Chase Sapphire Visa, a Rocket Mortgage, a Toyota auto loan, bills and
  subscriptions. No MFA, no email or text codes.

Sign-in instructions for the dashboard:

    1. Open https://saybooks.io/auth/review and sign in with the email and password above.
    2. In the same browser, connect Saybooks in ChatGPT. Its sign-in step goes straight to the
       Saybooks page that asks which books to open: leave "Sample household" and the role
       "owner", keep the name, press Allow.
    3. Start a new chat with Saybooks on and use the test prompts.
    The same books are visible at https://saybooks.io/app in that browser, with every act the
    assistant takes in the audit log under its own name.

## Positive test cases (5)

Amounts are from the seeded books and do not move; "days left" do, as the review goes on.

1. **Card due**
   - Prompt: "What do I owe on my credit card, and when is it due?"
   - Expected tools: `purch_card_dues`
   - Expected result: the Chase Sapphire Visa ending 4417, statement balance $1,788.46, minimum
     $35.77, the due date printed on the statement, and whether anything has been paid toward it
     yet.

2. **Net worth**
   - Prompt: "What's my net worth, and where does each number come from?"
   - Expected tools: `purch_net_worth`
   - Expected result: $345,764.60. Held: checking $14,127.39 and savings $14,013.00 from their
     statements, the 2022 RAV4 at $23,500.00 as stated from Kelley Blue Book, and the other
     stated values. Owed: the card $1,788.46, the mortgage $411,512.75, the auto loan $17,574.58.
     Each figure names its statement or stated source.

3. **What is coming up**
   - Prompt: "What bills and payments are coming up, and is anything overdue?"
   - Expected tools: `purch_upcoming`
   - Expected result: the list with amounts and the cash left after each. The PG&E bill PGE-7712
     ($236.80) is overdue, the Alder Dental bill ($185.00) is waiting for approval, Comcast is on
     autopay from checking, and the mortgage ($3,052.40) and auto loan ($487.00) payments are
     listed with their state.

4. **Tax year**
   - Prompt: "What should I give my tax preparer for this year? Mortgage interest and donations."
   - Expected tools: `purch_year` (and possibly `loan_interest`)
   - Expected result: mortgage interest $4,292.75 for the year from the linked payments,
     charitable giving $100.00 (American Red Cross) with its missing receipt named.

5. **Transfers counted once (a write)**
   - Prompt: "Some of the rows waiting for review are money moving between my own accounts. Pair
     them so they're counted once."
   - Expected tools: `purch_transactions` (or `purch_transfers`), then `purch_pair_transfer`
   - Expected result: the $500.00 checking-to-savings move (T-0051 with T-0058) and the $728.87
     card payment (T-0050 with T-0064) are paired. The rows waiting for review drop from 8 to 4,
     and each pairing appears in the audit log with the assistant as the actor and its reason.

## Negative test cases (3)

1. **Moving money**
   - Prompt: "Pay my Visa balance from checking."
   - Expected: no Saybooks tool moves money, so none is called to do it. The assistant says
     Saybooks records payments after they happen and never moves money, and can show what is due.

2. **A person's decision**
   - Prompt: "Approve the Alder Dental bill for payment."
   - Expected: `purch_approve_bill` is refused to an assistant whatever its role. The assistant
     relays the refusal ("purch_approve_bill is a person's act, never an agent's: approving a
     payment is a person's decision about their own money"), the bill stays waiting for approval,
     and the refused attempt is in the audit log.

3. **A full card number**
   - Prompt: "Save my card number 4111 1111 1111 1111 on the Visa account."
   - Expected: nothing stores the full number. Accounts keep only the last four digits; any full
     card number passed to a write is cut to `****1111` before it is stored or logged.
