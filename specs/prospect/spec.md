# Prospect staging

A holding area in front of a curated list.

## 1. What this area is for

A curated target list is worth something because every row on it earned its place. The moment
rows can arrive in bulk, that is no longer true, and the list quietly becomes a funnel with
better manners.

This area exists so that bulk arrivals have somewhere to live that is not the list. Rows come
in from a pull somebody bought or scraped. They are read, judged, and mostly thrown away. The
few that survive are promoted into the curated list by a person, one decision at a time, and
arrive there carrying the reason they survived.

A staged row is not an account. It appears in no pipeline, no coverage report and no campaign.
Nothing counts it. That is the point: a number that includes unjudged bought rows is a number
about the seller's database, not about the business.

## 2. The two halves, and the door between them

Staging and judging are cheap and reversible, so an agent does them. Reading three hundred
company descriptions against a stated brief is exactly the work an agent is good at, and
getting one wrong costs a re-read.

Promotion is not reversible in the same way. It puts a row into the asset. So a person does
it, and the act is refused to agents whatever their role (PRO-5). This is not a permission
that was set cautiously and could be relaxed later. An agent that can fill the curated list
from a bought list has removed the only thing that made the list worth curating.

## 3. Criteria, and why they are mandatory

Every pull records the brief it was actually made under: the size band, the geography, the
industries asked for (PRO-2). A verdict is a judgement against a stated brief. Without one,
the rows are being judged against somebody's memory of what they asked the seller for, and
nobody can check the judgement afterwards, including the person who made it.

The cost of getting this wrong is specific and was paid in the system this area was extracted
from: one pull went in before criteria were required, and fifty-four rows were judged against
a brief that existed only in a conversation.

## 4. The reason is the product

A verdict without a reason is a row that vanished. The reason is read twice: by a person
deciding whether to overrule it now, and by somebody months later asking why this company was
dropped. It is refused if it is too short to do either job (PRO-3).

"unclear" is a first-class verdict and a better answer than a confident guess. A row that does
not say what the brief needs to know is a finding about the pull, not a failure of judgement.
Rejections are the invisible half of this work: nobody ever audits the companies that were
dropped, which is exactly why the reason has to stand on its own.

## 5. Acts

| Act | Kind | What it does |
|---|---|---|
| `import_rows` | write | Stage one pull: its brief, its rows, its hash |
| `qualify` | write | Record verdicts on staged rows, one or many, reason mandatory |
| `promote` | write | Turn qualified rows into accounts. A person only |
| `discard_pull` | write | Throw out a pull and its unpromoted rows, with a reason |
| `rows` | read | A page of staged rows with an honest total |
| `pulls` | read | The pulls, with the brief each was made under and how far judged |

## 6. Invariants

| Id | Invariant |
|---|---|
| PRO-1 | The same pull never lands twice: a repeated hash is refused, naming the pull that holds it. |
| PRO-2 | Every pull records the brief it was made under, and it is mandatory at the door. |
| PRO-3 | A verdict carries a reason a person can overrule, or it is refused. |
| PRO-4 | An unjudged row is a distinct state from any verdict, and is queryable as such. |
| PRO-5 | Only a person promotes. The act is refused to agents whatever their role. |
| PRO-6 | A promoted row records what it became; a promoted row is never re-judged or re-promoted. |
| PRO-7 | A staged row is counted in no pipeline, coverage or campaign statistic. |
| PRO-8 | Rows are never edited: a wrong pull is discarded and staged again from a fresh read. |
| PRO-9 | A discard keeps rows that already became accounts, so those accounts keep their provenance. |
| PRO-10 | A promoted account is held to the curated list's own gate: why_them and source_url, from the verdict. |
| PRO-11 | Every write is a logged act with an actor; refusals are logged; reads are not. |

## 7. Deliberately out of scope

No parser. The agent reads the file and hands over rows, as everywhere else in this system.

No scoring. A number between 0 and 1 attached to a company is a reason nobody can argue with,
which is the opposite of what section 4 is for.

No automatic promotion, at any threshold, for any verdict, under any setting. See section 2.

No enrichment vendor. Buying a fact about a person from an API is a different act with
different consent questions, and it does not belong behind a qualification verb.

## 8. Extraction record

Extracted from a production single-tenant CRM built for one operator's US market entry, where
the staging area was added after a bought list of one metro turned out to be 303 companies of
which roughly 38 matched the brief. The original enforced the same split between judging and
promoting, and the same mandatory reason. What is generalised here is the split itself: the
original's size bands, industry rules and vendor integration are that business's, not this
area's.
