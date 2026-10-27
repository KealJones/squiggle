# Squiggle — notes for engineers and coding agents

A browser-only agent: local models on WebGPU (Gemma 4 via LiteRT-LM; Gemma 4 E2B Mobile, Gemma 3 and SmolLM via onnxruntime-web), state synced through a
private GitHub "storage repo", and a Cloudflare Worker that relays GitHub
requests browsers can't make (device-flow login, git smart-HTTP). The app is
static: either the Worker serves it (wrangler.toml, relay same-origin at /api)
or GitHub Pages does (deploy.yml writes config.json with the relay URL;
wrangler.relay.toml deploys a relay-only Worker that allows the Pages origin).

## Layout

```
app/                    static app, plain ES modules, no build step
  index.html styles.css sandbox.html sw.js manifest.webmanifest
  vendor/               bundled libs (isomorphic-git, lightning-fs, marked, DOMPurify, HF tokenizers + jinja) — `npm run vendor`
  src/
    main.js             UI: setup wizard, sessions sidebar + search, chat, threads, panels
    agent.js            turn loop (context → stream → tools → repeat) + background jobs
    engine.js           model registry, download (resumable, IndexedDB chunks), LiteRT engine, generation
    engine-onnx.js      ONNX models on onnxruntime-web; Gemma 4 E2B Mobile reads embedding rows from storage
    context.js          context assembly: compact (default) / smart (retrieval) / full; report
    search.js           BM25 + blend with optional embeddings (embed.js, MiniLM on CPU)
    tools.js            agent tools; run_js sandbox host
    guard.js            hard limits: push policy, workflow-file check, workspace path resolution
    grants.js           remembered "always allow" push grants (synced)
    untrusted.js        <untrusted key=…> wrapping for outside content
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
messages[{id, role, content, ts, mts?, thread, tools?, context?, pinned?}],
threads{id: {parent, title, summary?}}, observations[], summaries{main|threadId} }`.
A thread's context = main messages up to its parent + its own messages
(`sessions.lineMessages`).

## LiteRT-LM notes (0.14.0)

- `Engine.create({ model: ReadableStream, backend: GPU_ARTISAN, mainExecutorSettings })`;
  MTP (`use_submodel`) with a plain fallback.
- Tools go in `preface.tools` as `{type:'function', function}`; enable thinking when tools are on.
- Tool results are sent as `{ role: 'tool', content: [{ name, response }] }`.
- Don't replay thinking from earlier turns into history.

## Verifying changes

`npm test`, `node tests/e2e/run.mjs` and `node tests/e2e/run.mjs --split`
(app and relay on different origins; set `PLAYWRIGHT_BROWSERS_PATH` if needed). The e2e suite swaps `src/engine.js` for `tests/e2e/fake-engine.js`;
real-model behaviour needs a WebGPU device and is checked by hand.

## ONNX models (engine-onnx.js)

- onnxruntime-web 1.30.0 from jsDelivr; tokenizer + chat template from `vendor/hf.js`.
- Files are stored as Blobs (16 MB records) so `randomReader` can read single rows.
- Gemma 4 E2B Mobile (QAT, q2f16): the 1.3 GB `embed_tokens` file is never loaded; `RowLookup`
  dequantizes rows per token (GatherBlockQuantized: low bits first, zero point 2^(bits-1), fp16
  scales per 256-value block), matching the ONNX graph. Only the ~1 GB decoder is in memory.
- Gemma 4 native tools: `<|tool_call>call:name{k:<|"|>v<|"|>}<tool_call|>`, results continue the same
  model turn as `<|tool_response>response:name{...}<tool_response|>` (KV cache kept). Other models
  get tools in the system prompt and answer `<tool_call>{json}</tool_call>`; each round re-prefills.
- Needs `shader-f16` for q4f16/q2f16 on WebGPU; without it the wasm (CPU) backend runs (slow).
- Debug: `globalThis.SQUIGGLE_DEBUG = 1` logs load steps and raw generated text.

## Cloud model (engine-cloud.js, worker /api/ai/*)

- Gemma 4 26B A4B on Workers AI via the relay; off unless the Worker has the AI binding, the
  AI_BUDGET Durable Object and AI_USERS (GitHub logins, checked with the caller's token).
- Hard cap: each request reserves its worst-case neurons first; refused (429, error 'limit') when
  that would pass AI_DAILY_NEURONS (default 9000, clamped to 9900 — under the free 10,000/day).
  Settled with the real `usage.neurons` afterwards. Resets 00:00 UTC, like Cloudflare's.
- The app shows the limit as a plain message; it never retries or falls back to billing.
