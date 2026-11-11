# Lab notebook

Every experiment Squiggle has run, in one place: the idea, what happened, where the evidence is, and what it
became. Things that worked are in the app; things that half-worked are behind **lab mode** (Settings → Lab, or
`?lab=1`), where the research models and the experimental switches live; things that failed are listed with
why, so they aren't tried twice. Dates are when the result landed; the commit history has the rest.

Shorthand: *shipped* = on for everyone; *lab* = in the app, listed only in lab mode; *removed* = gone from the
app, kept here.

## Models

### Squiggle Small: a 350M model fine-tuned on the harness — shipped (experimental option)

**Idea.** The smallest model that can use tools at all is one trained on exactly the text the harness sends:
a 130-token system prompt, tool calls as fenced ```tool_call blocks, `plan` / `done` / `need` / `find` as the
only tools it knows by name, and `find` to look the rest up. LFM2.5-350M, trained in
[lm-experiments](https://github.com/KealJones/lm-experiments) `experiments/squiggle-ft/`, published at
`kealjones/squiggle-small` (Q4_0 GGUF, 219 MB), runs on a phone's CPU with no WebGPU.

**What happened.** It calls tools and looks things up, which stock Gemma 3 270M (the control) can't do at all.
It is also often wrong, and the fenced format has to be parsed by hand (`engine-wllama.js`). The prompt it
was trained on is frozen as dialect v2 in `tasks.js`: every other model gets v3, which marks harness text so
it isn't read as the person talking.

**Evidence.** docs/harness.md "Small-model format" and "What the fine-tune should learn"; docs/measurements-2026-11-04.md
(430 tokens of fixed prompt, 10% of a 4K window, against 1,662 for a stock small model with native tools).

**Verdict.** The right shape (a model that knows the habits, not the world), not yet the right model. The
failure casebook's preference pairs are the training data for the next one.

### Tiny Gemma 4: Gemma 4 E2B pruned to a 0.6B core and healed — shipped (experimental option)

**Idea.** Keep Gemma 4's tool format and manners but make it fit a phone: cut the vocabulary to 80K, the hidden
size to 1024, the FFN to 42%, 31 layers, then heal by distillation from E2B's own answers (heal 3), then train
on multi-turn tool conversations with real results (heal 4, Toucan). `lm-experiments experiments/tiny-gemma4`.

**What happened.** Heal 3 answered short questions and called Gemma 4's tools but replied with nothing after a
tool result. Heal 4 answers from the result and handles a failed search; plain answers got a little worse.
Thinking had to be turned off for it (with thinking on it re-called the tool instead of answering).

**Evidence.** `engine.js` TG4 / TG4A notes; tests/fixtures/gemma4-template.json pins the template the WebLLM
build renders.

**Verdict.** Proof that the pruning and healing pipeline works end to end in the browser; quality is behind
the stock 0.6–1.2B models. Heal 3 is lab-only now; heal 4 stays as an option.

### Running the phone model somewhere Claude can test it — not yet

**Idea.** Run LFM2.5 1.2B where an agent without WebGPU can drive the real app against it (the eval runner).
Cloudflare's bring-your-own-model for Workers AI (Cog containers) is for Enterprise accounts, so that's out.
The CPU build on wllama (`LF12`, now with tools on the native llama.cpp path) works in headless Chromium.

**What happened (2026-11-09).** It downloaded and loaded in 17 s on a 2-core cloud box, and Fresh's lookup named
`git_clone` for "pull github.com/tester/app" as intended; then 22 minutes at 100% of one core without a first
token. One WASM thread on that box is far too slow for a ~1,500-token prompt.

**Next.** Native llama.cpp (`llama-server`, OpenAI-compatible, many times faster than WASM) behind a lab runtime
that talks to a local server; the same runtime would let a Mac point Squiggle at LM Studio or Ollama.

### Which model fits a phone tab — shipped as the defaults

**Idea.** iOS Safari kills a tab at roughly 2 GB, shared by JS and GPU memory. Which runtime and size survive,
and at what speed? Measured with `app/memtest.html` on an iPhone 16 and `tests/e2e/wllama-bench.mjs` in
headless Chromium.

**What happened.** Gemma 4 E2B/E4B on LiteRT: killed. ONNX exports (Gemma 3, SmolLM, a QAT E2B) on
onnxruntime-web: failed on WebGPU readback, and on WASM the 4-bit export needs an op the build lacks. wllama
(llama.cpp WASM, CPU): Gemma 3 270M and Squiggle Small at 0.6 GB and ~2.6 tok/s; Llama 3.2 1B loaded, answered
once, then stopped. WebLLM (MLC, WebGPU): Llama 3.2 1B ~30 tok/s at ~1.3 GB; Qwen3 0.6B ~34 tok/s; Qwen3.5 0.8B
~14 tok/s; LFM2.5 1.2B ~19 tok/s with a KV cache in only 6 of 16 layers; Qwen3.5 2B loaded and died on its
first reply. An 8-bit KV cache with flash attention saves 300 MB on Qwen3 0.6B.

**Evidence.** CLAUDE.md "Phones"; docs/measurements-2026-11-04.md; the memtest page itself.

**Verdict.** Phone default: LFM2.5 1.2B on WebLLM where WebGPU exists, Squiggle Small on the CPU where it
doesn't; Gemma 4 E4B on computers. The size-test models (Llama 3.2 1B, LFM2.5 1.2B on the CPU, Qwen3 0.6B /
0.8B on either runtime, Gemma 3 270M) are lab-only. LFM3 1.7B (the first Liquid model trained for agent
harnesses, 2026-11-09) is in lab as a test: it picks tools sensibly where LFM2.5 didn't, but it's 1 GB on the
CPU and thinks before every reply; an MLC build would make it a candidate for the phone default.

## Prompts and context

### Tool names up front, schemas on demand — shipped for small models

**Idea.** With every tool schema declared, a stock small model's fixed prompt was 1,500–4,000 tokens: 37–99% of
a 4K window, two minutes to the first token on a phone CPU. Declare a few tools up front and list the rest by
name; the model asks for a schema with `tool_info(names)` or gets it from `find`.

**What happened.** The fixed prompt dropped to ~1,200 tokens for the stock small models; Qwen3.5 0.8B went from
four web searches for "15% of 240" to one `calculate` call. The small models still searched instead of
answering for "who is the prime minister" and hallucinated after.

**Evidence.** docs/measurements-2026-11-04.md (the before/after tables); docs/harness.md "Tool names up front".

### Small-model mode: the short find-first prompt for any model — shipped (per-model switch)

**Idea.** The short prompt trained for Squiggle Small ("don't guess, find it") might suit stock small models
better than the full prompt. On by default for small models, off for big ones, switchable per model.

**What happened.** Better for every model on the wllama runtime (the full prompt plus every schema took half
the window and a 0.8B answered the instructions instead of the person). Gemma 4 E4B is better with the full
prompt.

### No prompt at all — lab

**Idea.** Send a model nothing of Squiggle's (no persona, no rules, no tool-names line), only its tools in its
own format and the conversation, to see how much of its behaviour is the prompt and how much is training.

**What happened.** LFM2.5 1.2B behaved the same with and without Squiggle's prompt (2026-11-09): its over-use
of tools is its training, not the prompt. That settled a question the prompt edits had been chasing.

**Verdict.** A diagnostic, not a mode; lab-only.

### Smart context: recalled messages quoted after the request — shipped (default)

**Idea.** Rather than replay the whole chat, keep a rolling summary plus the recent turns and retrieve the
earlier messages, pages and files that match the question (BM25 blended with MiniLM when "Search by meaning"
is on), quoted after the request.

**What happened.** Works for the big models. Small models read the recalled block as the user talking: Qwen3
0.6B answered recalled questions instead of the new one (docs/failures.md cases 7 and 9), and messages from
other chats leaked wrong old answers into new ones. Other chats are off by default now; harness text in the
user turn is marked "(Squiggle: …)" for every model but Squiggle Small.

**Evidence.** docs/harness.md "Smart context v2"; failures 7 and 9.

### Fresh context: look things up first, replay nothing — shipped (option)

**Idea.** Every message starts new. Before the model sees it, the agent makes the question stand on its own (a
follow-up borrows the names of the question before it), searches this chat's earlier exchanges and pages,
memory, other chats if allowed, Wikipedia/Wikidata when something is named, and the web; then hands all of it
over as a `find` call the model already made, so none of it reads as the user talking.

**What happened.** The seeded-call framing fixes the "recalled text is the user" failure for the models that
can start a conversation with a tool call (WebLLM, wllama, the cloud model); Gemma 4 on LiteRT and the fenced
format get it as a labelled system section instead. Three gaps were found and closed in use: Fresh looked up
whole requests ("help me write a generator") and the junk sent the model planning (case 14, now only
questions are looked up); "run that script" lost the script (the exchange a message points back at now comes
along in full); and a rule given for the whole chat ("answer in Spanish from now on") was gone on the next
message, since nothing is replayed (standing instructions now ride along, 2026-11-09). Questions about the
user's own things no longer go to the web.

**Evidence.** docs/harness.md "Fresh context"; tests/prefetch.test.js; the e2e Fresh check; failures 1–4, 14.

**Verdict.** The most promising direction for small windows: the model sees the question, a lookup it "made",
and nothing else. Still unmeasured against Smart on a real model, which is what `tests/eval/run.mjs` is for
(docs/evals.md). Open: the name-borrowing for follow-ups is a regex, not a model; LiteRT should get the
seeded call too.

### AI-managed context — lab

**Idea.** Let the model run its own context: a budget line on every prompt, plan steps that say which earlier
results and files they need attached, a summarize step for big pages, and a checkpoint that hands off to a
fresh context when room runs low.

**What happened.** Built end to end (docs/harness.md "The model manages its own context"), but no model has
been trained for it, and untrained small models ignore the budget line. It changes the prompt, which the
other modes must not do (Squiggle Small's prompt is its training text), so it is fenced off behind `managed()`.

**Verdict.** Lab-only until there's a fine-tune that uses it; the design doc is the spec for that fine-tune.

### Memory recall with an absolute bar — shipped

**Idea.** Rank memory facts by how much of the fact the question covers (an absolute 0–1), not by BM25
normalized to the best match, so that when nothing fits, nothing comes back; then one hop through a shared
entity, but never through "user" or "Squiggle", which sit on most facts.

**What happened.** The "Emma Stone's real name is Keal" answer (case 1) came from a relative score and a hop
through "name". The benchmark in docs/evals.md puts the absolute bar at 75% clean on unrelated questions
against 50% for normalized BM25, and find's named-only rule at 88%; it also found that the hop costs precision
on direct questions and that the stemmer had been losing "name"/"named".

## Tools and lookups

### Wikipedia and Wikidata as a general lookup — shipped

**Idea.** One tool that, for anything named, finds the article and the item and returns every fact on it
ranked by how the property's aliases match the question, plus the newest things that link to it, dated;
nothing special-cased for one kind of question. Called by the agent in Fresh's lookup and by the model in any
mode. Raw SPARQL (`wikidata_query`) for big models.

**What happened.** Checked live 2026-11-04: Jaws → Spielberg, Zig's inception, Emma Stone's birth date and
newest released film, Coca-Cola's inventor (the drink and the company are different items). Qwen3 0.6B's own
SPARQL didn't run or asked about the wrong item, so the raw query is big-models-only.

### Recipes: how a task was solved, reused — shipped

**Idea.** "Slow the first time is fine; the second time should be fast." After a planned task finishes, save the
plan and its tool calls as a recipe; `find` offers it for similar requests. Saved pending, used only once the
person approves, forgotten after 90 days unused.

**What happened.** Works as designed; injecting a recipe into the prompt unasked took over small models'
turns, so recipes are only ever looked up with `find`.

### Semantic search on the phone — shipped

**Idea.** MiniLM (23 MB) in a worker, blended with BM25, for smart context and memory recall. Phones were
thought too tight for it alongside the model.

**What happened.** The worker is terminated 15 s after a search on phones (3 min on computers), freeing its
~100 MB, so it fits; on by default everywhere now.

### One bash tool in place of the file, web, git and maths tools — lab

**Idea.** Keal, 2026-11-09: small models are bad at picking among ~20 tool schemas, and the schemas fill the
window. A shell is one tool every model has seen millions of times. `bash` (vercel-labs' just-bash) runs on the
same workspace the other tools use (/home syncs through storage.js, /repos and /web through LightningFS), with
git, gh, curl, search, wiki, node and bc as custom commands that call the existing tools, so approvals and URL
rules hold. `man` lists them, `<command> --help` explains one. The prompt tells the model its window is small
and to pipe, grep or save to a file; output that still won't fit is saved whole to /tmp/out-N.txt and the model
gets the start and the path. Settings → Lab → "One bash tool (experimental)".

**What happened.** Tool definitions shrink from ~1,250–1,600 tokens to ~720–810. On LFM2.5 1.2B (10 tasks,
tests/eval/tasks-tools.json, compact, native llama.cpp, 2026-11-10) bash passed 2 of 10 against 3 of 9 for the
regular tools (task 10 didn't run before the box restarted). It does write shell: `cat /repos/app/src/index.js`,
`wc -l`, `grep -i console /repos/app`, `git clone https://github.com/tester/app`. What sinks it is never
recovering from an error (grep on a directory without -r, a cat before the clone, `bc -d 15 % 240`), and twice
sending an empty command on "list my repos". The empty command now gets an example back (`gh repo list`).
LFM3 1.7B, trained for agent harnesses, is the real test; it needs a llama.cpp newer than llama-cpp-python
0.3.36 bundles, so its run is still to do. Results: docs/evals/WLF12-compact-bash-tasks-tools.json.

