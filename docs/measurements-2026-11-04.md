# Small models through the real app (2026-11-04)

What happens when the real app runs a real small model, turn by turn, and what changed because of it.
Headless Chromium on a 4-core 2.1 GHz Xeon (about a phone-class CPU), the e2e harness's git server and
relay, Smart context, a 4K window, all cores on. Reproduce with
`node tests/e2e/model-drive.mjs --model Q35 --threads --small 1` (it prints the same per-turn lines).
Web search goes to the harness's fixed DuckDuckGo page, so "look it up" questions can't be answered;
what matters is how the model behaves around the tools.

Squiggle Small and tiny Gemma 4 are experimental and were left out of the conclusions; Qwen3.5 0.8B
(`Q35`, the stock small model with native tools) is the subject, Gemma 3 270M the plain-chat control.

## Fixed prompt cost (what the model reads before your first word)

`estTokens`, the app's own estimate. The first reply of a chat waits for all of it: this CPU reads
about 11-13 tokens/s of prompt, so 1,500 tokens is about two minutes to the first token. Later turns
reuse the cached prefix when nothing before the new message changed.

| what the model gets | system | tools | total | of 4K | of 8K |
|---|---:|---:|---:|---:|---:|
| Gemma 4 E2B/E4B, cloud: full prompt + every schema (before) | 658 | 3,387 | 4,045 | 99% | 49% |
| same, after (shorter prompt; schemas unchanged) | ~330 | 3,387 | ~3,720 | 91% | 45% |
| Qwen3.5 / tiny Gemma, full prompt + gated schemas (before) | 867 | 655 | 1,522 | 37% | 19% |
| same, after (shorter prompt, remember + calculate declared) | 726 | 936 | 1,662 | 41% | 20% |
| Qwen3.5 / tiny Gemma, small mode (before) | 236 | 655 | 891 | 22% | 11% |
| same, after | 297 | 936 | 1,233 | 30% | 15% |
| Squiggle Small (fenced) | 130 | ~300 | ~430 | 10% | 5% |

The system prompt reaches every engine as a real system role (LiteRT preface, the cloud API, llama.cpp's
chat template); Gemma's own template folds it into the first user turn, which is how Gemma is trained.
The size, not the role, was the problem.

## What Qwen3.5 0.8B did, before and after

Five messages: hi / what is 15% of 240? / remember that my dog is named Pip / what is my dog's name? /
who is the UK prime minister right now, look it up.

| | before (full prompt) | before (small mode) | after (small mode, the new default) |
|---|---|---|---|
| hi | fine; 116 s to first token | fine; 80 s | fine; 108 s (two more schemas) |
| 15% of 240 | four `web_search` calls, then did the maths itself (147 s) | called `need` with the question itself; the app asked the user "15% of 240?" | `calculate("240 * 15%")`, answered 36 (40 s) |
| remember my dog is Pip | `need("the dog's name is Pip")`: the app asked the user their own statement back | same misuse of `need` | `remember(...)` called (the triple it chose is poor: subject Pip, relation used) |
| what is my dog's name? | "My dog is named Pip" (from the conversation) | "Pip" | "Pip is the dog's name" |
| PM, look it up | searched twice, then answered from its weights | five searches, 300 s timeout | find/need without arguments caught by the guard (no question to the user); still searched twice, then hallucinated |

Memory: the renderer sits at 0.95-1.2 GB RSS with Qwen3.5 0.8B loaded and a 4K window (JS heap 10 MB;
the rest is WASM). Squiggle Small 0.5-0.6 GB, Gemma 3 270M 0.6 GB. Load: Qwen 24-29 s, the 270M-350M
models 11-14 s (from the browser cache).

Speed on this box: 5-6 tokens/s decode for Qwen on 4 threads, 14-18 for the 270M-350M models;
one thread is about a third of that. WebGPU here is SwiftShader (software) and no faster.

Gemma 3 270M answers "Okay, I understand." to anything that isn't a greeting. It is a chat-only
model with no system prompt by design; nothing in the harness changes that.

## What changed

- The full system prompt is about half its size (same instructions, fewer words), and names
  `calculate`, `remember` and `need(what)` for what they are.
- `LITE_SYSTEM_NATIVE` no longer says "Start with plan, done, need and find"; the 0.8B model obeyed
  that literally. It now says what web_search/fetch_url, find and need are for, and to plan only for
  multi-step requests.
- Small-model mode is on by default for wllama models (tiny Gemma 4, Qwen3.5); still off for Gemma 4
  E2B/E4B and the cloud model; still a per-model switch.
- Gated models get `remember` and `calculate` declared up front, and the "other tools" line is grouped
  by area (`files: …; git and GitHub: …; memory: …; maths and code: …`) from each tool's `group`.
