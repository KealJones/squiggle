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
    main.js             entry: settings, config, sign-in state → setup wizard or the app
    ui/                 the UI, one module per area (plain DOM, no framework)
      dom.js            h(), icon(), md(), toast(), number formatting
      state.js          the shared UI state object (current session, busy, model state, call, …)
      settings.js       per-device settings (localStorage) and their one-time migrations
      setup.js          first-run wizard: sign in, install the GitHub App, storage, model picker
      app.js            startApp/wireApp: loads state, wires index.html to the modules, storage events
      chat.js           sessions sidebar + search, message list, composer, send() → agent.runTurn, approval/check-in cards
      panels.js         drawer panels: threads, notes, memory + recipes, files, "what the model saw"
      side.js           chat details sidebar (see below)
      settings-panel.js the Settings drawer
      model-ui.js       model download/load with progress, crash-loop guard, banners, composer note
      voice-ui.js       read aloud, voice calls (call bar), natural voice lifecycle and crash marker
    agent.js            turn loop (docs/harness.md): chat phase → plan → one fresh prompt per step → final reply; need/find; recipes learned after
    tasks.js            step-mode task state, step/final prompts (budgeted), resume rules
    recipes.js          memory/recipes.jsonl: how finished tasks were solved, matched to new requests, forgotten after 90 days unused
    find.js             `find`: one search over tools, recipes, memory, past chats and this task
    refs.js             reference resolution ("that", "the repo", links) → hints in the prompt
    engine.js           model registry, download (resumable, IndexedDB chunks), LiteRT engine, generation
    engine-cloud.js     cloud model through the relay (same conversation interface)
    engine-wllama.js    Gemma 3 270M on llama.cpp WASM (phones): prompt-based tools, <think>, anti-loop
    context.js          context assembly: CONTEXT_MODES registry (smart default / compact / managed / full); report
    recall.js           smart mode's recalled block: earlier messages (this chat + other chats) and memory, quoted after the request; time phrases, size caps
    search.js           BM25 + blend with optional embeddings (embed.js, MiniLM on CPU)
    tools.js            facade over tools/ (keeps the import path)
    tools/              agent tools (docs/extending.md)
      registry.js       defineTool/registerTool, toolSpecs, runTool: the extension point
      index.js          registers the built-ins in a fixed order (the order is prompt text for small models)
      workspace.js      /home, /repos and /web path mapping shared by the tools
      files.js notes.js git.js web.js memory.js compute.js   the tools by area (compute.js hosts the run_js sandbox)
    calc.js             `calculate` tool: safe math expression parser (no eval), % and money-friendly
    guard.js            hard limits: push policy, workflow-file check, workspace path resolution
    grants.js           remembered "always allow" push grants (synced)
    untrusted.js        <untrusted key=…> wrapping for outside content
    attachments.js      chat attachments: limits, text extraction (pdf.js, Tesseract.js OCR from jsDelivr), what the model sees
    ocr.js              text in images (screenshots, receipts, signs) via Tesseract.js 5.1.1; worker freed after 20 s idle
    voice.js            voice calls: markdown → speakable chunks, call state machine, speakers (system speech / natural voice)
    tts.js              natural voice, page side: worker controller (timeouts), Web Audio player
    tts-worker.js       natural voice worker: ONNX Runtime Web (WASM) + eSpeak NG phonemizer; Kokoro or KittenTTS
    tts-text.js         natural voice, pure parts: pinned model registry, text → phonemes → ids, voice styles, audio tidy
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

## Chat details sidebar

The right-hand aside (`#ctx-side`, ui/side.js `renderSide`): model and how it runs (with the chat's own model
picker), the context window, the latest plan, tools/files/pages used and outputs (files, commits, pushes, PRs),
the agent's notes, and archive/delete for the open chat.
The window comes from `reply.context.window = { size, parts: {instructions, tools, conversation, memory,
recalled, message, turn}, used }` (agent.js `windowOf`/`setWindow`/`grow`), set when each chat-phase or step
call starts and grown with each response and tool result; `ui.onContext` redraws it live (a microtask, so it
draws even when a turn never yields). Saved with the reply. Docked and open by default at ≥1200 px
(open/closed and collapsed sections remembered in localStorage), an overlay below that, hidden while a drawer
panel is open at ≤1500 px. Replies saved before this show just the total.

## Data model

