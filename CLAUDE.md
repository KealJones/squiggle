# Squiggle — notes for engineers and coding agents

A browser-only agent: Gemma 4 on WebGPU (LiteRT-LM) on computers, Gemma 3 270M on the CPU (wllama) or Gemma 4 26B on the relay's Workers AI on phones, state synced through a
private GitHub "storage repo", and a Cloudflare Worker that relays GitHub
requests browsers can't make (device-flow login, git smart-HTTP). The app is
static: either the Worker serves it (wrangler.toml, relay same-origin at /api)
or GitHub Pages does (deploy.yml writes config.json with the relay URL;
wrangler.relay.toml deploys a relay-only Worker that allows the Pages origin).

## Layout

```
app/                    static app, plain ES modules, no build step
  index.html styles.css sandbox.html sw.js manifest.webmanifest
  vendor/               bundled libs (isomorphic-git, lightning-fs, marked, DOMPurify) — `npm run vendor`
  src/
    main.js             UI: setup wizard, sessions sidebar + search, chat, threads, panels
    agent.js            turn loop (docs/harness.md): chat phase → plan → one fresh prompt per step → final reply; need/find; recipes learned after
    tasks.js            step-mode task state, step/final prompts (budgeted), resume rules
    recipes.js          memory/recipes.jsonl: how finished tasks were solved, matched to new requests, forgotten after 90 days unused
    find.js             `find`: one search over tools, recipes, memory, past chats and this task
    refs.js             reference resolution ("that", "the repo", links) → hints in the prompt
    engine.js           model registry, download (resumable, IndexedDB chunks), LiteRT engine, generation
    engine-cloud.js     cloud model through the relay (same conversation interface)
    engine-wllama.js    Gemma 3 270M on llama.cpp WASM (phones): prompt-based tools, <think>, anti-loop
    context.js          context assembly: smart (default; retrieval incl. other chats) / compact / full; report
    search.js           BM25 + blend with optional embeddings (embed.js, MiniLM on CPU)
    tools.js            agent tools; run_js sandbox host
    guard.js            hard limits: push policy, workflow-file check, workspace path resolution
    grants.js           remembered "always allow" push grants (synced)
    untrusted.js        <untrusted key=…> wrapping for outside content
    attachments.js      chat attachments: limits, text extraction (pdf.js from jsDelivr), what the model sees
    storage.js          storage repo: setup, clone at /state, client-side rebase sync
    merge.js            conflict-free merges (sessions JSON, .jsonl)
    sessions.js         sessions + threads + observations on top of storage
    memory.js           fact graph (memory/facts.jsonl), recall with 1-hop expansion
    github.js           device flow, token refresh, REST helpers (token never leaves here)
    git.js              LightningFS + isomorphic-git wiring
    config.js           relay address: config.json / per-device override / same-origin
    util.js             ids, kv (IndexedDB), emitter, mutex
worker/index.js         relay + static assets (wrangler.toml); cloud model route + AiBudget Durable Object
tests/*.test.js         unit tests (node --test)
tests/e2e/              Chromium end-to-end: real git server, real Worker code, scripted model
```

## Invariants (keep these true)

- The model must never be able to read the GitHub token or the storage repo
  internals. Tools reach the token only through `github.js`/`git.js` closures;
  `run_js` executes in `sandbox.html` (opaque origin iframe) inside a Worker.
- Pushes are never forced. `agent/…` branches push freely; any other branch
  needs approval (`guard.pushPolicy`): a one-time click or a remembered grant
  for that repo + branch (`grants.js`, `settings/push-grants.jsonl` in the
  storage repo). Pushes whose new commits touch `.github/workflows/`
  (`guard.touchesWorkflows`) ask every time and are never remembered.
- Approval comes only from the UI: `agent.runTurn` passes `ctx.approve`, which
  resolves from the card's buttons (or 'deny' when the turn is stopped). Tools
  must never treat model output as approval.
- Agent file paths resolve through `guard.resolveAgentPath`: `/home/…` maps to
  `home/` in the storage repo, `/repos/<name>/…` to clones; `.git` and `..`
  escapes are rejected.