- `need` and `find` with no argument, and `need` restating what the user just said, get an error back
  instead of becoming a question to the user.
- The same tool with the same arguments twice in one phase is not run again (the model gets told the
  result is already above); small models are nudged to answer after 3 tool calls in the chat phase and
  get no more after 6.
- Small models' history budget in the chat phase went from a quarter of the window to 40%: at 4K the
  quarter minus the schemas left about 300 tokens, so the replayed window changed every turn and
  llama.cpp re-read the whole prompt (30-50 s per turn here).

## Memory (the under-1 GB question for iOS Safari)

Renderer RSS in headless Chromium, one browser per row, a 1,000-token prompt and 32 tokens out
(`measureUserAgentSpecificMemory` is not in this build; RSS over-counts a little against what iOS
charges a tab, but the differences between rows are real). The empty page is 85-113 MB of that.

Qwen3.5 0.8B, Q4_0 GGUF (507 MB), 4 threads:

| settings | after load | peak during inference |
|---|---:|---:|
| defaults (n_batch 2048, n_ubatch 512, f16 KV), 4K | 902-913 MB | 1,130-1,148 MB |
| n_batch 512, 4K | 896 | 1,132 |
| n_batch 512, q8 KV + flash attention, 4K | 851 | 1,106 |
| n_batch 256, q8 KV + flash, 4K | 848 | 1,088 |
| n_batch 64, q8 KV + flash, 4K | 841 | 1,089 |
| n_batch 256, q8 KV + flash, 2K | 838 | 1,074 |
| n_batch 256, q8 KV + flash, 4K, 100-token prompt | 863 | 1,108 |

What the numbers say: the model's own 507 MB plus the runtime is about 740 MB; inference adds a
fixed 240 MB that does not move with prompt length, micro-batch size, KV precision or context size,
so it is not a buffer the app can shrink (it looks like a one-time allocation inside the WASM build at
the first decode). KV precision and batch size together are worth about 50 MB after load and 40 at
peak; context size 4K vs 2K about 15 MB. Load time was the same in every row (24 s cold, 3.5 s from
the cache), and so was time to first token.

So Qwen3.5 0.8B on the CPU cannot be made to fit under 1 GB with settings; it needs a smaller file
(a Q3 quantization, or a 0.5-0.6B model). The app now loads CPU models with n_batch 512, n_ubatch
256, an 8-bit KV cache and flash attention (`engine-wllama.js createEngine`, with a plain retry if a
build rejects them), which is the part that is free.

The same two rows for the other phone models (same prompt, 4K window, 4 threads). Where the KV cache
is wide (Qwen3 0.6B: 8 KV heads of 128 over 28 layers, 470 MB at f16 for 4K) the lean settings are
worth over 300 MB; where it is narrow (Qwen3.5: 2 heads) they are worth 50.

| model (file) | defaults: loaded / peak | lean: loaded / peak | under 1 GB? |
|---|---:|---:|---|
| Qwen3 0.6B, native tools (382 MB) | 1,059 / 1,205 MB | 822 / 883 MB | yes, with the lean settings |
| Qwen3.5 0.8B, native tools (507 MB) | 902 / 1,148 | 848 / 1,088 | no |
| Gemma 3 270M, chat only (242 MB) | 513 / 675 | 551 / 614 | yes |
| Squiggle Small, fenced tools (219 MB) | 483 / 627 | 430 / 488 | yes |
| tiny Gemma 4 heal 4 (778 MB) | 1,477 / 1,522 | 1,391 / 1,409 | no, by a lot |

Qwen3 0.6B was listed as a chat-only size test; it now runs with its own tool format on wllama (the
same model already did on WebLLM as `WQ06`), which makes it the smallest tool-using model in the list
and the one under the 1 GB line.

## Still true, and worth doing next

- Prefill is the phone experience. Every token in the system prompt and the declared schemas is read
  again whenever anything before the newest message changes. Candidates: keep the dynamic context
  sections (earlier tool calls, notes, summary, facts) out of the system message so the cached prefix
  survives between turns; trim the two biggest declared schemas (`web_search`, `fetch_url`); declare
  fewer tools up front when the window is 4K.
- The full prompt with every schema is still 91% of a 4K window. Gemma 4 E2B/E4B are desktop models
  with 8K+ windows, so this is a desktop problem at 4K only; gating them the way wllama models are
  gated would need LiteRT conversations to accept tools added mid-conversation.
- A 0.8B model's `remember` triples are poor (subject and object both "Pip"). A post-check that rejects
  a triple whose subject equals its object, or a simpler `remember(text)` shape for small models, would
  help memory quality.
- None of this was run on an iPhone; the CPU here is a stand-in. The WebLLM builds (`WQ35`) with real
  WebGPU should prefill much faster and are the better phone target for Qwen.
