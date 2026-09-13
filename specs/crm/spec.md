# crm — Relationship Pursuit · Area Specification

| | |
|---|---|
| **Version** | 0.3 |
| **Status** | curated draft — implementation not started |
| **Curator** | Peter Varga (single editor; spec PRs separate from implementation PRs) |
| **Calibration** | a curated target list worked by a small team, not a mass-market funnel |
| **Provenance** | extracted from a production system (the JC360 US market-entry CRM); what stayed behind and why is in §9 |

This document is the contract all implementations of the crm area share: **business acts,
invariants, lifecycles, and required read models** — never screens or schemas. Anything two
reasonable implementations might do differently is marked **freedom**. Scenario files under
`scenarios/` are the executable part.

---

## 1. Calibration: who this is for

An operator or small team pursuing **tens of accounts they can name**, where each account was
researched into the list and relationships decide outcomes: market entries, agency work,
enterprise sales with a defined territory, partner development. The unit of value is not
volume — it is *what you verifiably know* about a small number of companies and people.

The reference points:

- **Above toy**: researched account narratives with sources, contacts with mandatory
  provenance, unfilled roles tracked as first-class findings, an activity log that records
  when things happened (not when they were typed), a weighted pipeline, and a bridge into
  order-to-cash when pursuit becomes trade.
- **Below Salesforce**: no mass lead capture, no scoring engine, no email sequences, no
  marketing automation, no territories/forecasting hierarchies. A funnel CRM optimizes
  throughput of strangers; this area optimizes *honesty about a short list*.

## 2. Scope

**In scope (contract):** accounts (curated, narrative-bearing) → contacts (named-with-source
or gap) → activities → pipeline → promotion to a trading customer.

**Deferred** (§9): introductions-with-evidence, blocker/delay logs, ingestion (email/calendar),
scoring, dedup/merge, multi-pipeline.

**Rejected — permanent non-goals:**
- **Outbound side effects.** The area records reality; it never sends an email or touches
  LinkedIn. (One consequence is elevated to an invariant: CRM-4.)
- **Data enrichment by inference.** No auto-filled titles, guessed emails, or scraped
  org charts. Facts arrive with sources or arrive as gaps.

## 3. Entities and lifecycles

| Entity | Lifecycle |
|---|---|
| campaign | `active → paused` (re-enterable) `→ concluded` (terminal, reasoned). A campaign is a **goal**: the thesis every account's why_them argues against, and the standing brief an agent reads before filling the list |
| account | a pursuit **within one campaign**: `not_started → researching → approaching → active → won` — or parked `on_hold` (re-enterable), or terminal `closed` (pursued and lost/passed) / `excluded` (deliberately never pursued). Account names are unique per campaign |
| contact | `gap → named` (via resolve_gap only) — a named contact may become `departed`; never deleted |
| activity | immutable once recorded (a fact, not a workflow object) |
| stage reference | data, not code: each pipeline stage carries a label and a probability (freedom to define the set) |

`won` is the handoff moment: a won account may be **promoted** exactly once, creating (or
linking) a `core` customer through the owning module's API. Pursuit ends where trading begins.

## 4. The acts

Acts are named abstractly; an implementation exposes each as a command under its own prefix
and publishes an act → command map. Required arguments are contract. Refusals name what is
missing, in one sentence, on every surface.

### 4.0 Campaigns

**`create_campaign`** (name, goal, target_profile?)
The goal is **required** (CRM-13): a campaign without a stated thesis is a folder, not a
pursuit. The goal is the brief — a research session reads it before adding accounts, and every
why_them argues against it. *Freedom:* extra planning fields.

**`update_campaign`** (campaign, patch) — the goal can be sharpened, never blanked.

**`set_campaign_status`** (campaign, status, reason?)
`paused` and `concluded` require a reason. Concluded is terminal: its accounts remain fully
readable (CRM-6), but it takes no new targets.

### 4.1 Accounts

