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

## 3. A/B battery: two checkouts, one model (real model)

`node tests/eval/ab.mjs --base <dir> --pr <dir> --model KLF3 --reps 3` runs the same cases on two checkouts of
Squiggle with the same model and reports both arms side by side: score, rounds, wall and thinking per case, then
the mean of the case means. It is how a harness change is shown to help rather than argued about — one run of a
small model is noise, and a change that makes replies 30 seconds faster and answers wrong is not an improvement.

An arm is a checkout whose `app/` is served to the browser (`SQUIGGLE_APP_DIR`); the graders, the cases and the
runner all come from the checkout you run `ab.mjs` in, so both arms are scored by one copy of the harness and a
branch can't flatter itself by editing its own cases. An arm does not swap `worker/` (the relay) or `tests/`, so
a change to either isn't what this measures:

```bash
git worktree add /tmp/ab-base origin/main
git worktree add /tmp/ab-pr   my-branch
node tests/eval/ab.mjs --base /tmp/ab-base --pr /tmp/ab-pr \
    --model KLF3 --mode compact --set cases-deliberation.json --reps 3
```

Cells (one arm, one repetition) are skipped when their JSON is already in the results directory, so a battery
that was stopped picks up where it left off; `--fresh` re-runs them. `--cases 1,2` narrows to a few. The
per-cell JSONs keep every turn, its tool calls and the reply, which is what to read when a number surprises you.

### Where this comes from

The design is adapted from Hermes Agent's `evals/core_tool_deferral` harness
([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), MIT, same licence as Squiggle), which
runs two pinned checkouts over a task battery and grades accuracy, API turns, tokens and wall per cell. Kept:

- **Two arms from real checkouts**, not a mocked switch. A flag flipped inside one build doesn't catch what a
  changed prompt or a changed tool list does to the model. (Hermes imports each arm's agent into one harness;
  here the browser loads each arm's app into one harness, which comes to the same thing.)
- **Repetitions per cell, and contested cells.** When the arms differ on a case at three repetitions, the report
  prints the command to re-run *those cases* at six. Below that, a difference is not a result.
- **Partial credit.** A case's score is the fraction of its checks that held, so one wrong claim in an otherwise
  good answer is not scored the same as a wrong answer. (run.mjs `checkCount`.)
- **Same denominator.** A case that timed out or errored scores 0 and stays in the score denominator, but is left
  out of the rounds and wall means — where a crash would otherwise look like a win, because it is fast.
- **Interactive fairness.** A reply that ends by asking the user gets the case's scripted answer (`replies` in the
  case, at most two), recorded as roundtrips instead of counted as a failure. Without this, every case the model
  is right to ask about scores 0 and the battery is poisoned — and asking after two or three attempts is what the
  small-model prompt tells it to do.
- **Read the anomalies** before publishing a verdict; the transcripts are in the cell JSONs.

What is different here, and why:

- **Efficiency is graded, not just reported.** Hermes reports turns and cost next to accuracy; on a phone a round
  *is* the cost (a 6K-window prefill on an iPhone 16 runs 30 s to 3 min), so cases can set `maxRounds`,
  `maxToolCalls`, `maxWords` and `noRepeat`, and failing them fails the case. Rounds are counted from the trace
  the app saves for every reply, so the number is the real one on any runtime, not only under `--llm`.
- **Cells run one at a time.** The model is local and holds most of the tab's memory, so there is no useful
  parallelism and no dollar cost — the budget is wall-clock. A three-repetition A/B of five cases on LFM3 1.7B is
  hours, not minutes: start with `--cases` and one repetition while a change is still moving.
- **No LLM judge.** Hermes grades with programmatic graders per task and uses a judge for recall questions.
  Squiggle's checks are regexes, tool names and the ceilings above — cheap, deterministic, and they say what they
  measured. Anything needing a judge belongs in a separate eval with its own write-up.

### Not built yet

A context-mode recall benchmark, adapted from the same repo's `evals/compaction`: take a real long chat, generate
recall questions about the region each context mode drops, answer them from only what that mode would have sent,
and score recall against tokens retained, with the whole transcript as the ceiling arm. That is the measurement
Compress, Smart, Fresh and AI-managed have never had — docs/lab.md argues about them from single chats instead.