## Runtime switches

### Use the GPU / use all CPU cores for the CPU models — lab

**Idea.** wllama's WebGPU backend (`n_gpu_layers: 999`) and multi-threading (needs a cross-origin isolated page,
which the service worker arranges with COOP/COEP headers while a flag is set).

**What happened.** Both can be much faster and both can kill the tab; a crash with either on offers to turn it
off (the crash-loop guard). The WebLLM models made the GPU switch moot for phones with WebGPU.

**Verdict.** Lab-only; the WebLLM builds are the GPU path that ships.

## Test pages (deployed alongside the app)

- **`memtest.html`**: loads a chosen model on a chosen runtime (wllama, WebLLM, transformers.js ONNX) with a
  chosen context size and a prompt that fills three quarters of the window, and reports load time, tokens/s,
  JS heap and whether the tab survived. The source of every phone number above.
- **`lite.html`** (Squiggle Lite): Gemma 3 270M on the CPU in a single screen, no sign-in, no tools. The
  first thing that ran on a phone; kept as the smallest possible reference.
- **`vision.html`**: LFM2.5-VL 450M reading a photo on the phone (text and scene). Works, judged "kinda dumb";
  the on-device model that takes photos is still a goal, not a feature.

## Removed

- **On-device neural voice (Kokoro-82M / KittenTTS on ONNX Runtime Web), 2026-11.** Worked, but its memory
  had to fit alongside the model, and the device's own voices are good enough for calls and read-aloud.
  `settings.js` drops its settings once; sw.js frees its cache.