**`add_account`** (campaign, name, why_them, source_url, tier?, vertical?, trigger_event?, hook?)
The gate to the list. `campaign` is required (CRM-12) and `why_them` must argue **that
campaign's** goal; `source_url` grounds it — an account that cannot say why it belongs to this
pursuit, with a source, is not a target yet (CRM-3). Refused into concluded campaigns.
*Freedom:* tier semantics, vertical taxonomy, additional research fields.

**`update_account`** (account, patch) — corrects or deepens the narrative. Provenance fields
may be corrected, never blanked (CRM-9).

**`set_account_status`** (account, status, reason?)
Lifecycle moves, guarded per §3. `on_hold`, `closed`, and `excluded` **require a reason** —
parking or killing a researched account is a decision someone later asks about (CRM-7).

**`set_path_in`** (account, bullets[]) — the ordered "how we get in" plan, replaced whole.

### 4.2 Contacts

**`add_contact`** (account, role_type, — then one of two shapes)
- **named**: `name` + `source` required; `title`, `confidence_note` recommended. A name
  without a source is refused (CRM-1).
- **gap**: no name, `gap_note` required. The role exists, its holder is not publicly known —
  that absence is recorded as a finding (CRM-2).

**`resolve_gap`** (contact, name, source, title?, confidence_note?)
The only way a gap becomes named — and it demands the same provenance as a fresh named
contact. Refused without a source.

**`update_contact`** (contact, patch)
Corrections, `departed` marking, notes. The relationship-graph fields — `mutual_via`,
`mutual_url`, `linkedin_path` — are **human-only** (CRM-4): an agent's write touching them is
refused regardless of the member's role, with a sentence saying why.

### 4.3 Activity

**`log_activity`** (account, summary, occurred_at, contact?, direction?, medium?)
`occurred_at` is when it happened, which is not when it was typed (CRM-5). Interpretation and
summary are free prose; facts inside them follow CRM-10.

### 4.4 The bridge

**`promote_to_customer`** (account, terms?, credit_limit?)
Allowed only for `won` accounts, at most once (CRM-8). Creates the `core` customer through
core's exported API — a logged act marking where this area's job ends and o2c's begins — and
links it on the account. *Freedom:* carrying contacts across.

### 4.5 Drafting, without a way to send

**`draft_message`** (contact, body, rationale, subject?, channel?)
Writes a message to a named, live contact and holds it. **Nothing is sent** (CRM-14): this
area has no outbound channel and the absence is deliberate, not a missing feature. A person
reads the draft, edits it, sends it from their own mailbox and says so.

The `rationale` is mandatory and is never part of what goes out (CRM-16). It is the note to
the reviewer: which hook the angle rests on, why this contact rather than another at the same
account, what the writer was unsure about. A draft nobody can check is a draft nobody should
send.

Refused for a gap row (there is no name to write to), for a departed contact, and for an
account that is parked. Refused when the text contains a placeholder, or any phrase on the
campaign's refused list (CRM-17).

**`update_draft`** (draft, body?, subject?, rationale?)
Rewrites a draft that is still a draft. Refused on a sent draft, because its words are the
record of what reached a real person (CRM-15), and refused on a discarded one, because a
person rejected it and reviving it would overturn that decision quietly. The same claim gate
applies: an edit cannot smuggle in what the first write would have stopped.

**`draft_outcome`** (draft, outcome, sent_at?, reason?)
Records what the person did. `sent` copies the draft's exact text onto the activity trail as
the record of what actually reached somebody, makes the draft immutable, and moves an account
still at `not_started` or `researching` to `approaching` — it has now been approached, which
is a fact rather than a forecast. `discarded` needs a reason, because the next draft has
nothing else to go on. *Freedom:* whether a send may be recorded by an agent on the person's
word, or only by the person.

### 4.6 What a campaign may say

Claim lists live on the campaign and are **human-only** (CRM-17), for the same reason as
CRM-4: an agent choosing which claims it is allowed to make is the check marking its own
homework. `claims_allowed` is what this business has decided it may assert about itself;
`claims_refused` is the phrases no draft may contain, checked at write time on creation and
on edit alike.

The gate is honest about its limit: it catches a forbidden phrase, and it cannot catch an
overstatement of a claim that is itself allowed. A campaign with no lists refuses nothing,
and that is the correct default. A built-in list of somebody else's sensitivities would be a
safety theatre, not a safety feature.

