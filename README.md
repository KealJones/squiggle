<p align="center"><img src="app/icons/icon-192.png" width="72" alt=""></p>

<h1 align="center">Squiggle</h1>

<p align="center">A private AI agent that runs in your browser, remembers you, and picks up where you left off on any device.</p>

<p align="center"><a href="https://kealjones.com/squiggle/"><b>Try it</b></a> (no account needed: pick "Try it without signing in") · <a href="docs/setup.md">Run your own</a> · <a href="docs/harness.md">How the agent loop works</a> · <a href="docs/failures.md">Failure casebook</a> · <a href="docs/evals.md">Evals</a> · <a href="docs/lab.md">Lab notebook</a></p>

Squiggle runs LFM3 1.7B on your phone or computer with no backend: the app is static files,
the only server is a free Cloudflare Worker that relays the few GitHub requests a browser can't make. Your
conversations, memory and the agent's files live in a **private GitHub repo you own**, so a chat started on a
laptop continues on a phone. The agent can search the web, read pages, look things up on Wikidata, run code
in a sandbox, keep a fact graph about you, search every past chat, and clone, commit, push and open pull
requests on your repos, with the safety rules enforced in code rather than asked of the model.

It is also a working lab for a question: **how small can the model be if the harness is good?** Squiggle's
default model is 1.7B and runs on an iPhone, the context modes are built for a 4K window, and
every bad answer a model gives becomes a test (the casebook) and an eval case.

<!-- screenshot: docs/images/demo.png (docs/images/SHOTS.md) -->

## Memory and search

The part built for people who care about retrieval.

- **Memory is a fact graph**, not a blob: `subject → relation → object` edges, one JSON line each in
  `memory/facts.jsonl`, learned as you chat or added by hand, reviewable and deletable in the Memory panel.
  Lines merge by id across devices, deletes are tombstones with a TTL. ([memory.js](app/src/memory.js))
- **Recall uses an absolute bar, not a relative one.** A fact scores by how much of it the question covers
  (0–1), so when nothing fits, nothing comes back, instead of the least-unrelated fact scoring 1 and dragging
  its neighbours in. Then one hop through a shared entity, at half score, never through "user" or "Squiggle",
  which sit on most facts. ([memory-rank.js](app/src/memory-rank.js), [search.js](app/src/search.js):
  BM25 + a light stemmer, blended with MiniLM embeddings in a worker that sleeps when idle so it fits a phone)
- **`find` is one search across everything the agent knows**: tools, recipes from finished tasks, memory,
  every past chat, and the current task's own results, each kind with its own relevance bar, falling through
  to the web when nothing of yours matches. A question that names someone only takes memory that names them
  too. ([find.js](app/src/find.js))