- **ONNX small models on WebGPU / WASM (Gemma 3, SmolLM, a QAT Gemma 4 E2B).** WebGPU readback failed; the
  4-bit WASM export packs embeddings with GatherBlockQuantized, which the WASM build lacks; the full-precision
  one got the tab killed.
- **Recipes injected into the prompt; other chats in smart context by default; recalled messages inside the
  user turn without a marker.** Each one made a small model answer something the person didn't ask.

### One model, picked for the device — shipped

**Idea.** Keal, 2026-11-10, after LFM3 1.7B on our WebLLM build carried the bash tool well on a phone and a desktop:
"a user should only have to pick LFM3 1.7B, not the GGUF vs GPU version for their device", and no runner settings.

**What happened.** LFM3 is one entry with two builds (`engine.GROUPS`): WebLLM q4f16 when there's WebGPU with
16-bit floats, the GGUF on the CPU otherwise. The device picks; a crash on the GPU build steps down to the CPU one
and remembers it. Settings lost the model zoo, context size, small-model mode, no-prompt, "Use the GPU" and "Use
all CPU cores": cores are automatic on the CPU path. Everything else is a lab-mode model, kept so the evals and the
casebook still reproduce. Open: a q4f32 WebLLM build of LFM3, so GPUs without 16-bit floats stay on the GPU.

### Fewer models, fewer switches — shipped

**Idea.** Keal, 2026-11-10: "too much to maintain". One model to test against everywhere (LFM3 1.7B, known to run on
an iPhone 16 and desktops), his own two models kept as experiments, the context types as the thing people play with.

**What happened.** Removed: Gemma 4 E2B/E4B, Gemma 3 270M, Qwen3 and Qwen3.5 (CPU and GPU), Llama 3.2 1B, LFM2.5
1.2B, LFM3's test builds, lab mode, and the small-model, no-prompt, tool-surface, context-size, GPU and cores
settings. Bash is LFM3's and the cloud model's tool surface, next to find, plan, done and need; Squiggle Small and
Tiny Gemma 4 keep the separate tools they were trained on. curl fetches any URL (a made-up one fails on its own); the
allowed-URL check stays on fetch_url for the two fine-tunes. Each chat picks its model and context type before its
first message (Compress by default); the context type is then fixed, the model can still switch. LFM3 got a q4f32
twin (lm-experiments job lfm3-mlc-9) so GPUs without 16-bit floats stay on the GPU. The runtimes and tool formats
stay, so a model is one registry entry; the measurements and casebook entries from the removed models stay as
history.
