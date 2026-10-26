# Squiggle — notes for engineers and coding agents

A browser-only agent: Gemma 4 on WebGPU (LiteRT-LM), state synced through a
private GitHub "storage repo", and a Cloudflare Worker that serves the app and
relays GitHub requests browsers can't make (device-flow login, git smart-HTTP).

## Layout

```
app/                    static app, plain ES modules, no build step
  index.html styles.css sandbox.html sw.js manifest.webmanifest
  vendor/               bundled libs (isomorphic-git, lightning-fs, marked, DOMPurify) — `npm run vendor`
  src/
    main.js             UI: setup wizard, sessions sidebar + search, chat, threads, panels
    agent.js            turn loop (context → stream → tools → repeat) + background jobs
    engine.js           model download (resumable, IndexedDB chunks), LiteRT engine, generation
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
    util.js             ids, kv (IndexedDB), emitter, mutex
worker/index.js         relay + static assets (wrangler.toml)
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

`npm test` and `node tests/e2e/run.mjs` (set `PLAYWRIGHT_BROWSERS_PATH` if
needed). The e2e suite swaps `src/engine.js` for `tests/e2e/fake-engine.js`;
real-model behaviour needs a WebGPU device and is checked by hand.
