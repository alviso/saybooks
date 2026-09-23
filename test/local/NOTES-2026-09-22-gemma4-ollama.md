# Gemma 4 26B A4B QAT through Ollama, 2026-09-22

What was tried, in the evening after Peter left, toward "the optimal setup" for a local model driving
the saybooks tools. Machine: M5, 32 GB. Runtime: Ollama 0.21.1, `gemma4:26b` (Q4_K_M, 20 GB resident
at 32k context). Instrument: `test/local/harness.mjs`, extended tonight with `--api ollama`,
`--think on|off`, `--max-tokens N`, `--repair`, `--tag`. Reports are next to this file.

## Results

```
script           instr  api     think  repair  tag         pass  min   refus  failed steps
statement        on     openai  -      off                 0/4   37.6  5      1:nothing imported | 2:proposed categories without ever readi | 3:request failed: fetch failed | 4:answered without reading the books
statement        off    openai  -      off                 0/4   18.4  0      1:request failed: fetch failed | 2:proposed categories without ever readi | 3:request failed: fetch failed | 4:request failed: fetch failed
statement        on     ollama  off    off     r1          1/4   17.8  7      1:nothing imported | 2:proposed categories without ever readi | 3:request failed: Cannot read properties
statement        off    ollama  off    off     r1          4/4   7     1      
statement        on     ollama  on     off     r1          4/4   14.1  2      
statement        on     ollama  off    off     r2          1/4   23.1  9      1:nothing imported | 2:proposed categories without ever readi | 3:only 0 recurring, expected Adobe, Zoom
statement        off    ollama  off    off     r2          2/4   6.5   1      2:proposed categories without ever readi | 3:transfer category is "Transfer (Credit
invoicing        on     ollama  off    off     r1          5/6   2.9   10     5:invoice open 300000: payment recorded 
invoicing        off    ollama  off    off     r1          5/6   2.7   10     5:invoice open 300000: payment recorded 
receipt          on     ollama  off    off     r1          2/3   11.8  4      1:statement did not land whole
statement        on     ollama  off    on      r3          1/4   31.8  7      1:nothing imported | 2:proposed categories without ever readi | 3:20 rows still unreviewed
statement        on     ollama  off    off     r4-wording  3/4   8.2   1      3:transfer category is "card payoff", no
statement        off    ollama  off    off     r3-wording  4/4   6     1      
statement        on     ollama  on     on      r2-wording  3/4   18.9  5      3:transfer category is "card payoff", no
statement        on     ollama  on     on      r3-wording  1/4   24.1  4      1:nothing imported | 2:proposed categories without ever readi | 4:request failed: Ollama 500: {"error":"
statement        on     ollama  off    on      r5-text     3/4   4.3   3      3:transfer category is "null", not the c
statement        off    ollama  on     on      r4-text     2/4   4.9   1      2:proposed categories without ever readi | 3:transfer category is "credit card payo
statement        on     ollama  on     on      r6-text     4/4   5.9   0      
statement        on     ollama  on     on      r7-text     3/4   6.3   0      3:transfer category is "card payoff", no
```

min = wall-clock for the whole script. refus = refusals on the audit trail. The first two rows went
through Ollama's OpenAI door with the old harness and mostly measure the instrument, not the model
(see below). "wording" tags ran after the ROW field text in `purchases/commands/import.js` changed.

## Instrument fixes that had to happen before any number meant anything

- Node's `fetch` gives up on headers after 5 minutes; a 26B model on a 17k-token prompt takes longer
  than that on one hop. Every "request failed: fetch failed" in the first rows is that. The harness
  now uses `node:http` with a 30-minute ceiling.
- `max_tokens: 4000` is too small for a 20-row import once thinking is on. Ollama's Gemma 4 parser
  then logs "tool call flush on done failed ... repair failed" and the call is silently dropped: a
  large write becomes no write. Budget is 8000 now, and a dropped call is a host failure to surface.