### 4.7 Parking

Parking is recorded through `update_account` and is **not** a status move (CRM-18). `status`
is a judgement about where a pursuit sits; parking is a fact about what happened to it: both
intake routes dead, the sponsor left, a reorganisation in flight. An account parked at
`researching` is still at `researching` and says why nobody is spending time on it. The reason
is mandatory and is read by whoever considers reopening; parking is reversible and drafting
against a parked account is refused.

### Act count

13 write acts + 6 read models — inside the 25-tool budget. Bulk arrival of unresearched rows
is a different area with a different doctrine; see `specs/prospect/spec.md`, which promotes
into this one through the owner's API the way this area promotes into `core`.

## 5. Invariants

Namespaced `CRM-n` (areas own their invariant namespaces; o2c's unprefixed `INV-n` is legacy).

1. **CRM-1 Never invent a person.** A named contact requires a source and carries a
   confidence note. Facts — names, titles, dates, URLs — come only from sources. Empty beats
   guessed; guessing is the only real failure here.
2. **CRM-2 A gap is a finding.** A role with no publicly named holder is recorded as a gap
   row with a gap note, appears in the gap worklist, and becomes named only through
   `resolve_gap` with full provenance.
3. **CRM-3 Every account earned its place.** No account without `why_them` and a
   `source_url`. This is a curated list, not a funnel.
4. **CRM-4 Some fields are human-only.** Relationship-graph fields are written by people,
   never by agents — whatever the member's role — because automating them risks the human
   relationships (and accounts, in both senses) this work depends on. The refusal says so in
   one sentence.
5. **CRM-5 Activities record when it happened**, not when it was typed.
6. **CRM-6 Nothing is deleted.** Exclusion and closure are reasoned statuses; departed
   contacts and their history remain.
7. **CRM-7 Parking or killing requires a reason.** `on_hold`, `closed`, `excluded` carry
   prose that will be read back.
8. **CRM-8 Promotion is a bridge act.** `won` → core customer, through the owner's API,
   logged, at most once per account.
9. **CRM-9 Provenance survives updates.** Sources and confidence may be corrected, never
   removed.
10. **CRM-10 Interpretation is free, facts are sourced.** Narrative fields may summarize and
    judge; factual claims inside them trace to sources or are marked as unknown.
12. **CRM-12 Every account pursues a campaign.** Pursuit state — why_them, tier, status,
    path-in — is campaign-relative; the same company may be a target of two campaigns as two
    accounts. (The org/pursuit normalization this implies is deferred: §9.)
13. **CRM-13 No campaign without a goal.** The goal is data, not a chat prompt: it is the
    brief an agent reads before filling the list, and the thesis every why_them argues.
14. **CRM-14 There is no outbound channel.** A draft is written and held. Only a person
    sends, from their own mailbox, and then records that it went. No implementation of this
    area may send a message, and an implementation that does is not this area.
15. **CRM-15 A sent draft is immutable.** Its exact words are copied onto the activity trail
    as the record of what reached a real person, and that record is not rewritten. A
    discarded draft is never revived: a person rejected it, and reversing that silently is
    worse than writing a new one.
16. **CRM-16 Every draft carries a rationale for its reviewer**, and the rationale is never
    part of what is sent.
17. **CRM-17 Claims are a person's to make.** What a campaign may assert about itself, and
    what no draft may say, are written by people and refused to agents whatever their role.
    The refused list is checked on creation and on edit alike.
18. **CRM-18 Parking is orthogonal to status.** It is a fact about what happened, carries a
    mandatory reason, is reversible, and does not move the pursuit.
19. **CRM-19 State is derived, never stored.** Last touch, who has been written to, and what
    is waiting are computed on read and come back with the account. A stored summary drifts,
    and the drift has a shape: an account reported as an untouched door days after somebody
    wrote to it.

11. **CRM-11 Platform inheritance.** Every write is a logged command with an actor; refusals
    (including CRM-4 and CRM-17 denials) are logged; reads are never logged.

## 6. Required read models

| Read model | Must answer |
|---|---|
| `account` | full narrative (why/trigger/hook/sources), path-in bullets, contacts *including gaps*, recent activity, available next actions with refusal reasons |
| `contact` | identity, provenance (source + confidence), gap state, activity touching them |
| `pipeline` | accounts by status and tier with stage probabilities — the weighted "where are we" view |
| `gaps` | every unresolved gap: role, account, gap note, age — the "what we verifiably don't know" worklist, first-class |
| `coverage` | list health: accounts by status/tier, gap counts, accounts with no activity in N days — staleness is visible, not discovered |
| `campaigns` | every campaign with its goal, status, and health (accounts by status, open gaps, staleness) — the per-goal Today |

`pipeline`, `gaps`, `coverage` and the account list must answer **per-campaign and across
campaigns** (an optional campaign filter is contract; its shape is freedom).

## 7. Contract vs freedom — summary

| Contract | Freedom |
|---|---|
| the 9 acts, required args, refusal semantics | extension commands, extra optional args |
| lifecycles in §3, all 11 invariants | schema, id formats, tier/vertical taxonomies |
| read model content (§6) | shapes, pagination, extra views |
| provenance mandatory; gaps first-class | which fields beyond the graph set are human-only |
| stage probabilities from reference data | the stage set itself |
| promotion via core's API, once | carrying contacts/notes across on promotion |
| buyer/persona doctrine | — it lives in **workspace content** (seeded guidance, account notes), not module code |

## 8. Conformance

As for o2c: an act → command map covering §4, every scenario under `scenarios/` passing
(steps name acts; refusals are contract), and the mechanically checkable invariants asserted
by the platform gates. One note specific to this area: the conformance runner executes as an
agent, so CRM-4 scenarios assert the *refusal* side; the human-path acceptance is asserted by
a gate test, not a scenario.

## 9. Deferred — with reasons (the extraction record)

This spec was extracted from a production single-tenant CRM built for a specific agency
agreement. These stayed behind:

| Item | Why deferred, not lost |
|---|---|
| **Introductions with mandatory evidence** | The source system's `introduction` table made commission conditional on documented evidence — NOT NULL constraints that were literally sentences of §V of an agency agreement. Generalizable someday as "milestone with mandatory evidence," but shipping contract law as a default CRM concept helps nobody. |
| **Blocker / delay log** | Encoded §3 of the same agreement (principal-attributable delays extending the term). A generic "blocked, on whom, since when" may return; the contractual accrual math stays bespoke. |
| **Agreement fields** (`agreed_with_principal_at`, tier-1-only hooks) | Deployment policy, not area semantics — in Saybooks terms, workspace content. |
| **Org / pursuit normalization** | The fully normalized model splits *company* (org facts, people, the human-entered network) from *pursuit* (campaign membership), so one company in two campaigns shares its contacts. Deferred until a company actually appears in two campaigns: today the cost of overlap is a duplicated account row with duplicated contacts — annoying, visible, fixable then. This line exists so the fault line is on record as seen, not missed. |
| **Email/calendar ingestion** | Integration territory; the area records, it does not watch. |
| **Lead scoring, dedup/merge, multi-pipeline** | Funnel-CRM machinery; against this area's calibration until real demand says otherwise. |

---

*Change log: 0.2-draft amended (2026-08-24) — contacts gain optional `email` and `phone` on
add_contact / resolve_gap / update_contact: in many industries reach details are plainly
listed, and recording them is a sourced fact like a LinkedIn URL (CRM-1 covers the where-from;
nothing changes about CRM-4 — the relationship-graph fields stay human-only). ·
0.2-draft (2026-08-23) — campaigns become first-class (CRM-12, CRM-13): the 0.1
extraction had erased the campaign by promoting it to "the whole deployment"; a second
research fill made it visible again. Acts +3, read models +1, org/pursuit split explicitly
deferred. · 0.1-draft (2026-08-22) — initial curation, extracted from the JC360 US CRM.
New platform mechanism motivated by this area: field-level human-only enforcement (CRM-4).*
