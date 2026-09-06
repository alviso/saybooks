# solo — Freelancer Invoicing · Area Specification

**Status: 0.2.** The fourth area, deliberately tiny.

Solo is NOT o2c-lite — it is a different calibration, extracted from a different life. o2c
bills what shipped because a warehouse must; a freelancer has no warehouse, no fulfilment, and
no credit committee. What they have is an agreement with a client and a need for clean,
immutable invoices and an honest picture of who owes what. Solo records exactly that.

## 1. Calibration: who this is for

One person (or a very small team) selling their own work: consultants, developers, designers,
trades. A handful of clients, invoices with free-text lines, payment by whatever was agreed.
Any currency the company names, one per invoice (0.2). The chat agent is often the ONLY interface — the doctrine is
written as an interactive guide, and refusals steer the conversation, not just the tool call.

## 2. Scope

In: clients (core customer, reused), drafting and issuing invoices, voiding with reasons,
recording and applying payments, outstanding and statements, the printable document with a
shareable link, journal derivation for the accountant. 0.2: the company's country, currency
set, tax scheme and numbering format, so a New Zealand GST-registered business and a US
consultant billing in CZK both get a correct document without touching the code.

Out (§9): orders/fulfilment (that is o2c), credit gating (the freelancer IS the credit
authority), currency conversion, recurring invoices, sending anything anywhere.

## 3. Entities and lifecycles

- **client** — core's customer, as-is, carrying a billing address and tax id (0.1.1). Terms
  live in the human agreement; the record keeps the default terms note for convenience, never
  enforces them. A client without a billing address cannot be issued to: the document would
  be incomplete, and the refusal says what to ask for.
- **company profile** (core) — the seller block plus, at 0.2, the country (how dates and
  amounts print), the currency set with a default, the tax scheme (label, default rate,
  registered or not, how the tax id is captioned) and the numbering format. Owner-only.
- **invoice** — draft → issued → paid | void. A draft is a worksheet: lines are free text
  (description · qty · rate, optional per-line tax rate and reference), a currency from the
  company's set, an optional subject line, editable until issued. Issuing
  assigns nothing new — the number existed from the draft — but freezes everything: the
  seller block from the company profile, the bill-to block from the client, the amounts, the
  due date. Paid is derived from applications. Void requires a reason and burns the number forever.
- **payment** — recorded as received (unapplied is a real state), applied to invoices with
  bounds on both sides, refusals naming the numbers.
- **document link** — the draft mints a per-invoice token; `/doc/<space>/<token>` renders the
  real document, stamped DRAFT until issued (0.1.1: the preview a person looks at before the
  point of no return, so nobody hand-rolls a document). At issue the same link becomes the
  invoice — the link the freelancer forwards to their client — and `<token>.pdf` is the same
  document as a file (issued invoices only). Void does not kill the link: the document stays
  readable and printable, stamped VOID, because a record you cannot read is not a record;
  `open` is 0 on a void invoice so no reader has to remember the status.

## 4. The acts

Writes (6): draft_invoice, update_draft, issue_invoice, void_invoice, record_payment,
apply_payment. Reads (4): invoice, document, outstanding, statement. Environment (core, existing):
create_customer, update_customer, set_company_profile.

## 5. Invariants

- **S-1** Money is integer cents, everywhere.
- **S-2** An issued invoice is immutable. Mistakes are void-and-reissue, on the record; a
  draft is the only editable state.
- **S-3** The seller block and the bill-to block freeze at issuance. Changing company or
  client details never reprints history. Issuing without a company profile, or to a client
  without a billing address, is refused — and the refusal tells the agent to gather the
  details conversationally, one question at a time.
- **S-4** Numbers are sequential and never reused. A voided number stays burned.
- **S-5** Invoice timing is the freelancer's agreement — ahead of the work, partial, or
  after. The system records; it never gatekeeps terms.
