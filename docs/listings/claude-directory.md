# Claude Connectors Directory submission

Copy for the portal at https://claude.ai/admin-settings/directory/submissions/new (Team or
Enterprise org, submitted by an Owner). Character limits are the portal's. Paste, don't polish.

## Connection

- Server URL: `https://saybooks.io/mcp`
- Transport: streamable HTTP
- Every user connects to the same URL: yes. (Kind-specific doors such as `/mcp/invoices`
  exist for people holding several spaces; they are custom-connector addresses, not the listing.)

## Listing

**Name** (100 max)

    Saybooks

**Tagline** (55 max, 42 used)

    Books your agent can keep but cannot break

**Description** (2,000 max)

    Saybooks is a place Claude can keep your business records: customers, orders,
    invoices, payments, receivables, a small CRM, and a job hunt for people between roles.

    Every rule in your books is enforced on the agent exactly as on a person. An order over
    the credit limit is refused with the reason, an invoice without a client address will
    not issue, a voided invoice stays readable and is never reused. When Claude is refused
    it tells you why and who can decide, and the attempt is logged.

    One audit trail records everything: what was done, by whom (you, a person you invited,
    or the agent under its own name), when, and the reason given. Reads are never logged;
    writes always are. What Claude does through the connector appears in your browser the
    moment it happens, on the same pages you use.

    Money is integer cents. Nothing is invented: a missing date, amount or name is asked
    for, never guessed. Saybooks has no outbound channel. It never emails a customer, never
    charges a card, never moves money. It records.

    Invoices render as real documents from the first draft, with a link you can forward
    and a PDF at the same address. Your company profile and logo print on every one.

    Connecting takes a minute: add the connector, sign in with Google, pick which books to
    open and what the agent may do (controller by default), and name it for the audit log.
    The key it receives can be revoked from the workbench at any time.

    Open source under AGPL-3.0 at github.com/alviso/saybooks. The rules are written as
    public specifications at saybooks.io/specs, and the build fails if the code stops
    conforming to them. Run it yourself if you would rather not trust a hosted service.

**Categories** (1 to 5): Finance & Accounting · Business · Productivity

**Documentation URL**: https://saybooks.io/docs
**Privacy policy URL**: https://saybooks.io/privacy
**Support contact**: hello@saybooks.io  (confirm the mailbox receives mail before submitting)
**Icon URL**: https://saybooks.io/icon-512.png (also https://saybooks.io/icon-1024.png)
**Slug**: `saybooks` (permanent once published)

## Use cases

**Primary use cases**

    Freelancers invoicing clients by talking: "invoice Contoso for 12 hours at $150", see
    the draft, issue it, forward the link, record the payment when it lands.
    Small businesses running order to cash: confirm orders, receive stock, ship, invoice
    what shipped, apply payments, keep credit limits honest.
    People open to work tracking a job hunt: postings, applications, interviews, contacts,
    what is due today.
    Anyone who wants an agent to keep records it cannot quietly break, with a log they can
    read back.

**What users need before connecting**

    A Google account. Sign in once at saybooks.io/app to create a space (free), then add
    the connector. Consent lists the spaces the account belongs to.

**Reads data, writes data, or both**: both.

## Company

- Company: Crankk Inc (Saybooks is a Crankk product)
- Website: https://saybooks.io
- Primary contact: Peter Varga, pre-filled from the account

## Authentication

- OAuth 2.0 with PKCE. Authorization-server metadata at
  `/.well-known/oauth-authorization-server`, protected-resource metadata at
  `/.well-known/oauth-protected-resource/mcp`.
- Dynamic client registration: supported (public clients).
- Client ID metadata documents: supported.
- Static client id held by Anthropic: not needed.
- No tools work without authentication; the server answers 401 with the resource metadata
  pointer until a bearer token is presented.

## Data handling

- The underlying API is our own. No partner or third-party API is proxied.
- No personal health data. No sponsored content.
- The connector never calls an AI model itself and never sends data to one.

## Test & launch

**Test account** (fill the password in the portal, not here)

    Google account: saybookstester@gmail.com
    Password: <paste in the portal>
    Space: "My books" (id sp790ecc8e65), populated with the example story: company profile,
    customers, items, stock, orders, shipments, invoices, payments, and refusals.

**Steps for the reviewer**

    1. Add the connector at Customize → Connectors → Add with the URL above, or pick it
       from the directory once listed.
    2. Claude opens a Google sign-in. Use the test account.
    3. The Saybooks consent page shows one space, "My books". Leave the role as controller,
       leave the audit name, press Allow.
    4. Start a new chat. Try:
       - "Who owes us money?"                  (read)
       - "Show me the audit trail"             (read; agent and human entries side by side)
       - "Try to ship the order on credit hold" (a refusal with the business reason)
       - "Record that Contoso paid in full today by bank transfer" (a write)
    5. Open https://saybooks.io/app in the same Google account to see the same entries in
       the browser, attributed to the agent.
    If Google shows a verification screen for an unfamiliar device, email hello@saybooks.io
    and we clear it within the hour.

**All tools run by us**: yes, via the connector in Claude on 2026-09-05 (this test account)
and via the conformance suite that runs every command at build time.

## Compliance acknowledgments (the seven)

- Directory guidelines: read.
- First-party API usage: the API is ours.
- Financial transactions: none. Saybooks records money, it never moves it.
- AI media generation: none.
- Prompt injection: tool results are data. Descriptions instruct the agent to relay
  refusals, never route around them, and never invent values.
- Conversation data collection: none. The server sees tool calls, not conversations.
- Public documentation: https://saybooks.io/docs and https://saybooks.io/specs.
