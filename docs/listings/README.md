# Registry and directory listings

Everything needed to list Saybooks where MCP servers and personal finance tools are listed.
The listings lead with household books; invoicing, the job hunt and order to cash are named
once, at the end. Do them once, update on version bumps.

Saybooks' hosted endpoint is `https://saybooks.io/mcp`, an OAuth-protected resource: a client
signs the person in with Google, a consent page asks which of their books to open and what the
agent may do, and the connection gets a key minted for it. Narrower doors open one kind of
books, which keeps the tool list short:

| Door | Opens |
|---|---|
| `https://saybooks.io/mcp` | any of your books (the listed address; never change it) |
| `https://saybooks.io/mcp/household` | household spaces only: personal finances and loans |
| `https://saybooks.io/mcp/invoices` | invoicing |
| `https://saybooks.io/mcp/hunt` | the job hunt |
| `https://saybooks.io/mcp/books` | order to cash and the rest of a business's books |

Listings describe `/mcp` and point at https://saybooks.io/personal and
https://saybooks.io/docs#connect. Self-hosters run `node mcp-server.js` (stdio). The Claude
Connectors Directory has its own copy in `claude-directory.md`.

## Where, in order

1. **Official MCP Registry** (registry.modelcontextprotocol.io). Self-serve, no review.
   Namespace `io.github.alviso/*` is verified through GitHub, so the founder runs it:

   ```bash
   brew install mcp-publisher        # once
   cd docs/listings
   mcp-publisher login github        # device flow: confirm in the browser as alviso
   mcp-publisher publish             # reads server.json in this directory
   ```

   `server.json` follows the 2025-12-11 schema. The description is capped at 100 characters.
   Every publish needs a new `version`. PulseMCP and Glama read from this registry.
2. **Glama** (glama.ai/mcp). Sign in with GitHub. Add the repository as a server and
   `https://saybooks.io/mcp` as a connector, then claim both. The connector badge is required
   by awesome-remote-mcp-servers.
3. **MCP Market** (mcpmarket.com/server/saybooks). Already listed, auto-built from an old
   README under Productivity and E-commerce. Ask support (thread open since 2026-09-17) to
   move it to Finance and regenerate the description from the copy below.
4. **Free submission forms**: mcpservers.org, mcp.so (Remote Server), openalternative.co,
   opensourcealternatives.to, SaaSHub, AlternativeTo. Use the copy below. Skip paid fast tracks.
5. **awesome-mcp-servers** and **awesome-remote-mcp-servers** (both punkpeye): one line each in
   the Finance section, by pull request, in the list's own format.

Not listed: Smithery. It closed its accounts and hosting on 2026-10-31 and is now a curated
directory with no way to submit.

## Listing copy

**Name:** Saybooks

**One line** (98 characters, the registry limit is 100):

    Books your AI keeps from your own bank statements: cards, loans, bills, receipts and the tax year.

**Short description** (for forms with a small box):

    Saybooks keeps your household's books from the statements you hand your AI: accounts and
    net worth, the credit card, loans and the mortgage, bills and what's due, receipts, and a
    year summary for taxes. No bank login. The rules hold for the agent as for you, and it
    never moves money. Free and open source.

**Description:**

    Saybooks is a set of books an AI assistant keeps for you, through MCP, from your own bank
    and card statements. There is no bank feed and no bank password. You hand the agent a
    statement, and it is taken whole only when its rows add up to the balances printed on it,
    or refused with the gap named.

    From there it keeps your accounts and net worth, transfers counted once, the credit card,
    loans and the mortgage split the way the lender prints them, bills and what is due next,
    receipts with their return and warranty dates, reimbursements, and a year summary for
    whoever does your taxes. Any bank that gives you a statement, in any currency.

    The rules are enforced on the agent exactly as on a person. It prepares; approving a bill
    stays yours, and it never moves money. Every act goes into one audit trail: who did it,
    when, and why. The same books open in the browser.

    Works with Claude, ChatGPT, Gemini and any MCP client: sign in with Google when you
    connect and pick which books to open. Free. Open source under AGPL-3.0; run it yourself or
    keep it on your Mac. Saybooks also keeps invoicing for freelancers, a job-hunt tracker,
    and order-to-cash books for small businesses.

**Categories:** personal finance, finance, accounting, productivity

**Alternative to** (for AlternativeTo, SaaSHub and the open source alternative sites): Mint,
Monarch Money, Quicken Simplifi, Copilot Money. Saybooks tracks and keeps records; it does
not do budgets, so do not list it against YNAB as a budgeting app.

**Auth:** OAuth 2.1 with dynamic client registration; the person signs in with Google at
connect time. Keys can be revoked from the workbench at any time.

**Links:** https://saybooks.io/personal · https://saybooks.io/docs#connect ·
https://saybooks.io/specs/purchases · https://github.com/alviso/saybooks ·
https://saybooks.io/privacy

**Demo, no sign-up:** https://saybooks.io/app?demo=home (a made-up household with three months
of statements, a credit card, a mortgage and a car loan)

**Videos:** the five-part personal finances series,
https://www.youtube.com/playlist?list=PLMhDqYJzdhos