- Ollama's `/v1/chat/completions` cannot switch thinking off for Gemma 4 (ollama/ollama#15288).
  The native `/api/chat` can (`think: false`), and its parser bug with system prompt + tools
  (ollama/ollama#15539) is gone in 0.21.1. The harness talks native now.
- The scratch books were blank, so a model that follows the doctrine and calls `core_setup_status`
  first was handed the first onboarding question, which no script can answer. The scratch books now
  start with a company profile; a script about onboarding says `books: 'blank'`.

## What actually goes wrong, in order of cost

1. **Re-typing 20 rows.** The statement step makes the model echo every row as tool arguments
   (~1.8k tokens). Each full re-emission has a real chance of one corrupted value: a non-ISO date,
   a wrong year (2006, 2020), a fullwidth dot in `20．09-23`. The import is atomic, so one bad row
   costs a full re-type, which brings the next typo. This is where most of the minutes and most of
   the refusals went. Candidates: parse pasted text server-side; a staged import that takes rows in
   chunks and keeps the good ones; or the host handing the file over by reference.
2. **`counterparty` instead of `description`.** With the doctrine in the system prompt and thinking
   off, the model used `counterparty` for the printed line and left `description` out, 3 runs of 3;
   with instructions off, 0 of 2. Before tonight the refusal was the database's own
   `NOT NULL constraint failed: purch_transaction.description`, and the model answered it by putting
   `description` at the top level. The registry now validates line items itself:
   `rows[1] has no description. Each row takes: date, amount, description, counterparty, row_index,
   raw (date, amount, description required).` Then the field text changed from "Exactly as printed."
   to "The line as the statement prints it (the merchant or payee text). Every row has one." and the
   same setup imported on the first attempt with zero refusals, twice.
3. **Verbatim retry after a refusal** (thinking off). The model resends the refused call, changed in
   some trivial way, still without the named field. A short-context probe shows it *can* read and act
   on the refusal; in a 14k-token context dominated by its own previous call it repeats instead.
   `--repair` rule: when a refusal names a missing field and the retry of the same tool still has no
   key by that name anywhere, the host does not execute it and says so. Fired once, and the next call
   had `description` on every row. The plain exact-match rule never fired, because something small
   always changes.
4. **Read loops** (thinking off): `solo_get_document` seven times in a row until the hop cap, after
   issuing an invoice. The exact-match `--repair` rule is for this; it has not yet run on invoicing.
5. **Doctrine steps.** "Read the vocabulary before proposing" passed with instructions on every time
   the import landed, and with instructions off only sometimes (1 of 2 before the wording fix). The
   doctrine helps exactly where judgment is needed and hurts on the bulk-echo step by making the
   prompt longer; a host that hands over doctrine per step rather than all up front would get both.

## Two places where the check and the tool text disagree (Peter's call)

- `solo_record_payment` says "Never guess which invoice a payment is for ... Ask, or leave it
  unapplied." The model does exactly that and `plain-invoicing` step 5 expects the $1,500 applied to
  the customer's only open invoice. Both invoicing runs stop at 5/6 on this alone.
- `purch_review_batch` says a transfer's category is "where the money went or came from (checking,
  savings, the card being paid)". The person said "from checking", the model wrote "card payoff",
  and the check demands /check/. Three runs failed step 3 on this and nothing else.

## Other things worth knowing

- Refusing unknown fields inside line items is new tonight (the registry already refused unknown
  top-level arguments). With thinking on the model invents row fields (`pattern`, `token`) and now
  gets refused for them; before, they were silently dropped. It cut both ways: the last run of the
  night was refused for `rowintdex` (a corrupted `row_index` on row 19), which the old lenient
  handler would have ignored and imported. Consistent, but it costs a small model calls and
  sometimes a whole step. Easy to relax to "ignore and mention" if that is preferred.
- Ollama's Gemma 4 tool-call parser gave up four times tonight (`tool call flush on done failed`,
  `tool call parsing failed: invalid character '-' after object key:value pair`). Each time the call
  vanished: the model's turn came back as plain text or nothing, the harness nudged, and the step
  ended with no write. A host has to treat "the model emitted a tool call the parser dropped" as a
  visible failure, not as a quiet turn. With thinking on, that alone cost the final run its step 1.
- Speed on the M5: prompt eval ~200 tok/s from cold; a 17k-token prompt costs 90–105 s whenever the
  prefix cache misses, which it does after thinking turns. Generation 19–35 tok/s depending on
  context length. Thinking roughly doubles a script's wall-clock (14–19 min vs 6–8).
- LM Studio's MLX 4-bit copy of the same model was not measured tonight; Ollama held the GPU.

## Second round, after the plan: fix the bulk step instead of coaxing it

Three changes, each in its own place:

- **Server:** `purch_import_statement` takes `text` as an alternative to `rows`: the statement's
  lines as pasted, read here (date first, amount last; CSV with quotes, tabs or wide spaces;
  `-$89.12`, `(95.00)`, `$1,800.00` unquoted; US and day-first dates). A line that starts with a
  date and cannot be read is refused by line number. Control totals still gate the batch, so the
  model still reads the statement; it just stops retyping it.
- **Host:** attachments by reference. A step can carry `attach: { name, text }`; the model sees
  the contents and is told it can pass `"@name"` as any argument, and the host substitutes the
  bytes before the tool runs. Gemma used it unprompted on the first try: one call, 51 s, no rows
  retyped.
- **Host:** `--think auto`: thinking off on a step that hands over a file, on for every other step.

The `text` and `auto` tags in the table are these. The same setup that was 1/4 in 13 to 32
minutes three times (instructions on, thinking off) went 3/4 in 4.3 minutes with the text path,
and with thinking on for the judgment steps: **4/4 in 6 minutes with zero refusals** on the
audit trail, which was the Phase 1 target. Instructions off with the text path went 2/4, both
misses doctrine points (vocabulary first; the transfer's other side), which is the case for
forwarding instructions in one line.

What the review step showed with thinking off is the same slip in miniature: 20 rows of
`{transaction_id, status, category, vendor}` lose a field per re-emission. Thinking on fixed it
here; a compact text form for `purch_review_batch` would be the server-side equivalent of the
import fix if it ever needs to be cheaper.

## Setup recommendation as of tonight

Native Ollama API, 32k context, `--parallel 1`, 8000-token budget, `--think auto` (off on a file
step, on otherwise), server instructions forwarded, both repair rules on, files handed over by
reference and read server-side. That is 4/4 and 3/4 in 6 minutes with zero refusals on the trail
(the `r6-text` and `r7-text` rows); the one miss is the "card payoff" check, which is a decision,
not a slip. Before the text path, the best was instructions off + thinking off
at 4/4 in 6 minutes without doctrine, or instructions on + thinking on at 3/4 in 19 minutes.

For the record: the `r3-wording` thinking-on run lost step 1 to a corrupted key plus a
parser-dropped call, and its step 4 "Ollama 500" is not a crash; Peter killed the runner at 20:17
while that last hop was running, so that cell is void.
