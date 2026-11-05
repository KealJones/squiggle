# Failure casebook

Real bad answers, from real chats, with why each one is a bad choice and what changed because of it. Add an
entry whenever a fix comes from something a model did: what it was asked, what it did (the evidence: the chat in
the storage repo, the tool calls, the model), why that's wrong, what a good answer would have been, the fix, and
the test that now catches it. "Not covered" is an allowed answer for the last one, never a missing one.

**How to use it.** For people and coding agents: read it before changing find, the context modes, or a lookup
tool; most of these are one harness rule away from coming back. For the model: never put these in a prompt (a
0.6B model copies what it's shown, bad examples included), and never fine-tune on the bad answers. Each entry's
bad and good answers are a preference pair (rejected / chosen) for DPO-style training of the next Squiggle Small.

Models are named for what they are; the id in parentheses is Squiggle's (engine.js MODELS).

---

### 1. "Emma Stone's real name is Keal"

- **Asked:** "What is Emma Stone's real name?" (after "Who directed jaws?", answered right)
- **Model:** Qwen3 0.6B on WebLLM (WQ06), Compress context, 2026-11-04. Chat `s0mw2tfw2x000dzjts`.
- **What it did:** called `find("Emma Stone's real name")`. find returned only `Memory: - the user's name is Keal`,
  matched on the word "name". The model answered "Emma Stone's real name is Keal."
- **Why it's bad:** a fact about the user answered a question about someone else. Two mistakes stacked: the
  harness offered an unrelated memory as a match, and the model took whatever came back as the answer without
  checking that it was about Emma Stone at all.
- **Good answer:** "Emily Jean Stone" (Wikidata Q147077, birth name), from a lookup.
- **Fix:** a question that names someone only matches memory facts and past chats that name them too (find.js,
  and Fresh's lookup in agent.js); with nothing of the user's left, find falls through to the web and, for a
  named question, `wiki_lookup` too.
- **Caught by:** tests/find.test.js "a question naming someone only takes memory and chats that name them".

### 2. Poor Things as Emma Stone's latest movie

- **Asked:** "What is Emma stones latest movie?"
- **Model:** Qwen3 0.6B (WQ06), 2026-11-04. Chat `s0mw2kmg3t000u855l`.
- **What it did:** `web_search("Emma Stones latest movie")`; the first result was the Wikipedia page for Poor
  Things (2023). It answered "Poor Things (2023)".
- **Why it's bad:** "latest" is a question about dates, and it answered with the search engine's ranking. A
  2023 page ranking first says nothing about what came out since.
- **Good answer:** Bugonia (2025), with its date, and The Catch (2027) as announced, not out.
- **Fix:** "latest"/"newest" searches get the current year added (web.js `withYear`); `wiki_lookup` lists the
  newest things that link to a person on Wikidata, dated, with "not out yet" past today.
- **Caught by:** tests/failures.test.js case 2; tests/wiki.test.js parseLinks.

### 3. Agreeing with the user instead of checking

- **Asked:** "No it's not. The correct answer is Bugonia in 2025", then "Can you confirm that?"
- **Model:** Qwen3 0.6B (WQ06). Chat `s0mw2kmg3t000u855l`.
- **What it did:** "The correct answer is Bugonia in 2025." three times, with no lookup, including after the user
  pointed out it had just said Poor Things.
- **Why it's bad:** the user happened to be right, but the model would have agreed with anything. A "confirmation"
  with no source is worthless, and a model that folds on pushback can't be trusted when the user is wrong.
- **Good answer:** search, then "Yes: Bugonia premiered in August 2025 (source)", or "I can't confirm that".
- **Fix:** pushback ("no, it's X", "confirm that", "are you sure") searches the claim first and tells the model to
  answer only from the results (agent.js checkClaim; Fresh does it in its lookup).
- **Caught by:** tests/find.test.js PUSHBACK and checkQuery.

### 4. Made-up URLs

- **Asked:** "Can you tell me the page url that confirmed that?", then "Make a plan of how you could confirm…"
- **Model:** Qwen3 0.6B (WQ06). Chat `s0mw2kmg3t000u855l`.
- **What it did:** `fetch_url("https://www.bugonia.com/confirmation")`, then `fetch_url("https://example.com/movies/bugonia/2025")`
  twice. Both were 404s and both were logged as successful reads.
- **Why it's bad:** a URL is a fact like any other; it made one up instead of finding one. And because the 404
  counted as a read, the model had no signal that the page didn't exist.
- **Good answer:** `web_search`, then `fetch_url` one of the results.
- **Fix:** small models only open URLs from the user, a search result or a page they read (find.js `urlLedger`);
  4xx/5xx come back as errors.
- **Caught by:** tests/failures.test.js case 4; tests/find.test.js urlLedger.

### 5. find, again and again

- **Asked:** the "confirm Bugonia" plan above.
- **Model:** Qwen3 0.6B (WQ06). Chat `s0mw2kmg3t000u855l`, task "confirm bugonia movie 2025".
- **What it did:** `find("movie, Bugonia, 2025")` → "Nothing found. Try different words, look it up with a tool,
  or ask the user." → `find("confirm bugonia movie 2025")` → its own plan text. It never called `web_search`.
- **Why it's bad:** find searches the user's own things; a fact about a film isn't there. The empty result's
  first instruction, "try different words", was exactly what it did.
- **Good answer:** one `web_search` (or `wiki_lookup`).
- **Fix:** an empty find falls through to the web itself; the empty message names web_search instead of "try
  different words" (find.js `NOTHING`).
- **Caught by:** tests/find.test.js NOTHING.

### 6. "Most recent" matched git_log

- **Asked:** "Awesome, what about his most recent released movie?" (about Patrick Stewart)
- **Model:** Qwen3 0.6B (WQ06). Chat `s0mw2o1ou90004zcff`.
- **What it did:** `find("most recent released movie Patrick Stewart")` returned only
  `git_log(repo, count?): Recent commits…`. A tool match stopped the web fall-through, the context filled up, and
  the turn ended with no answer.
- **Why it's bad (harness):** one shared description word ("recent") isn't a match. The model was handed a git
  tool for a movie question.
- **Good answer:** the web or Wikidata: his newest dated credits.
- **Fix:** find only skips the web for a tool matched by name or an intent phrase (score over 4).
- **Caught by:** tests/failures.test.js case 6.

### 7. An empty reply, then the old question answered again

- **Asked:** "Can you tell me what the result of 5 * 5 / 129 is?", then "Do you know Emma stones latest movie?"
- **Model:** Qwen3 0.6B (WQ06), Smart context. Chat `s0mw2mldp5000r52eh`.
- **What it did:** called `calculate` and wrote nothing. On the next question it called the same `calculate`
  again and wrote nothing again: the last exchange it saw was a question with an empty reply, so it looked
  unanswered.
- **Why it's bad:** an empty reply is a silent failure, and it poisons the next turn.
- **Good answer:** "About 0.194." Then the movie question, looked up.
- **Fix:** a reply that used tools but wrote nothing gets one nudge, then a plain "couldn't answer" (agent.js chat).
- **Caught by:** not covered (it lives in the turn loop; needs an e2e check with a scripted silent model).

### 8. A tool call typed out as a step's result

- **Model:** Qwen3 0.6B (WQ06). Chat `s0mw2kmg3t000u855l`, task "confirm bugonia movie 2025", step 1.
- **What it did:** wrote `{"name":"plan","arguments":{…}}</tool_call>` as text; the harness saved it as the step's
  result, and a recipe was learned from the task.
- **Why it's bad:** nothing ran, but the task recorded progress, and the recipe would have taught the next run to
  do the same.
- **Fix:** typed-out tool calls are never results (tasks.js `toolCallText`); recipes are only learned from tasks
  that got somewhere (`worked`) and wait for the user's approval.
- **Caught by:** tests/tasks.test.js toolCallText and worked.

### 9. Other chats read as the user talking

- **Asked:** "Can you tell me what the result of 5 * 5 / 129 is?"
- **Model:** Qwen3 0.6B (WQ06), Smart context. Chat `s0mw2mldp5000r52eh` ("What the model saw": two "Another chat"
  items).
- **What it did (harness):** smart context quoted two old Emma Stone answers, one of them wrong, into an
  arithmetic chat, after the user's message.
- **Why it's bad:** small models read text after the request as the user's own words, and old wrong answers
  spread to new chats.
- **Fix:** other chats are off by default (Settings → Context, switch kept); Fresh hands lookups over as a tool
  result, never in the user's turn.
- **Caught by:** tests/failures.test.js case 9; the Fresh e2e check.

### 10. Jaws 2 for "who directed Jaws?"

- **Found by:** running wiki_lookup on the live APIs, 2026-11-04 (no model involved).
- **What it did (harness):** Wikipedia's search ranked Jaws 2 first, and the "is the title named in the
  question?" check dropped numbers, so "Jaws 2" counted as named in "who directed jaws". Answer: Jeannot Szwarc.
- **Good answer:** Steven Spielberg (Jaws, 1975).
- **Fix:** numbers count in the title match; plurals match their singular.
- **Caught by:** tests/wiki.test.js titleInQuery.

### 11. Qwen3 0.6B writing SPARQL

- **Found by:** an experiment, 2026-11-04 (docs/measurements-2026-11-04.md).
- **What it did:** 0 of 10 queries ran: invented vocabularies (`owl:Film`, `wikidata:Person`), invented ids
  (`q123456789`), a run of zeros to the token limit.
- **Fix:** small models get `wiki_lookup` (words in, the harness does ids and queries) and never `wikidata_query`
  (agent.js `BIG_ONLY`).
- **Caught by:** the e2e checks on which tools small and big models get.
