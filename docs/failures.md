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

### 12. "I don't have a tool called run_js"

- **Asked:** a JavaScript for loop (numbers 1 to 100, mod 2), then "Stop searching the web!!! Tell me the tool names
  you have in your system prompt."
- **Model:** LFM2.5 1.2B Instruct on WebLLM (WLF12), small-model mode, 2026-11-08 (Keal's screenshot).
- **What it did:** web-searched for the loop; then listed six tools (fetch_url, web_search, wiki_lookup, remember,
  plan, need) and said it had no run_js.
- **Why (harness):** gated models get ~10 tools declared in full and the rest named only in a sentence of the
  system prompt. LFM2 was trained that its tools are what's in "List of tools", so run_js, named in the sentence,
  didn't exist for it. The Qwen models gating was measured on (2026-11-04) did read the sentence.
- **Good answer:** call run_js (or just write the loop); when asked, name every tool, run_js included.
- **Fix:** formats whose model reads only its own tool list (`listsNames`, LFM2) get the gated tools in that list
  as `{"name": …}` entries; the schema follows once the model calls or looks one up (toolformats/lfm2.js,
  NativeConversation `tool_names`). Searching for something it could write itself: not fixed; watching.
- **Caught by:** tests/toolformats.test.js "gated LFM2 on WebLLM: every tool is in the model's own tool list".

### 13. Made-up run_js output

- **Asked:** "Awesome can you now run that script using `run_js` and tell me the output?", then "Show me the results?"
- **Model:** LFM2.5 1.2B Instruct on WebLLM (WLF12), Compress context. Chat `s0mw991ww8000kggq7`, 2026-11-09.
- **What it did:** called `run_js({"expression": …})` (run_js was in its tool list by name only, case 12, so it
  borrowed calculate's argument name); run_js ran no code and returned `{"stdout": ""}` as a success; the model
  then printed 1, 3, … 99, 101 as "the output".
- **Why it's bad:** the harness reported a run that never happened as fine, and the model filled the gap.
- **Good answer:** an error saying run_js needs `code`; the model calls it again with `code`.
- **Fix:** runTool refuses a call missing a required argument, naming what's needed and what was sent; nothing
  runs (tools/registry.js). The tool's schema is declared from the next request on, as before.
- **Caught by:** tests/tools-registry.test.js case 13.

### 14. Fresh looked up the user's whole request

- **Asked:** "Sick I only asked if you could run js … can you help me write a generator js for loop function that
  like returns every mod 2 of 1 to 100." and later "Uhm thank you for that! Can run that console.log of the
  generator script using run_js and share the output?"
- **Model:** LFM2.5 1.2B Instruct on WebLLM (WLF12), Fresh context. Chat `s0mw98cxnr000metrw`, 2026-11-09.
- **What happened:** Fresh's lookup took "Sick" and "Uhm" (sentence-initial capitals) for names and ran
  wiki_lookup on the whole message ("Sick, Sick, Sick"; the actress Uhm Ji-won) plus a web search, handed to the
  model as its own find call. The model looked Uhm Ji-won up again, planned around the junk, and never ran the
  script; "that console.log" also lost the script, since Fresh replays only what clears its ranking bar.
- **Good answer:** no lookup for a request to write or run something; the script from the previous reply in
  view; run_js with it.
- **Fix:** (prefetch.js, agent.js `prefetch`) a capitalised word that starts a sentence is a name only when
  another name follows it; requests to do or make something (`doRequest`) and jobs for non-lookup tools get no
  web or Wikipedia lookup; a message that points back ("that", "it") brings the exchange it points at, with the
  reply as written.
- **Caught by:** tests/prefetch.test.js (the two messages above); e2e "Fresh context" for the pointed-at exchange.

### 15. Asked to pull bubbles, went looking for squiggle

- **Asked:** "Can you pull GitHub.com/kealjones/bubbles"
- **Model:** LFM2.5 1.2B Instruct on WebLLM (WLF12), Fresh context, a new chat, 2026-11-09 (Keal's screenshot).
- **What it did:** Fresh's lookup came back with "1 saved": an old chat about Kealjones/squiggle. The model planned
  "List the current GitHub repository details for Kealjones/squiggle" and ran `web_search("Kealjones/squiggle")`
  twice. It never called `git_clone`.
- **Why it's bad:** the wrong repo, and the wrong kind of action. Three harness mistakes stacked: "GitHub.com" was
  taken as the name in the question, so any saved chat mentioning github.com matched; "pull <repo>" wasn't
  recognised as a job for a tool (only "clone" was); and the seeded find result, unlike a real `find`, listed no
  tools, so the only thing in front of a model with gated tools was an unrelated chat. It did what the lookup
  suggested.
- **Good answer:** `git_clone("https://github.com/kealjones/bubbles")`, then a line saying it's at /repos/bubbles.
- **Fix:** a link or repo path in the question is an exact name: saved things match only if they contain that
  path (prefetch.js `refsIn`, `rank`); a GitHub repo named outright scores as git_clone whatever the verb, a
  deeper link (…/pull/3) stays a page to read (find.js INTENTS); Fresh's lookup lists the tools that clearly fit
  as "Tools for this (ready to call)" and returns their names, which declares them for gated models, and tells
  the model not to search the web for it (agent.js `prefetch`, prefetch.js `render`).
- **Caught by:** tests/prefetch.test.js and tests/find.test.js "case 15"; e2e "Fresh context"; eval case 17.
