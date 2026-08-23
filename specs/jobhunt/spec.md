# jobhunt — One Person's Search · Area Specification

| | |
|---|---|
| **Version** | 0.1-draft |
| **Status** | curated draft |
| **Curator** | Peter Varga |
| **Calibration** | one person's professional job search, run seriously — not a recruiting platform |
| **Provenance** | extracted from a production system (huntctrl, an MCP-first job-hunt CRM seeded with a real pipeline); §9 records what stayed behind |

The contract all implementations share: acts, invariants, lifecycles, read models. This is a
**personal** area — the subject is one hunter — and deliberately so: Saybooks areas are not
limited to corporate functions.

---

## 1. Calibration: who this is for

A person running a real search: tens of postings in flight, several agencies presenting the
same requisitions, interviews in rounds, recruiters who ghost, and a resume that exists in
versions. The stakes of record-keeping are personal and sharp: **a double submission to the
same requisition through two agencies can disqualify the candidate.** The system is a record
of reality, not a workspace for guesses.

- **Above toy**: a duplicate guard keyed on the *end client* behind agency postings; exactly
  one application per posting; one open next action per posting with supersede history;
  interview rounds with outcomes; resume versions tied to what was actually sent; ghosting as
  an honest status; a due list that surfaces follow-ups, staleness, and missing end clients.
- **Below a recruiting platform**: one hunter, no employer features, no outreach automation,
  no scraping, and — as everywhere in Saybooks — no outbound anything.

## 2. Scope

**In scope:** companies (kind matters: agency vs end client) → contacts (sourced) → postings
(lead → evaluated → applied | skipped) → applications (one per posting, through terminal
states including ghosted) → interviews (rounds) → interactions (touches + the next-action
discipline) → resume versions → the due list.

**Deferred** (§9): outreach drafting, ingestion/scraping, offer modeling, multi-hunter.
**Rejected:** sending anything, submitting anything, clicking anything. Follow-up output is a
suggestion, always.

## 3. Entities and lifecycles

| Entity | Lifecycle |
|---|---|
| company | no lifecycle; `kind` (end_client / consultancy / staffing_agency / product_vendor / rpo) is load-bearing — the dedup guard and the missing-end-client check depend on it |
| contact | relationship `cold → contacted → responsive → warm_scout` or `dead`; source mandatory, never cleared |
| posting | `lead → evaluated → applied` — or `skipped` (reasoned, kept as pattern memory) |
| application | **exactly one per posting**: `submitted → screening → interviewing → offer → accepted` — or `rejected / withdrawn / ghosted` (all terminal, all honest) |
| interview | rounds under an application; `pending → passed / failed / rescheduled / no_show_theirs` |
| interaction | immutable touch; may carry the posting's **next action** — at most one open per posting; a new one supersedes the old, history kept |
| resume_version | registry; applications reference the version actually sent |

## 4. The acts

12 writes, 6 reads. Acts are named abstractly; implementations publish an act → command map.

### 4.1 Intake

**`add_posting`** (title, company, end_client?, req_id?, url?, jd_text?, comp?, …)
Records a JD encountered. Companies are created implicitly by name. **Runs the duplicate
guard and returns its warnings in the result** — surfacing them is contract (JH-3); resolving
them is a person's job, never the system's. *Freedom:* guard sensitivity (reference data).

**`update_posting`** (posting, patch) — corrections; comp stays annualized with caveats in
prose (JH-11).

**`evaluate_posting`** (posting, fit_score?, fit_notes?, resume_version?, red_flags?,
skip_reason?) — moves to `evaluated`, or to `skipped` when a skip_reason is given; a skip
without a reason is refused (JH-8).

**`check_duplicates`** (title, company?, end_client?, req_id?, url?) — the guard as a pure
read: check before adding, record nothing.

### 4.2 Applying and progressing

**`apply`** (posting, resume_version?, channel?, via_contact?, applied_at?)
One per posting (JH-4). `applied_at` accepts the literal `unknown` when the submission is
real but the date was never recorded — a guessed date is worse than an honest unknown (JH-1).
Records which resume version actually went out (JH-10).

**`set_application_status`** (application, status, note?) — moves along the pipeline, logs a
touch. `ghosted` is a status, not a deletion (JH-9).

**`add_interview`** (application, kind?, round?, scheduled_at?, interviewer?) — a round;
moves the application to `interviewing`.

**`interview_outcome`** (interview, outcome, notes?) — closes the round, logs a touch (JH-12).

### 4.3 Touches and the next-action discipline

