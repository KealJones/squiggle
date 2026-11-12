# Squiggle — notes for engineers and coding agents

A browser-only agent: LFM3 1.7B on WebLLM (WebGPU, our own MLC build) on phones and computers, or its GGUF on the
CPU (wllama) without WebGPU (`engine.DEFAULTS`, 2026-11-10); optionally Gemma 4 26B on the relay's Workers AI. Keal's
own Squiggle Small and Tiny Gemma 4 stay as experimental options; every other model was removed (2026-11-10), the
runtimes (LiteRT, wllama, WebLLM) and tool formats stay so adding one is a registry entry. State is
synced through a private GitHub "storage repo", via a Cloudflare Worker that relays GitHub requests browsers
can't make (device-flow login, git smart-HTTP). The app is static: either the Worker serves it (wrangler.toml,
relay same-origin at /api) or GitHub Pages does (deploy.yml writes config.json with the relay URL;
wrangler.relay.toml deploys a relay-only Worker that allows the Pages origin). Demo mode runs the same app
with storage in the browser only and no sign-in (demo.js). There's no lab mode any more: each chat picks its model and
context type before its first message (chat.js `newChatSettings`); docs/lab.md is the notebook of experiments.

## Layout

```
app/                    static app, plain ES modules, no build step
  index.html styles.css sandbox.html sw.js manifest.webmanifest
  vendor/               bundled libs (isomorphic-git, lightning-fs, marked, DOMPurify) — `npm run vendor`
  src/
    main.js             entry: settings, config, sign-in state → setup wizard or the app (or the demo)
    demo.js             demo mode: local-only storage (storage.js useLocalStorage), seeded sample chat/facts/file, the "Try" prompts, clearSamples
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
      voice-ui.js       read aloud, voice calls (call bar)
      links.js          chat links: the open chat's id in the URL hash (#chat=<id>); a link opens that chat if this account has it (else the usual one, after the first sync), back/forward between chats, Copy link in the sidebar
    agent.js            turn loop (docs/harness.md): chat phase → plan → one fresh prompt per step → final reply; ask_user (need for Squiggle Small)/find; recipes learned after
    tasks.js            step-mode task state, step/final prompts (budgeted), resume rules, DIALECT (v2 frozen fenced text / v3 harness text kept out of user turns in steps)
    recipes.js          memory/recipes.jsonl: how finished tasks were solved; saved pending, matched only once the user approves; forgotten after 90 days unused
    find.js             `find`: one search over tools, recipes, memory, past chats and this task; web reranking, URL ledger, pushback check (falls through to web_search, docs/harness.md)
    trace.js            the whole context a turn sent (each conversation's system prompt, tool schemas, messages, every round in and out, the exact prompt text where our code renders it), saved per reply as prompts/<session>/<id>.json and shown in "What the model saw"
    refs.js             reference resolution ("that", "the repo", links) → hints in the prompt
    engine.js           model registry (families, generationFor: sampling/thinking/thinkBudget per model), download (resumable, IndexedDB chunks), LiteRT engine, generation
    engine-cloud.js     cloud model through the relay (same conversation interface)
    engine-wllama.js    Gemma 3 270M on llama.cpp WASM (phones): prompt-based tools, <think>, anti-loop
    context.js          context assembly: CONTEXT_MODES registry (smart default / compact / managed / full); report
    prefetch.js         Fresh context (experimental): the lookup before the model answers (question made standalone, saved exchanges/pages/memory, web), handed over as a seeded find call (docs/harness.md "Fresh context")
    recall.js           smart mode's recalled block: earlier messages (this chat + other chats) and memory, quoted after the request; time phrases, size caps
    search.js           BM25 (light stemmer: -ing/-ies/-ed/-s and a trailing e) + blend with optional embeddings (embed.js, MiniLM on CPU in embed-worker.js, terminated after 15 s idle on phones / 3 min on computers so its memory is freed)
    engine-webllm.js    WebLLM (MLC on WebGPU) under engine-wllama.js's conversations; per-model WebLLM version (`webllm`); streams any tool format
    toolformats/        how each model family's template writes tools, calls and results, for WebLLM (docs/extending.md "Tool formats")
      index.js          the registry and the format interface; text.js: shared <think> split and marker hold-back
      qwen.js gemma4.js lfm2.js   Qwen3/Qwen3.5 (chat API), Gemma 4 and LFM2 (raw prompts; fixtures pin them to the real templates)
    tools.js            facade over tools/ (keeps the import path)
    tools/              agent tools (docs/extending.md)
      registry.js       defineTool/registerTool, toolSpecs, runTool: the extension point
      index.js          registers the built-ins in a fixed order (the order is prompt text for small models)
      workspace.js      /home, /repos and /web path mapping shared by the tools
      files.js notes.js git.js web.js memory.js compute.js   the tools by area (compute.js hosts the run_js sandbox)
      bash.js           `bash` (lab, settings.toolSurface 'bash'): just-bash (app/vendor/just-bash.js) on the workspace through WorkspaceFs (/home via storage.js so it syncs, /repos and /web via LightningFS, everything else in memory); custom commands git, gh, curl, search, wiki, node, bc call the tools above (approvals and URL rules kept); `man` / `--help` document them
      gitcli.js ghcli.js diff.js   bash's `git` and `gh`, behaving like the real ones (2026-11-12; models know them): real staging (add, then commit; -a), git's own output formats (status, diff, log, show, branch, …), most subcommands and their usual options (`git --help`, `gh --help` list them); runs on isomorphic-git with everything injected, so tests/gitcli.test.js runs it on real repos in Node. Status re-hashes files Squiggle wrote and "racy" ones (changed no earlier than the index), since a size-and-seconds check misses same-size edits. Pushes, pulls and clones still go through git_push/git_pull/git_clone (push policy, never forced; `git push origin <other branch>` passes `pushBranch` in the call context, not as a model-facing parameter). gh: pr/issue/repo/run/workflow/release/search/api/auth with --json/--jq (jq via just-bash's ctx.exec); `gh pr merge`, deleting a branch on GitHub and any `gh api` that isn't a read ask the user (approval card kind 'action'); the storage repo is refused by name (owner/name, -R, search, graphql) and /repositories/<id>. diff.js: Myers line diff in git's unified format (matches `git diff --diff-algorithm=myers` on 275 of 282 random cases; the rest differ only in where a repeated line is shown) and --stat
      wiki.js           wiki_lookup: Wikipedia search → article + Wikidata item → every fact (ranked by the question via property aliases) and newest links, straight from the browser (CORS); wikidata_query: raw SPARQL, big models only (agent.js BIG_ONLY)
    calc.js             `calculate` tool: safe math expression parser (no eval), % and money-friendly
    guard.js            hard limits: push policy, workflow-file check, workspace path resolution
    grants.js           remembered "always allow" push grants (synced)
    untrusted.js        <untrusted key=…> wrapping for outside content
    attachments.js      chat attachments: limits, text extraction (pdf.js, Tesseract.js OCR from jsDelivr), what the model sees
    ocr.js              text in images (screenshots, receipts, signs) via Tesseract.js 5.1.1; worker freed after 20 s idle
    voice.js            voice calls: markdown → speakable chunks, call state machine, system speech speaker
    storage.js          storage repo: setup, clone at /state, client-side rebase sync
    merge.js            conflict-free merges (sessions JSON, .jsonl)
    sessions.js         sessions + threads + observations on top of storage
    memory.js           fact graph (memory/facts.jsonl), recall with 1-hop expansion (through specific entities only)
    memory-rank.js      the pure parts of memory: rankFacts (absolute relevance, search.js overlap), aboutTheUser (extraction guard)
    github.js           device flow, token refresh, REST helpers (token never leaves here)
    git.js              LightningFS + isomorphic-git wiring
    config.js           relay address: config.json / per-device override / same-origin
    util.js             ids, kv (IndexedDB), emitter, mutex
worker/index.js         relay + static assets (wrangler.toml); cloud model route + AiBudget Durable Object
tests/*.test.js         unit tests (node --test)
tests/e2e/              Chromium end-to-end: real git server, real Worker code, scripted model
tests/eval/             retrieval.mjs: memory-recall benchmark (no model); run.mjs + cases.json: the failure casebook against a real model (docs/evals.md)
docs/                   harness.md (the agent loop contract), failures.md (casebook), evals.md, lab.md (experiments notebook), setup.md, extending.md, measurements-*.md
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
- Writes reach IndexedDB promptly. LightningFS keeps the file tree in memory and saves it only after 500 ms
  idle; storage.js persists after every sync and at most every 300 ms while writes keep coming (git.js
  `persist` = `pfs.flush`), and app.js `settle()` flushes chats and memory and persists on hide/pagehide. In
  demo mode the browser is the only copy.
- The bash surface (`agent.bashSurface()`): the model gets `bash` and `remember` plus the harness tools instead of the
  file, web, git and maths tools. Commands that reach the network, GitHub or the sandbox go through `runTool` with the
  agent's context, so a push still needs the approval card and curl fetches any URL (the allowed-URL check stays on fetch_url for the two fine-tunes); the whole output is
  wrapped as untrusted; `.git` stays unreachable (`guard.resolveAgentPath`).
- Demo mode (`storage.isLocal()`): the git and GitHub tools are left out of the model's list (agent.js
  `modelTools`), the cloud model isn't offered, the system prompt says so. Signing in later carries the local
  files into the chosen repo (`useStorage` snapshot/restore, merging sessions and .jsonl the repo has).

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
messages[{id, role, content, ts, mts?, thread, tools?, context?, model?, pinned?, deleted?, attachments?[{name, path, type, size, chars, lines?, error?}]}],
threads{id: {parent, title, summary?}}, observations[], summaries{main|threadId} }`.
`deleted`/`archived` on the session and `deleted` on a message are tombstones (content emptied) so the change
syncs; `sessions.list()` leaves archived chats out (`listArchived`), `lineMessages` leaves deleted messages out.
`model` on the session is the chat's own model: `ui/model-ui.js sessionModel()` picks it over `settings.defaultModel` (the
device default from Settings) and `settings.model` is whatever is loaded right now. `contextMode` on the session
works the same way (`sessionContextMode` / `useSessionContext`, applied with the model when a chat opens and before
each turn; `settings.defaultContextMode` is the saved default, `settings.contextMode` the mode in effect). `model` on a reply is which
model wrote it (`agent.js replyModel`: `{ id, label, how, smallMode?, contextSize, contextMode }`). A session seeded by the
demo carries `demo: true` (demo.js `clearSamples` removes those).
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
Prompts come in two dialects (`tasks.js DIALECT`, `agent.dialect()`): v2 is the fenced small-model format,
Squiggle Small's training text, frozen; v3 (every other model) keeps harness text out of user turns in step mode and the final reply (the
instruction ends the system prompt, a nudge restarts the step; the chat phase still marks its few added lines
"(Squiggle: …)") and retitles the memory section, because models read harness text in the user turn as the
person's words. The ask tool is `ask_user` for v3, `need` for v2. Memory recall uses an absolute bar (`memory-rank.js`), never hops through
"user"/"Squiggle", and `aboutTheUser` keeps facts about the assistant itself out. Sampling, thinking and a
thinking budget come from each model's card (`engine.generationFor`); replies save which model wrote them.
Context modes (`settings.contextMode`, `context.js CONTEXT_MODES`): `compact` (Compress), `smart` (default), `fresh` (experimental: nothing replayed, a lookup first, seeded as a find call where `engine.seedsToolHistory()`; prefetch.js) and `managed` (AI-managed,
experimental: budget line, plan steps with `needs`/`kind: 'summarize'`, `checkpoint`). Everything AI-managed adds
is behind `managed()`; the other modes must stay unchanged (Squiggle Small's prompt is its training text).
The registry drives the Settings dropdown and the sidebar labels; `registerContextMode` adds one (docs/extending.md).

## Debug: saved tool results

Settings → Lab → "Save tool results and prompts" (`settings.debugTools`, per device, on by default since 2026-11-09; devices that
saved the old default move over once, settings.js `debugToolsOn`). It also saves the whole context each reply sent (trace.js):
agent.js `open()` records every conversation (chat phase, each step, the final reply) and `respond()` every round; WebLLM's raw
formats note the exact prompt text (`noteRendered`), the chat-API formats the messages handed to WebLLM's template; llama.cpp and
LiteRT render inside the runtime, so for those the structured payload is the record. The file is `reply.trace`
(`prompts/<session>/<id>.json` in the storage repo, one per reply, never merged), loaded by "What the model saw" with a
"Copy all as text" button. And each tool call on a
reply keeps what it returned (`tools[].result`, untrusted wrappers stripped, cut at 12,000 characters), shown
under "Result" in the tool list and synced with the session file. Web searches say which provider answered
(the relay's `source`: langsearch, tavily, tavily (past year), duckduckgo, wikipedia) in the label.

## Incidents (incidents.js): read these before asking Keal what happened

Problems are written to the storage repo (KealJones/squiggle-state) as they happen, one JSON line each in
`debug/incidents.jsonl` (the last 200; app.js `saveIncident`), so a crash can be looked at without a screenshot:
`gpu-lost` (engine-webllm `revive`: Safari's reason and message, the first uncaught GPU error, GPU memory held at
the loss, whether the reload got a GPU back, how many tries), `reply-error` (agent.js: the message the user saw,
chat and reply ids, the trace file with the exact prompt, the context window), `tab-killed` (model-ui.js, on the
next open: the crash marker, i.e. the stage, chat, window and GPU memory when the reply started, plus the last
prompt sent, saved as `debug/incidents/<id>.txt`) and `load-failed`, and `sync-failed` (storage.js, once per new error; it arrives with the first sync that works). Every line has the user agent, uptime and
`gpu: { bytes, peak, atLoss }`, the WebGPU buffer bytes this page holds (`trackBuffers`): Safari has no API for a
tab's memory, and the GPU shares the iPhone tab's ~1.9 GB, so that's the level to compare against. Lines reach
GitHub with the next sync.

## Voice (voice.js)

- Speech-to-text is the Web Speech API; text-to-speech is the browser's own speech synthesis
  (`systemSpeaker`, best installed voice via `pickVoice`, or the one picked in Settings).
- Read aloud: the speaker button under a reply (`voice.readAloud`) uses the same voice.
- An on-device neural voice (Kokoro-82M / KittenTTS on ONNX Runtime Web) used to live here; it was
  removed (Nov 2026); calls use system voices only. `settings.js` drops its old settings and
  crash marker once, and sw.js frees its `squiggle-tts-v1` cache.

## Failure casebook (docs/failures.md)

Every fix that comes from something a model did gets an entry: what it was asked, what it did (the chat id in the
storage repo, the tool calls, the model by name), why that's a bad choice, the good answer, the fix, and the test
that catches it (tests/failures.test.js is named after the cases; "not covered" is allowed, a missing line isn't).
Never put the bad answers in a model's prompt or fine-tune on them; they're the rejected half of preference pairs.

## Verifying changes

`npm run check` (ESLint + unit tests), `npm run test:e2e` and `npm run test:e2e:split`
(app and relay on different origins; set `PLAYWRIGHT_BROWSERS_PATH` if needed; `E2E_ONLY=<part of a
check name>` runs a subset). The e2e suite swaps `src/engine.js` for `tests/e2e/fake-engine.js` and
stubs the Web Speech API; real-model behaviour needs a WebGPU device and is checked by hand.

## Phones

iOS Safari kills tabs that load Gemma 4 E2B/E4B, and smaller ONNX models (tried and removed:
Gemma 3, SmolLM, a QAT E2B build on onnxruntime-web) failed on WebGPU readback. The defaults are `engine.DEFAULTS`
(one place to change): LFM3 1.7B everywhere since 2026-11-10 (settings.js `lfm3Default` moves devices on an old default
once). A model can have several builds (`engine.GROUPS`, `group` on each MODELS entry): LFM3 is `WLF3QAD` (WebLLM,
q4f16, `f16Only`) then `LF3` (GGUF on wllama, CPU). The user picks the model; `engine.forDevice` picks the first build
that runs here (`runsHere`: WebGPU for GPU builds, shader-f16 for f16-only ones after `probeGpu`, not in
`settings.avoidBuilds`), and that one build is the only one listed. `initModel` resolves the saved model to it,
`sessionModel` resolves a chat saved on another device to it, and `cleanupStorage` frees the other build's download.
A crash on the GPU build offers "Run it on the CPU instead", which adds it to `avoidBuilds` (Settings → "Try the GPU
again" clears it). Settings shows how it runs (`engine.runnerLabel`) instead of asking. There are no context-size,
small-model, no-prompt, tool-surface, GPU or cores settings (settings.js `simplified` clears what older versions saved):
each model gets `engine.contextFor` (its `maxContext`, else 16K), small models always get the small-model prompt, and
bash is the tool surface wherever `agent.bashSurface()` allows (LFM3 and the cloud model; the two fine-tunes keep the
separate tools they were trained on). Context type is per chat, picked before the first message and fixed after
(`session.contextMode`, set at the first send), Compress by default (settings.js `compactDefault`: until 2026-11-11 a new browser ran the old `harnessV2` step after `simplified` and landed on Smart); the model can still switch in the chat details. Squiggle Small (`SQ`, LFM2.5-350M fine-tuned on the
harness format, lm-experiments experiments/squiggle-ft, kealjones/squiggle-small, Q4_0 GGUF 219 MB) is an experimental option.
The models are LFM3 (two builds), Squiggle Small (`SQ`), Tiny Gemma 4 (`TG4A`) and the cloud model; there's no lab
mode (`engine.listedModels`; a device that already picked one keeps it).
Gemma 3 270M (`G3`, unsloth's Q4_0 GGUF, 242 MB) stays as an option. Both run on wllama 3.13.0, CPU only
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
CPU builds use several cores automatically (`settings.smallThreads`, on by default since 2026-11-10, `autoThreads`
flips old devices once): `n_threads` up to 4 needs a cross-origin isolated page, which sw.js does by adding
COOP/COEP/CORP to the app's own responses while the `squiggle-flags` cache holds `/__flags/isolate`; `initModel` sets
that flag when the device lands on a CPU build, effective from the next open. A crash with it on offers to turn it
off. llama.cpp's own WebGPU path (`smallGpu`) is off; the WebLLM builds are the GPU path. A leftover crash marker
next to a `squiggle-page-left` note (written on pagehide / hidden) means the page was left, not crashed: it reloads
quietly. A first real crash leads with Try again; stepping down leads after two in a row (`squiggle-crashes`). The composer note shows what's in
use (GPU / N cores / Safari's slower compatibility build, which wllama picks when JSPI or Memory64 is missing) and the last
reply's speed. CPU loads use an 8-bit KV cache with flash attention and n_batch 512 / n_ubatch 256 (`engine-wllama.js
createEngine`, plain retry on failure). TG4A (Tiny Gemma 4, heal 4 pilot A: trained on Toucan tool conversations,
answers from tool results) was trained without thinking, so it sets `thinking: false` in MODELS and `conversation()`
never turns thinking on for it. Native-tool models (`native: true`: wllama with `jinja: true` and the GGUF's own
template, or WebLLM with a `toolFormat`) get gated tools (`agent.js gated()`, docs/harness.md "Tool names up front"):
a few declared up front, the rest by name until `tool_info(names)` or `find` asks. Small models always get the short
small-model prompt (`LITE_SYSTEM_NATIVE`, or `LITE_SYSTEM_BASH` on the bash surface; Squiggle Small its fenced v2
text) and a thinking budget (400 reasoning tokens, `engine.generationFor`). At the budget a native model's thinking is kept and closed with a decision in its own words (`ENOUGH_THINKING`, passed as `think_prefill` to runtimes whose `info.closesThinking`: WebLLM raw formats with `thinkOpen`/`thinkClose`, i.e. LFM3); runtimes that can't continue a turn still re-ask with thinking off. Before 2026-11-11 LFM3 always re-asked cold and re-argued its thinking in the reply. The small-model prompts also say to stop after three options or attempts. The removed models (Gemma 4 E2B/E4B,
Gemma 3 270M, Qwen3/Qwen3.5, Llama 3.2, LFM2.5 1.2B, LFM3's test builds) and what was learned from them are in
docs/lab.md and docs/measurements-*.md. `node tests/e2e/wllama-bench.mjs [--model SQ]` loads a
real model in headless Chromium: one thread vs all cores vs WebGPU.

WebLLM (`engine-webllm.js`, @mlc-ai/web-llm 0.2.87 from jsDelivr by default; a model can name another with `webllm`, loaded
side by side as its own module, since a build's .wasm carries its TVM runtime and WebLLM's JS must match it): WL1 (Llama 3.2 1B,
chat only), WQ06 (Qwen3 0.6B), WQ35 (Qwen3.5 0.8B), WLF3 (LFM3 1.7B, our own MLC build from lm-experiments experiments/lfm3-mlc: q4f16_1 at kealjones/LFM3-1.7B-q4f16_1-MLC, WebLLM 0.2.87, `toolformats/lfm3.js`; the shipped build is WLF3QAD,
with a q4f32_1 twin (`mlcRecordF32`, job lfm3-mlc-9) for GPUs without shader-f16; runs on an iPhone in Squiggle at 13.7 tok/s, first word in 15 s, 2026-11-10; memtest's 3K-token prompt kills the tab while answering; the 3-bit build WLF3Q3 runs but overthinks even a greeting, so 4-bit it is; WLF3QAD is the same model with Liquid's quantization-aware-trained 4-bit weights copied in exactly and a one-sequence model library, ~150 MB less scratch) and WLF12 (LFM2.5 1.2B Instruct, naklitechie's community build on WebLLM
0.2.86, `maxContext: 4096`, tools in LFM2's own format via `toolformats/lfm2.js`: Pythonic calls in `<|tool_call_start|>[…]`,
results in a `tool` turn, raw prompts with `<|startoftext|>` added since WebLLM only adds BOS on its manifest path; card sampling
temperature 0.1, repeat 1.05) are MLC builds on WebGPU. They keep `runtime: 'wllama'` (so isLite, chatOnly, nativeTools and the
small-model harness apply) and add `backend: 'webllm'` + `mlc`. `createShim` gives Conversation/NativeConversation the
slice of wllama's API they use; WebLLM has no jinja, so each native model names a tool format (`toolFormat`, a module in
`toolformats/`). The Qwen formats render Qwen's tool block into the system
prompt (`toolFormat` 'qwen3' JSON or 'qwen35' XML), sends results as `<tool_response>` user turns and parses
`<tool_call>` back into `delta.tool_calls`. It can't continue an assistant turn, so a prefilled loop retry starts fresh. Gemma 4 (`toolFormat: 'gemma4'`, tiny Gemma's own MLC build) is different: a tool call, its results and the reply share one model turn, so the shim renders the whole prompt itself (`gemma4Prompt`, a port of Gemma 4's template pinned by `tests/fixtures/gemma4-template.json`) and sends it as a raw completion (`engine.completions.create`, stop at `<turn|>` / `<|tool_response>`), parsing `<|channel>thought…<channel|>` and `<|tool_call>call:name{…}<tool_call|>` back out. A lost GPU device (iOS 27 Safari drops it with the tab still open: locking, switching apps, memory pressure) makes WebLLM's TVM runtime dispose itself, and every later call throws "Object has already been disposed"; the shim (`gpuGone`, `revive`) loads the model again from WebLLM's cache and retries the reply if none of it was shown yet, otherwise says so and the next message works; the error names Safari's reason (`gpuLossDetail`). The loss is caught before the next message too: the watcher keeps one record per device and tells the shim when *its* device goes (`deviceWatch.onLost`), and it reloads as soon as the page shows (`whenVisible`); every send waits for that (`ready`). Right after Safari's GPU process dies, `requestAdapter` can come back empty ("Unable to find a compatible GPU", `noAdapter`), so the reload keeps asking for ~11 s (`REVIVE_WAITS`); if it never gets one the engine stays marked stale and the next send tries again instead of hitting the unloaded engine ("Model not loaded", Keal's iPhone 2026-11-11). Why iOS 27 loses it at all: WebKit 325185 kills Safari's GPU process when one command buffer runs or waits more than ~3 s, and WebLLM queues a prompt's prefill pieces (256 tokens in our LFM3 builds, ~2.5 s each on an iPhone 16) without waiting (onnxruntime#33753 is the same crash). On phones (`pacedGpu`: WebKit, and Android since 2026-11-11, where nothing kills the long work and the whole phone's screen stalled behind it instead, Greg's phone in Chrome) `paceGpu` makes the pieces 128 tokens, syncs after each one and leaves a frame-long gap (`PACED_GAP_MS`) after each prompt piece so the system can draw, reaching into WebLLM's pipeline (`loadedModelIdToPipeline`, `prefillChunkSize`, `embedAndForward`, `sync`); confirmed on Keal's iPhone (iOS 27.2.1, 2026-11-11), where memcap still measures the same ~1.9 GB tab budget as on iOS 26. Our own builds aren't in WebLLM's prebuilt list: a model's `mlcRecord` (model URL, `model_lib` .wasm, `model_manifest`) is registered (`registerModel`) and passed as `appConfig`.
q4f16 needs `shader-f16`, else the q4f32 build. WebLLM stores files in Cache Storage `webllm/{config,model,wasm}` (sw.js
keeps them); "download" loads once and unloads. Measured on an iPhone with `app/memtest.html` (2026-11-02, ~2 GB tab
budget shared by JS and GPU memory): Llama 3.2 1B ~30 tok/s and ~1.3 GB vs wllama CPU ~2.6 tok/s and ~0.6 GB; Qwen3 0.6B
~34 tok/s; Qwen3.5 0.8B ~14 tok/s; Qwen3.5 2B loaded but died on its first reply. The GPU/cores toggles don't apply.
memtest.html also covers the LFM2 family (LFM2.5 350M, LFM2 700M, LFM2.5 1.2B Instruct and Thinking, LFM3 1.7B) on every runtime
each has a build for: wllama GGUFs, a community WebLLM build of the 1.2B Instruct (naklitechie, 4K max, q4f16 only) and
transformers.js ONNX on WebGPU (`onnx` engine; 4.3.2, or the version a model names in `transformers`: LFM3 needs 4.4.0-next.0). That WebLLM build's runtime predates TVM's Oct 2026 changes (`runtime.TVMTensor*` names, 3-value device groups for the VM), so memtest loads it with WebLLM 0.2.86 (`mlcRecord.webllm`); 0.2.87 fails on it ("Cannot find global function runtime.TensorAllocWithScope", then `vm.cc` "args.size() % 3 == 0" if the names are patched). In headless Chromium 0.2.86 loads it through VM and hybrid KV + RNN state setup and stops only at the f16 shaders SwiftShader can't compile. LFM2 keeps a KV cache in only 6 of its 16 layers (~12 KB a token vs
~112 KB for Qwen3 0.6B at 16-bit), so a context choice (2K/4K/8K) and a prompt that fills 3/4 of the window are there to
measure what a full window costs; the auto run skips bigger models only within a family (`family`: transformer / lfm).

## Cloud model (engine-cloud.js, worker /api/ai/*)

- Gemma 4 26B A4B on Workers AI via the relay; off unless the Worker has the AI binding, the
  AI_BUDGET Durable Object and AI_USERS (GitHub logins, checked with the caller's token).
- Hard cap: each request reserves its worst-case neurons first; refused (429, error 'limit') when
  that would pass AI_DAILY_NEURONS (default 9000, clamped to 9900 — under the free 10,000/day).
  Settled with the real `usage.neurons` afterwards. Resets 00:00 UTC, like Cloudflare's.
- The app shows the limit as a plain message; it never retries or falls back to billing.