Session file `sessions/<id>.json`: `{ v, id, title, created, updated, deleted?, archived?, model?,
messages[{id, role, content, ts, mts?, thread, tools?, context?, pinned?, deleted?, attachments?[{name, path, type, size, chars, lines?, error?}]}],
threads{id: {parent, title, summary?}}, observations[], summaries{main|threadId} }`.
`deleted`/`archived` on the session and `deleted` on a message are tombstones (content emptied) so the change
syncs; `sessions.list()` leaves archived chats out (`listArchived`), `lineMessages` leaves deleted messages out.
`model` is the chat's own model: `ui/model-ui.js sessionModel()` picks it over `settings.defaultModel` (the
device default from Settings) and `settings.model` is whatever is loaded right now.
Attachments: storage only holds text, so text files are saved as-is and PDFs as
their extract (`<name>.txt`) under `home/attachments/<session>/`; images as the text
Tesseract.js reads from them (`ocr.js`, two passes: full size and half-size grayscale), also
`<name>.txt`; other binaries are not stored (path null). Extracts are wrapped with `wrapUntrusted`
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
Context modes (`settings.contextMode`, `context.js CONTEXT_MODES`): `compact` (Compress), `smart` (default) and `managed` (AI-managed,
experimental: budget line, plan steps with `needs`/`kind: 'summarize'`, `checkpoint`). Everything AI-managed adds
is behind `managed()`; the other modes must stay unchanged (Squiggle Small's prompt is its training text).
The registry drives the Settings dropdown and the sidebar labels; `registerContextMode` adds one (docs/extending.md).

## Natural voice (voice.js, tts*.js)

- Speech-to-text is the Web Speech API; text-to-speech is a speaker: system speech or the natural
  voice. Each reply uses one voice (the natural one only if it's loaded when the reply starts).
  Errors, or synthesis slower than speech (RTF > 1.15 over recent chunks), move the call to system
  speech; a slow Kokoro also switches the device to KittenTTS (`voiceModel`).
- Read aloud: the speaker button under a reply (`voice.readAloud`) uses the same voice choice. The natural
  voice loads on the tap, is kept 60 s for the next reading, then freed; a call stops reading and frees it.
- The model loads in a module worker on the call tap (Web Audio unlocks inside that tap) and the
  worker is terminated when the call ends: WASM memory never shrinks, so that's the only way to give
  it back. Crash marker `squiggle-voice-loading` (load and while speaking); found on open, calls
  switch to system voices and a banner explains.
- Pinned: onnxruntime-web 1.30.0 (CPU/WASM build, one thread, no proxy, so no blob: scripts) and
  phonemizer 1.2.1 (eSpeak NG compiled to plain JS) from jsDelivr; model files at fixed Hugging Face
  commits in Cache Storage `squiggle-tts-v1` (sw.js keeps it). Kokoro-82M q8 (~92 MB, default on
  computers) and KittenTTS nano 0.8 int8 (~28 MB, default on phones), both Apache-2.0. The
  phonemizer package is labelled Apache-2.0 but contains eSpeak NG (GPL-3.0-or-later); it's loaded
  from the CDN at runtime, never vendored into this repo.
- Measured in headless Chromium on a 2-core 2.1 GHz Xeon (`node tests/e2e/tts-bench.mjs --model
  kokoro|kitten`): Kokoro RTF ~3.3, tab +365 MB after speaking (+510 MB peak while loading);
  KittenTTS RTF ~0.8, tab +260-280 MB (+318 MB peak). About 95 MB of that is ONNX Runtime's WASM
  itself. Both transcribe back correctly with Whisper. Not yet measured on an iPhone.

## Verifying changes

`npm run check` (ESLint + unit tests), `npm run test:e2e` and `npm run test:e2e:split`
(app and relay on different origins; set `PLAYWRIGHT_BROWSERS_PATH` if needed; `E2E_ONLY=<part of a
check name>` runs a subset). The e2e suite swaps `src/engine.js` for `tests/e2e/fake-engine.js` and
`src/tts-worker.js` for a scripted fake; real-model behaviour needs a WebGPU device and is checked
by hand. `node tests/e2e/tts-bench.mjs` loads the real voice model in headless Chromium.

## Phones

iOS Safari kills tabs that load Gemma 4 E2B/E4B, and smaller ONNX models (tried and removed:
Gemma 3, SmolLM, a QAT E2B build on onnxruntime-web) failed on WebGPU readback. Phones default to
Squiggle Small (`SQ`): LFM2.5-350M fine-tuned on the harness format (lm-experiments experiments/squiggle-ft,
public at kealjones/squiggle-small, Q4_0 GGUF 219 MB, experimental v1). Phones on `G3` move to it once.
Gemma 3 270M (`G3`, unsloth's Q4_0 GGUF, 242 MB) stays as an option. Both run on wllama 3.8.1, CPU only
(`n_gpu_layers: 0`), in `engine-wllama.js`; wllama caches the file itself. llama.cpp may split LFM2.5's
`<think>` into `reasoning_content` (shown as thinking; a stray closing tag is dropped). Also the fallback on computers without WebGPU.
(ONNX on WASM failed too: the 4-bit export packs embeddings with GatherBlockQuantized, which the
WASM build lacks, and the older full-precision export got the tab killed.) Stock Gemma 3 270M runs as
plain chat (`engine.chatOnly`): any system prompt made it answer the instructions instead of the person,
so it gets no system prompt, no tools and no background title/fact/summary jobs. A fine-tuned build sets
`tools: true` in MODELS and gets the harness. Gemma 3 has no tool
format, so tools are prompt-based ```tool_call JSON blocks (docs/harness.md, "Small-model format";
the fine-tune in lm-experiments trains on that exact text). No tool names go in prose: the model looks
tools up with `find` (answered by the agent) and sees details only for tools it found. The cloud model stays
available on phones. `cleanupStorage` frees downloads of models that aren't offered or don't fit.
Loads and replies write a crash marker with the current step, shown on the next open.
Two experimental settings for wllama models (off by default): "Use the GPU" (`smallGpu`: wllama 3.8's WebGPU,
`n_gpu_layers: 999`) and "Use all CPU cores" (`smallThreads`: `n_threads` up to 4; needs a cross-origin isolated
page, which sw.js does by adding COOP/COEP/CORP to the app's own responses while the `squiggle-flags` cache holds
`/__flags/isolate`; takes a reload). A crash with either on offers to turn them off. The composer note shows what's in
use (GPU / N cores / Safari's slower compatibility build, which wllama picks when JSPI or Memory64 is missing) and the last
reply's speed. Size-test models (Q06, LF12, LL1) are plain chat. TG4A is tiny Gemma 4 heal 4 pilot A (same runtime and size as TG4; trained on Toucan tool conversations, answers from tool results). It was trained without thinking, so it sets `thinking: false` in MODELS and `conversation()` never turns thinking on for it (with thinking on it re-calls the tool instead of answering from the result). TG4 (tiny Gemma 4, lm-experiments experiments/tiny-gemma4, distilled from E2B) sets `native: true`: wllama loads it with `jinja: true` and `NativeConversation` sends real `tools` through the GGUF's own Gemma 4 chat template, reading back llama.cpp's parsed `tool_calls`; the agent gives it E2B's system prompt, but small-model budgets and no background jobs. Its tools are gated (`agent.js gated()`, docs/harness.md "Tool names up front"): a few declared up front, the rest listed by name and declared when `tool_info(names)` or `find` asks for them, since every schema filled ~83% of a 4K window. Settings → Small-model mode (per model, `settings.smallMode`) switches any model with tools except the fenced-format ones (always on) to the find-first `LITE_SYSTEM_NATIVE` prompt (docs/harness.md). Q35 (stock Qwen3.5 0.8B, unsloth's Q4_0 GGUF) uses the same native path with Qwen's own template. `node tests/e2e/wllama-bench.mjs [--model SQ]` loads a
real model in headless Chromium: one thread vs all cores vs WebGPU.

WebLLM (`engine-webllm.js`, @mlc-ai/web-llm 0.2.87 from jsDelivr): WL1 (Llama 3.2 1B, chat only), WQ06 (Qwen3 0.6B) and
WQ35 (Qwen3.5 0.8B) are MLC builds on WebGPU. They keep `runtime: 'wllama'` (so isLite, chatOnly, nativeTools and the
small-model harness apply) and add `backend: 'webllm'` + `mlc`. `createShim` gives Conversation/NativeConversation the
slice of wllama's API they use; WebLLM has no jinja, so for native models it renders Qwen's tool block into the system
prompt (`toolFormat` 'qwen3' JSON or 'qwen35' XML), sends results as `<tool_response>` user turns and parses
`<tool_call>` back into `delta.tool_calls`. It can't continue an assistant turn, so a prefilled loop retry starts fresh. Gemma 4 (`toolFormat: 'gemma4'`, tiny Gemma's own MLC build) is different: a tool call, its results and the reply share one model turn, so the shim renders the whole prompt itself (`gemma4Prompt`, a port of Gemma 4's template pinned by `tests/fixtures/gemma4-template.json`) and sends it as a raw completion (`engine.completions.create`, stop at `<turn|>` / `<|tool_response>`), parsing `<|channel>thought…<channel|>` and `<|tool_call>call:name{…}<tool_call|>` back out. Our own builds aren't in WebLLM's prebuilt list: a model's `mlcRecord` (model URL, `model_lib` .wasm, `model_manifest`) is registered (`registerModel`) and passed as `appConfig`.
q4f16 needs `shader-f16`, else the q4f32 build. WebLLM stores files in Cache Storage `webllm/{config,model,wasm}` (sw.js
keeps them); "download" loads once and unloads. Measured on an iPhone with `app/memtest.html` (2026-11-02, ~2 GB tab
budget shared by JS and GPU memory): Llama 3.2 1B ~30 tok/s and ~1.3 GB vs wllama CPU ~2.6 tok/s and ~0.6 GB; Qwen3 0.6B
~34 tok/s; Qwen3.5 0.8B ~14 tok/s; Qwen3.5 2B loaded but died on its first reply. The GPU/cores toggles don't apply.

## Cloud model (engine-cloud.js, worker /api/ai/*)

- Gemma 4 26B A4B on Workers AI via the relay; off unless the Worker has the AI binding, the
  AI_BUDGET Durable Object and AI_USERS (GitHub logins, checked with the caller's token).
- Hard cap: each request reserves its worst-case neurons first; refused (429, error 'limit') when
  that would pass AI_DAILY_NEURONS (default 9000, clamped to 9900 — under the free 10,000/day).
  Settled with the real `usage.neurons` afterwards. Resets 00:00 UTC, like Cloudflare's.
- The app shows the limit as a plain message; it never retries or falls back to billing.