- **S-6** No invented facts: amounts, dates, names come from the person or stay empty.
- **S-7** Documents are produced, never sent; payments are recorded, never moved. The
  document link is a capability to view one document, nothing more.
- **S-8** Every write is a logged act with an actor; refusals are logged too.
- **S-9** Journal derivation balances (o2c INV-23 family): issue → AR / Revenue (+ Tax
  Payable), receipt → Cash / Deposits, application → Deposits / AR. Amounts post in the
  invoice's currency; nothing converts.
- **S-10** An invoice carries exactly one currency, from the company's set; a payment too.
  Cash never crosses currencies: applying a USD payment to a CZK invoice is refused whatever
  the numbers say. Sums are per currency; a grand total exists only when there is one.
- **S-11** Tax follows the company's scheme, frozen with the seller block at issue. Not
  registered: no line may carry tax, the write is refused naming who can change that.
  Registered: every line defaults to the company's rate, a line may opt out at 0, the
  document prints TAX INVOICE, the tax name and rate, and the tax id under its own caption.
- **S-12** Numbers follow the company's format — a sequence token, optionally a year token
  that restarts the sequence each year — and remain sequential and never reused within it (S-4).

## 6. Required read models

invoice (the whole document: lines, seller and bill-to snapshots, applied/open, the doc link),
document (0.1.1: the rendered page as a picture, DRAFT-stamped until issued, and the PDF file once issued —
so an agent looks at the real render before issue and hands over the file after),
outstanding (issued-unpaid, oldest first, days overdue, totals), statement (one client's
invoices and payments, chronological, closing balance).

## 7. Contract vs freedom

Contract: draft-only mutability, seller freeze, burned numbers, bounds on application,
produce-never-send, one currency per invoice, the tax scheme's refusals. Freedom: the
numbering format itself, which currencies and rates a business names (capturing them is
ours; deciding them is the freelancer's and their accountant's), how the agent phrases the guide.

## 8. Conformance (scenarios)

01 the first invoice: profile → client → draft → issue (doc fields present) → partial
payment → apply → outstanding shows the remainder · 02 immutability: update after issue
refused; issue without profile refused with the guide sentence; void with reason; number
burned; paid-invoice void refused · 03 New Zealand: GST registered at 15%, NZD from the
profile, default tax on every line with one zero-rated line, TAX INVOICE at issue, paid in
NZD · 04 unregistered business with USD and CZK: taxed line refused, unknown currency refused,
F-{NNN} numbering, a USD payment refused against the CZK invoice, the CZK one applied.

## 9. Deferred — with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Credit notes / corrections on paid invoices** | Void covers the unpaid case; applied-cash unwinding needs its own design pass. |
| **Recurring invoices** | Real freelancer need; add with demand, not speculation. |
| **Currency conversion / FX** | 0.2 bills in any currency the company names, one per invoice, and never converts. Reporting across currencies in one figure needs rates, a source for them, and a policy — not this area's. |
| **Tax-inclusive pricing** | Rates are entered exclusive of tax. Some markets quote inclusive; it doubles the arithmetic paths and needs its own scenarios. |
| **Sending (email the client)** | The doc link makes it one step away, which is exactly why the boundary must be crossed deliberately or not at all. |
| **Late fees / interest** | Terms live in the agreement; automating them is policy the system refuses to own at 0.1. |

---

*Change log: 0.1-draft (2026-09-02) — drafted with Peter's refocus from an o2c door to a
freelancer invoice generator; the interactive-guide doctrine and S-5 came from that
conversation. 0.1.1 (2026-09-04) — client address + tax id, bill-to block frozen at issue, preview link from the first draft (DRAFT-stamped), document read returning the rendered page and the PDF; void invoices stay readable (VOID-stamped) with open = 0. 0.2 (2026-09-05) — company country, currency set with per-invoice currency, tax scheme with registration (S-10, S-11), numbering format (S-12), per-line refs and a subject line; prompted by a New Zealand freelancer's sample invoice and Peter's CZK/USD billing.*