- **Fresh context looks things up before the model answers.** Every message starts new: the question is made
  to stand on its own (a follow-up borrows the names from the one before), earlier exchanges, pages, memory,
  Wikipedia/Wikidata and the web are searched, and the result goes in as a `find` call the model already
  made, so none of it reads as the user talking (the failure that broke Smart context on small models). Rules
  you set for the whole chat ride along; questions about your own things stay off the web.
  ([prefetch.js](app/src/prefetch.js), [harness.md § Fresh](docs/harness.md#fresh-context-prefetchjs))
- **You can see all of it.** "What the model saw" on any reply shows exactly what went in and where it came
  from, with scores; the chat details sidebar shows the context window by part, live while a reply runs.
  Context mode (Smart, Compress, Fresh) is per chat, like the model.

<!-- screenshot: docs/images/context.png (docs/images/SHOTS.md) -->

**Measured, not asserted.** `node tests/eval/retrieval.mjs` runs the rankers on a labelled set
([docs/evals.md](docs/evals.md)): the absolute bar returns nothing for 75% of unrelated questions against
50% for normalized BM25, and find's named-only rule takes it to 88%. The same benchmark found a stemmer bug
("named" never matched "name") and showed the one-hop expansion costing precision on direct questions.

## The harness and small models

- **A turn is: resolve references → look up a recipe → chat, or plan → one fresh prompt per step → final
  reply**, with `plan`, `done`, `need` and `find` added as tools for every model. Each step gets the goal,
  the plan, earlier results and a fresh context; a step that won't move asks a question instead of spinning.
  ([harness.md](docs/harness.md) is the contract for [agent.js](app/src/agent.js) and the fine-tune.)
- **Recipes**: a finished plan is saved as how the task was solved, offered by `find` for similar requests
  once you approve it. Slow the first time is fine; the second time should be fast.
- **One model: LFM3 1.7B** (Liquid's first small model trained for agent harnesses), on our own WebLLM build with
  Liquid's quantization-aware 4-bit weights, about 14 tokens a second on an iPhone. You pick the model; the device
  picks the build (16-bit or 32-bit floats on WebGPU, else the GGUF on the CPU with every core). Its tools are one
  `bash` over the workspace (cat, grep, pipes, plus git, gh, curl, search, wiki, node and bc wired to the same
  approvals and URL rules) next to the harness's own `find`, `plan`, `done` and `need`. When a reply fills its 4K
  window the harness checkpoints by itself and carries on in a fresh context, so one answer can take several windows.
- **Context is the experiment.** Each chat picks how its context is built before its first message: Compress
  (summary plus recent turns, the default), Smart (brings back earlier messages that fit), Fresh (nothing replayed;
  a lookup first, handed over as a tool call) or AI-managed (the model budgets its own window). "What the model saw"
  shows the exact prompt for any reply.
- **Keal's own models stay as experiments**: Squiggle Small (LFM2.5-350M fine-tuned on the harness's exact text,
  219 MB, runs on a phone CPU) and Tiny Gemma 4 (Gemma 4 E2B pruned to a 0.6B core and healed by distillation).
  Both are honest about being often wrong; both prove the pipeline. They keep the separate tools they were trained
  on. The engine still runs LiteRT, llama.cpp (WASM), MLC (WebGPU) and per-family tool formats, so adding a model is
  one registry entry.
- **The failure casebook** ([docs/failures.md](docs/failures.md)): 18 real bad answers, each with the chat id,
  the model, why it's wrong, the fix, and the unit test that now catches it. The bad answers are never put in
  a prompt or trained on; each pair is a preference pair for the next fine-tune. The same cases run as an
  eval against any model (`node tests/eval/run.mjs --model WQ06 --mode fresh`).
- **Numbers**: [docs/measurements-2026-11-04.md](docs/measurements-2026-11-04.md) has prompt-token costs
  before and after each change, tokens/s and memory per model on a phone-class CPU, reproducible with one
  command. [docs/lab.md](docs/lab.md) is the notebook: every experiment, what happened, what it became.

<!-- screenshot: docs/images/steps.png (docs/images/SHOTS.md) -->

## Safety, in code

- **Pushes outside the agent's own `agent/…` branches need your click.** A card shows the commits with
  Allow once / Always allow / Don't allow; "Always allow" is per repo and branch, synced, revocable. A push
  that touches `.github/workflows/` asks every time. Never a force-push. The decision only ever comes from the
  UI; a tool can't treat model output as approval.
- **The model never sees your GitHub token.** Tools reach it only through closures; model-written JavaScript
  runs in an opaque-origin iframe inside a worker, with no access to storage, sessions or the token, and is
  killed if it runs too long.
- **Outside text is data.** Web pages, repo files, git log and tool output reach the model wrapped in
  `<untrusted key="…">` tags with a per-session random key and a rule never to follow instructions in them.
  It lowers the odds of injection; the limits above don't depend on it.
- **The storage repo must be private.** Setup refuses public ones.

<!-- screenshot: docs/images/approval.png (docs/images/SHOTS.md) -->

## Everything else it does

Sessions that merge across devices (two phones chatting offline in the same session merge on the next sync,
by message id); threads on any message; attachments (text read directly, PDFs extracted, images OCR'd);
voice calls with the device's own voices; a Memory panel with the fact graph; chat search; `calculate` and
`run_js`; an optional cloud model (Gemma 4 26B on your relay's Workers AI, capped under the free tier so it
never bills). The full list and the data model are in [CLAUDE.md](CLAUDE.md).

## Try it, run it, read it

- **Try it**: [kealjones.com/squiggle](https://kealjones.com/squiggle/) → "Try it without signing in". The
  demo is the real app with storage in your browser, seeded with a sample chat and a few facts so memory and
  search have something to find; the git and GitHub tools are off until you sign in, which carries your demo
  data into a private repo of yours.
- **Supported**: tested on iPhone 16 and newer in mobile Safari (iOS 26), and desktop Chrome and Safari with WebGPU.
  Other devices may well work (without WebGPU LFM3 runs on the CPU, slowly) but haven't been tested much; an older
  iPhone may not have the memory for a 1.7B model in a browser tab.
- **Run your own**: [docs/setup.md](docs/setup.md), about 10 minutes: a GitHub App, a Cloudflare Worker, your
  fork on GitHub Pages.
- **Read it**: plain ES modules, no build step, no framework ([CLAUDE.md](CLAUDE.md) is the map).
  [docs/extending.md](docs/extending.md) covers adding tools and context modes.

## Development

```bash
npm run check               # lint + unit tests (what to run before a commit)
npm test                    # unit tests: guards, sync merges, context, find, prefetch, tools, Worker
npm run test:e2e            # end to end in headless Chromium: two-device sync against a real git
                            # server, git tools, sandbox, demo mode, full agent turns with a scripted model
npm run test:e2e:split      # same, with app and relay on separate origins (the Pages setup)
node tests/eval/retrieval.mjs                       # memory recall benchmark (a second, no model)
node tests/eval/run.mjs --model WQ06 --mode fresh    # the casebook against a real model (needs WebGPU)
npm run dev                 # local Worker + app at http://localhost:8787
```

CI runs lint, the unit tests, the e2e suite in both modes and a Worker dry-run; pull requests get a live
preview on GitHub Pages. Built in two weeks of evenings, Oct–Nov 2026, with Claude as a pair (139 of 144 commits
carry the co-author line); 318 unit tests and 33 end-to-end checks. [CONTRIBUTING.md](CONTRIBUTING.md) has the workflow.

## License

MIT ([LICENSE](LICENSE)). The model weights Squiggle downloads keep their own licenses (Gemma Terms of Use, the
LFM Open License, Apache 2.0 for Qwen, the Llama 3.2 Community License).
