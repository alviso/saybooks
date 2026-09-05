# Registry and directory listings

Everything needed to list Saybooks where MCP servers are listed. None of these surface inside
Claude; they are backlinks and the places a developer checks that you exist. Do them once,
update on version bumps.

Saybooks' hosted endpoint is per key: `https://saybooks.io/mcp/<key>`. There is no single
public URL that opens someone's books, and there must not be. Listings therefore describe a
**remote server that the user supplies their own key for**, and point people at
https://saybooks.io/docs#connect to mint one. Self-hosters run `node mcp-server.js` (stdio).

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

Self-serve, no review. Namespace `io.github.alviso/*` is verified through GitHub — the
publisher CLI logs in with a device-flow prompt, so the founder runs it:

```bash
# once
brew install mcp-publisher            # or: curl the release binary
cd docs/listings
mcp-publisher login github            # device flow: opens a code, confirm in the browser as alviso
mcp-publisher publish                 # reads server.json in this directory
```

`server.json` is in this directory. Bump `version` on every release worth announcing.

## 2. Glama (glama.ai/mcp/servers)

Sign in with GitHub, "Add server", point at the repository. Glama scans the repo and the
README; keep the README's first paragraph honest and short. Category: Finance / Business.

## 3. Smithery (smithery.ai)

Sign in with GitHub, "Add server", repository `alviso/saybooks`. Choose **remote** with
"user supplies credentials" and paste the description below. Smithery may ask for a
`smithery.yaml`; the one in this directory declares a remote server with a `key` config
value that becomes the URL path.

## 4. PulseMCP (pulsemcp.com) and mcp.so

Both are submission forms: name, URL, repository, description, category. Use the
description below verbatim.

## Listing copy

**Name:** Saybooks

**One line:** Books your agent can keep but cannot break — invoices, orders, receivables and
a job hunt, with every rule enforced on the agent exactly as on a person, and one audit
trail for both.

**Description:** Saybooks is an open-source (AGPL-3.0) business system where the MCP tools
and the web interface are the same command registry: every act is declared once, and the
tool, the form, the guard and the audit row derive from it. An agent connects with a key
minted for a role; a command outside the rules is refused in one sentence with the reason,
and the refusal is logged next to the human clicks. Modules today: core master data,
order-to-cash with credit control, CRM, freelancer invoicing with PDF documents, and a
job-hunt tracker. Specs and executable conformance scenarios are public at
https://saybooks.io/specs. It records; it never emails, charges, or moves money.

**Categories:** finance, business, ERP, invoicing, CRM, productivity

**Auth:** user-supplied key (minted in the Saybooks workbench); OAuth front door in progress.

**Links:** https://saybooks.io · https://saybooks.io/docs · https://saybooks.io/specs ·
https://github.com/alviso/saybooks · https://saybooks.io/privacy