**`log_interaction`** (direction, summary, posting?, contact?, medium?, at?, next_action?,
next_action_due?)
The workhorse. A `next_action` supersedes the posting's previous open one — history kept
(JH-6). Direction `in`/`out` matters: follow-up nudges key on real outbound touches.

**`complete_next_action`** (posting or interaction, note?, direction?, medium?)
Closes the open next action; with direction/medium it counts as a real touch, without them
it is an internal note that triggers no nudge.

### 4.4 People and artifacts

**`add_contact`** (name, source, company?, role?, …) — a source is mandatory: how we know
this person (JH-2). **`update_contact`** — source never cleared.

**`add_resume_version`** (label, platform?, headline?, focus?, …) — the registry entry
applications point at.

### 4.5 Read models

| Read model | Must answer |
|---|---|
| `due` | the daily view: overdue and upcoming next actions, follow-up nudges (outbound silence beyond cadence), stale items, suggest-ghosted, agency postings **missing an end client**, upcoming interviews |
| `pipeline` | the board: every non-terminal item with stage, last activity, open next action, flags |
| `posting` | one posting whole: JD facts, evaluation, its application, interviews, interaction history, open next action |
| `contacts` | people with relationship and last touch |
| `resume_versions` | versions with how many applications each went out on |
| `check_duplicates` | see 4.1 — the guard as a read |

Thresholds behind `due` (cadence, staleness, ghost horizon, guard sensitivity) are
**reference data**, not code (JH-13).

## 5. Invariants

1. **JH-1 Record of reality.** Facts — names, comp, req ids, dates — come only from the JD
   or actual correspondence. Interpretation is free in fit notes and summaries. A date never
   recorded is `unknown`, not a guess.
2. **JH-2 Every contact has a source.**
3. **JH-3 Duplicate warnings are surfaced, never auto-resolved.** The same req arriving
   through four agencies is normal; a silent merge or drop invites the double submission
   that can disqualify the candidate. The guard warns; a person decides.
4. **JH-4 One application per posting.**
5. **JH-5 The end client is first-class.** An agency posting records who the work is for;
   the guard keys on it; a missing end client is visible work on the due list.
6. **JH-6 One open next action per posting.** A new one supersedes the old; the history of
   superseded intentions is kept.
7. **JH-7 Suggestions, never actions.** The area never sends, submits, or clicks. Follow-up
   output is advice.
8. **JH-8 Skips are pattern memory.** Skipping requires a reason; skipped postings stay
   queryable.
9. **JH-9 Ghosted is a status**, not a deletion — silence is an outcome worth recording.
10. **JH-10 What was sent is recorded.** Applications point at the resume version actually
    submitted.
11. **JH-11 Comp is annualized** (USD), with its caveats in prose — "hourly $85 ×2080" is a
    note, not a hidden formula.
12. **JH-12 Interview rounds close with outcomes**, and outcomes are touches.
13. **JH-13 Thresholds are reference data** — cadence, staleness, ghost horizon, guard
    sensitivity live in config, not code.
14. **JH-14 Platform inheritance.** Every write logged with an actor; refusals kept; reads
    unlogged.

## 6. Contract vs freedom

| Contract | Freedom |
|---|---|
| the 12 acts + 6 reads, required args, refusal semantics | extension commands (config, export…) |
| lifecycles §3, invariants §5 | schema, id formats, guard algorithm details |
| the guard runs on add and its warnings reach the caller | guard sensitivity, similarity measures |
| due-list content (§4.5) | shapes, extra views, FTS |

## 7. Conformance

As for other areas: act map, scenarios under `scenarios/` (refusals are contract),
mechanically checkable invariants via the platform gates.

## 9. Deferred — the extraction record

| Item | Why |
|---|---|
| **Outreach drafting / templates** | The area never sends (JH-7); drafting belongs to the session, not the record. |
| **Ingestion / scraping** | Facts arrive through the hunter or their agent reading real sources — automation of intake is a different product with different failure modes. |
| **Offer & comp negotiation modeling** | Real, but its own design pass; comp fields carry facts today, not strategy. |
| **Multi-hunter** | The area's subject is one person; a household or cohort version changes identity, privacy, and every read model. Left until it is real. |
| **huntctrl's markdown export** | Extension, not contract — sessions read the record over MCP now. |

---

*Change log: 0.1-draft (2026-08-23) — extracted from huntctrl (schema, tools, doctrine, and a
real pipeline's working practice). The duplicate-guard-as-surfaced-warning (JH-3) and the
single-open-next-action discipline (JH-6) are the area's distinctive contributions.*
