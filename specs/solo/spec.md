# solo — Freelancer Invoicing · Area Specification

**Status: 0.1-draft.** The fourth area, deliberately tiny.

Solo is NOT o2c-lite — it is a different calibration, extracted from a different life. o2c
bills what shipped because a warehouse must; a freelancer has no warehouse, no fulfilment, and
no credit committee. What they have is an agreement with a client and a need for clean,
immutable invoices and an honest picture of who owes what. Solo records exactly that.

## 1. Calibration: who this is for

One person (or a very small team) selling their own work: consultants, developers, designers,
trades. A handful of clients, invoices with free-text lines, payment by whatever was agreed.
USD only at 0.1, limit stated. The chat agent is often the ONLY interface — the doctrine is
written as an interactive guide, and refusals steer the conversation, not just the tool call.

## 2. Scope

In: clients (core customer, reused), drafting and issuing invoices, voiding with reasons,
recording and applying payments, outstanding and statements, the printable document with a
shareable link, journal derivation for the accountant.

Out (§9): orders/fulfilment (that is o2c), credit gating (the freelancer IS the credit
authority), multi-currency, recurring invoices, sending anything anywhere.

## 3. Entities and lifecycles

- **client** — core's customer, as-is. Terms live in the human agreement; the record keeps
  the default terms note for convenience, never enforces them.
- **invoice** — draft → issued → paid | void. A draft is a worksheet: lines are free text
  (description · qty · rate, optional per-line tax rate), editable until issued. Issuing
  assigns nothing new — the number existed from the draft — but freezes everything: the
  seller block from the company profile, the amounts, the due date. Paid is derived from
  applications. Void requires a reason and burns the number forever.
- **payment** — recorded as received (unapplied is a real state), applied to invoices with
  bounds on both sides, refusals naming the numbers.
- **document link** — issuing mints a per-invoice token; `/doc/<space>/<token>` renders the
  printable document and nothing else. The link the freelancer forwards to their client.

## 4. The acts

Writes (6): draft_invoice, update_draft, issue_invoice, void_invoice, record_payment,
apply_payment. Reads (3): invoice, outstanding, statement. Environment (core, existing):
create_customer, set_company_profile.

## 5. Invariants

- **S-1** Money is integer cents, everywhere.
- **S-2** An issued invoice is immutable. Mistakes are void-and-reissue, on the record; a
  draft is the only editable state.
- **S-3** The seller block freezes at issuance. Changing company details never reprints
  history. Issuing without a company profile is refused — and the refusal tells the agent to
  gather the details conversationally, one question at a time.
- **S-4** Numbers are sequential and never reused. A voided number stays burned.
- **S-5** Invoice timing is the freelancer's agreement — ahead of the work, partial, or
  after. The system records; it never gatekeeps terms.
- **S-6** No invented facts: amounts, dates, names come from the person or stay empty.
- **S-7** Documents are produced, never sent; payments are recorded, never moved. The
  document link is a capability to view one document, nothing more.
- **S-8** Every write is a logged act with an actor; refusals are logged too.
- **S-9** Journal derivation balances (o2c INV-23 family): issue → AR / Revenue (+ Tax
  Payable), receipt → Cash / Deposits, application → Deposits / AR.

## 6. Required read models

invoice (the whole document: lines, seller snapshot, applied/open, the doc link),
outstanding (issued-unpaid, oldest first, days overdue, totals), statement (one client's
invoices and payments, chronological, closing balance).

## 7. Contract vs freedom

Contract: draft-only mutability, seller freeze, burned numbers, bounds on application,
produce-never-send. Freedom: numbering prefix, tax determination (rates are captured and
frozen; deciding them is the freelancer's job), how the agent phrases the guide.

## 8. Conformance (scenarios)

01 the first invoice: profile → client → draft → issue (doc fields present) → partial
payment → apply → outstanding shows the remainder · 02 immutability: update after issue
refused; issue without profile refused with the guide sentence; void with reason; number
burned; paid-invoice void refused.

## 9. Deferred — with reasons

| Item | Why deferred, not rejected |
|---|---|
| **Credit notes / corrections on paid invoices** | Void covers the unpaid case; applied-cash unwinding needs its own design pass. |
| **Recurring invoices** | Real freelancer need; add with demand, not speculation. |
| **Multi-currency** | Same whole-area concern as everywhere. USD stated plainly. |
| **Sending (email the client)** | The doc link makes it one step away, which is exactly why the boundary must be crossed deliberately or not at all. |
| **Late fees / interest** | Terms live in the agreement; automating them is policy the system refuses to own at 0.1. |

---

*Change log: 0.1-draft (2026-09-02) — drafted with Peter's refocus from an o2c door to a
freelancer invoice generator; the interactive-guide doctrine and S-5 came from that
conversation.*