- Text from outside (web, repo files, git log, GitHub descriptions, retrieved
  observations) reaches the model via `wrapUntrusted`.
- Every synced file must be mergeable or keep both versions: sessions merge by
  message id, `.jsonl` by line id; other files keep local and save
  `<file>.remote-<date>-<device>`.
- Session objects are mutated in place on sync (`sessions.reload` merges into
  the cached object) so views holding a reference stay valid.

## Data model

Session file `sessions/<id>.json`: `{ v, id, title, created, updated, deleted?,
messages[{id, role, content, ts, mts?, thread, tools?, context?, pinned?, attachments?[{name, path, type, size, chars, lines?, error?}]}],
threads{id: {parent, title, summary?}}, observations[], summaries{main|threadId} }`.
Attachments: storage only holds text, so text files are saved as-is and PDFs as
their extract (`<name>.txt`) under `home/attachments/<session>/`; images and
other binaries are not stored (path null). Extracts are wrapped with `wrapUntrusted`
wherever the model sees them (turn note, read_file, grep, search_history) and
indexed as observations with source 'attachment'. Limits: 10 files, 20 MB each.
A thread's context = main messages up to its parent + its own messages
(`sessions.lineMessages`).

## LiteRT-LM notes (0.14.0)

- `Engine.create({ model: ReadableStream, backend: GPU_ARTISAN, mainExecutorSettings })`;
  MTP (`use_submodel`) with a plain fallback.
- Tools go in `preface.tools` as `{type:'function', function}`; enable thinking when tools are on.
- Tool results are sent as `{ role: 'tool', content: [{ name, response }] }`.
- Don't replay thinking from earlier turns into history.

## Harness v2 (docs/harness.md)

The design doc is the contract for agent.js/tasks.js and for the small-model fine-tune; change
both together. Task state lives on the session (`session.tasks`, merged by id like notes).

## Verifying changes

`npm test`, `node tests/e2e/run.mjs` and `node tests/e2e/run.mjs --split`
(app and relay on different origins; set `PLAYWRIGHT_BROWSERS_PATH` if needed). The e2e suite swaps `src/engine.js` for `tests/e2e/fake-engine.js`;
real-model behaviour needs a WebGPU device and is checked by hand.

## Phones

iOS Safari kills tabs that load Gemma 4 E2B/E4B, and smaller ONNX models (tried and removed:
Gemma 3, SmolLM, a QAT E2B build on onnxruntime-web) failed on WebGPU readback. Phones default to
Gemma 3 270M (`G3`): unsloth's Q4_0 GGUF (242 MB) on wllama 3.8.1, CPU only (`n_gpu_layers: 0`),
in `engine-wllama.js`; wllama caches the file itself. Also the fallback on computers without WebGPU.
(ONNX on WASM failed too: the 4-bit export packs embeddings with GatherBlockQuantized, which the
WASM build lacks, and the older full-precision export got the tab killed.) Gemma 3 has no tool
format, so tools are prompt-based ```tool_call JSON blocks (docs/harness.md, "Small-model format";
the fine-tune in tp-parse trains on that exact text). No tool names go in prose: the model looks
tools up with `find` (answered by the agent) and sees details only for tools it found. The cloud model stays
available on phones. `cleanupStorage` frees downloads of models that aren't offered or don't fit.
Loads and replies write a crash marker with the current step, shown on the next open.

## Cloud model (engine-cloud.js, worker /api/ai/*)

- Gemma 4 26B A4B on Workers AI via the relay; off unless the Worker has the AI binding, the
  AI_BUDGET Durable Object and AI_USERS (GitHub logins, checked with the caller's token).
- Hard cap: each request reserves its worst-case neurons first; refused (429, error 'limit') when
  that would pass AI_DAILY_NEURONS (default 9000, clamped to 9900 — under the free 10,000/day).
  Settled with the real `usage.neurons` afterwards. Resets 00:00 UTC, like Cloudflare's.
- The app shows the limit as a plain message; it never retries or falls back to billing.
