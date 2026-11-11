# Evals

Two ways Squiggle's behaviour is measured, both runnable from a checkout. The first needs no model and takes a
second; the second drives a real model through the real app and takes a while.

## 1. Memory recall benchmark (no model)

`node tests/eval/retrieval.mjs` ranks a labelled set of memory facts against questions with each of the rankers
behind `recall` and `find`, so the ranking decisions in `search.js` / `memory-rank.js` (docs/harness.md "Memory
recall: an absolute bar") are checkable rather than argued. `--verbose` prints every question's wanted and
returned facts; `--facts memory/facts.jsonl --queries my-queries.json` runs it on your own facts.

The built-in set is **synthetic** (40 facts about one person and their work, 24 questions, 8 of them about other
things where the right answer is nothing). It was written for this benchmark, not taken from a chat, so read
the numbers as a regression check on the rankers, not as a claim about real usage. Top 8 returned.

Last run (2026-11-09):

| ranker | precision | recall | F1 | top-1 right | nothing for unrelated |
|---|---:|---:|---:|---:|---:|
| BM25, relative bar 0.2 | 32% | 91% | 48% | 94% | 50% |
| overlap, absolute bar 0.2 | 33% | 91% | 48% | 94% | 75% |
| overlap + 1-hop (recall) | 28% | 91% | 43% | 94% | 75% |
| recall + named-only (find) | 32% | 91% | 48% | 94% | 88% |

"Nothing for unrelated" is the column that matters for a small model: a fact that comes back for a question it
has nothing to do with gets used ("Emma Stone's real name is Keal", docs/failures.md case 1). Normalized BM25
always returns its best match, so half the unrelated questions got a fact; the absolute bar (a record with
nothing in common scores 0 whatever the others do) takes that to three quarters, and find's rule that a
question naming someone only takes facts naming them to seven eighths. The one that still gets through is "Is
Rust faster than Go for parsing logs?", which shares two real words with the user's Rust log parser; nothing
word-based separates that from a question about the parser itself.

Two things the benchmark found on its first run (2026-11-09):

- **"What's my name?" recalled nothing.** The light stemmer turned "named" into "nam" and left "name" alone,
  so the fact "the user is named Sam" never matched. The stemmer now drops a trailing e too ("named"/"name",
  "decided"/"decide" meet). Fixed in `search.js`, with the two unit tests that pinned the old tokens updated.
- **The one-hop expansion costs precision and buys no recall here.** The hop brings every fact sharing a
  specific entity with a match (a question about Orbit's build tools returns Orbit's bug, its deploy target
  and the manager who wants a demo), at half score. On this set recall is already 91% without it. It stays,
  because the hop is for questions like "what's going on with Orbit?" that this set doesn't ask, but it is
  now a measured cost rather than a free feature; a set with those questions is the next thing to add.

## 2. The failure casebook as an eval (real model)

`docs/failures.md` records real bad answers with the fix and the unit test that catches each. `tests/eval/
cases.json` turns the cases into short chats with pass conditions (regexes on the final reply; tools the last
turn must or must not call; no URL in a reply that no tool returned), plus the seeds that made the originals go
wrong: a memory fact about the user and an unrelated earlier chat.

```
node tests/eval/run.mjs --model WQ06 --mode fresh        # Qwen3 0.6B on WebLLM, Fresh context
node tests/eval/run.mjs --model WLF12 --mode smart       # LFM2.5 1.2B, Smart
node tests/eval/run.mjs --model E4B --cases 1,2,10       # Gemma 4 E4B, three cases
```

It runs the real app (the e2e harness's git server and relay code, GitHub's REST API mocked) with the real
model in a persistent Chromium profile, the real web and Wikipedia by default, and writes the transcript and
verdicts to `docs/evals/<model>-<mode>.json`. A WebGPU device is needed for the GPU models, so it runs on a
laptop, not in CI; `--fake` runs the e2e suite's scripted engine through it to check the runner itself.

Results go here as they're run, one row per model and mode, with the date:

| model | mode | passed | date | notes |
|---|---|---:|---|---|
| LFM2.5 1.2B (`--llm`, native llama.cpp) | Fresh | 3 of 4 run | 2026-11-09 | cases 1–4; stopped there (~6 min a case on a 2-core box). The runner said 4/4, but case 3 (pushback) was a false pass: the reply agreed Poor Things was her latest film and the check only looked at the reply's first words; the check is stricter now. Case 2 passed on "The Catch", which is announced, not out: lenient too. Final replies also started with a stray "[done]" and the plan text (to look into) |

Case 16's fix (repo listing) and case 15's (pull a repo) were checked by hand the same way: "List my GitHub repos"
called `github_list_repos` in Compress, Smart and Fresh; "pull github.com/tester/app" cloned it in Fresh, and in
Compress listed the repos instead (only Fresh's lookup says which tool to call).

### Running the phone model without a GPU

```
pip install llama-cpp-python
python3 tests/eval/llm_server.py LFM2.5-1.2B-Instruct-Q4_0.gguf 8711 &
node tests/eval/run.mjs --model WLF12 --mode fresh --llm http://127.0.0.1:8711
```

The app, the agent and LFM2's own prompt rendering and call parsing (toolformats/lfm2.js) are the real ones;
only the completion goes to native llama.cpp on the same weights (Q4_0 GGUF rather than the phone's q4f16 MLC
build). On a 2-core cloud box that reads a 1,200-token prompt in about 10 s; llama.cpp in WASM on the same box
didn't finish one in 22 minutes.

A case that fails on a model is either a regression (the fix that produced the case no longer holds) or a
case the fix never covered for that model: either way it names the next casebook entry. The bad answers in the
casebook are never put in a prompt or trained on; each pair is the rejected half of a preference pair for the
next Squiggle Small.
