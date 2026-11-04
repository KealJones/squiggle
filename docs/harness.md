# Squiggle harness v2: goals, steps, recipes

The design every piece of Squiggle's agent loop follows, and the format the
small-model fine-tune (in [lm-experiments](https://github.com/KealJones/lm-experiments), `experiments/squiggle-ft/`) trains on. If
code and this doc disagree, fix one of them in the same change.

## Why

Squiggle's goal is a small model that is good at figuring things out, paired
with a harness that lets it finish big goals in many small turns. The model
does not need to know the world; it needs the habits: notice what it doesn't
know, find it, act, keep track of where it is. The harness carries the
memory and the bookkeeping.

Two rules from Keal shape everything:

1. **Slow the first time is fine; the second time should be fast.** Squiggle
   keeps *recipes*: how a task was solved, reused next time.
2. **Visible thinking is the start of the answer.** Models think as long as
   they need, streamed to the thinking view. Never trim thinking to save time.

## Overview of a turn

```
user message
  → resolve references ("that", "the file from yesterday", bare links)
  → look up recipes for the request
  → model, with: short system prompt, resolved refs, recipe (if any), memory,
                 retrieved context, recent turns
      ├─ answers directly (simple request)           → done
      └─ calls plan(goal, steps)                     → step mode
step mode (repeat until every step is done or the user stops):
  → fresh prompt for the current step (see "Step prompt")
  → model thinks, calls tools, ends the step with done(result) or need(what)
  → harness records the result, moves to the next step (the model may revise the plan)
all steps done
  → final prompt: goal + step results → model writes the reply to the user
  → harness saves a recipe from the finished plan (background)
```

There is no fixed cap on rounds. Each step has a soft cap of 12 tool calls
(then the model is told to finish the step with what it has, or call `need`)
and a hard cap of 18 (the step closes with what it has). Each turn has a
check-in every 60 tool calls: the UI shows a "Keep going" button with the plan
so far. Stop always works; a stopped task resumes when the next message says
"continue" (only the task of the latest reply resumes).

A step that won't move ends the turn with a question instead of spinning:
a reply with no text and no tool call (thinking cut off at the output cap) or a
reply stopped for repeating itself gets two nudges, then the user is asked
"I got stuck on step N … How should I go on?". Re-sending the current plan, or
revising it more than 3 times in a task, counts the same way (3 strikes). If a
step's own context fills, the model is warned once, then the step closes.
A call made with the same arguments in an earlier step of the task isn't run
again: the model gets the earlier result back (a new step doesn't show it).
A tool call typed out as text is never a step's result.

In the chat phase, a reply that used tools but wrote nothing gets one nudge to
answer from the results; if it still says nothing, the reply says it couldn't
put an answer together (an empty reply made the next turn redo the question).

## Tools the harness adds

All models get these. Native tool calling (LiteRT, cloud) uses them as normal
tools; the small model calls them with fenced blocks (see "Small-model format").

| tool | arguments | what it does |
| --- | --- | --- |
| `plan` | `goal` (string), `steps` (string[]) | Start or replace the plan for this turn. Steps are short imperative lines ("Find where the login form is defined"). Calling it again mid-task revises the plan; finished steps keep their results. |
| `done` | `result` (string) | Finish the current step. `result` is the one-to-three-line finding the rest of the task needs (paths, numbers, names, decisions), not a narration. |
| `need` | `what` (string) | Say what is missing. The harness tries `find` with it first; if memory, a recipe, or another chat (sharing at least two words with the question) answers it, that comes back as the result. Otherwise it asks the user: the question is the reply, and the user's next message, in any form, is the answer (shown in later step prompts under "The user answered your questions"). Tools, this task's own results and this chat don't count as answers: the model already had those. |
| `find` | `query` (string) | One search across everything Squiggle knows: tools (name + how to call), recipes, memory facts, past chats (all sessions), and this task's step results and saved tool output. Returns the top few of each kind that clear a relevance bar, labelled by kind. When none of the user's own things match (see "find falls through to the web"), it runs `web_search` instead. |

`find_tools` (current small-model engine) becomes the tools part of `find`.
`note` stays for chats without a plan but is no longer advertised in step mode
(step results replace it). `recall` and `search_history` stay for the big models;
`find` covers both for the small one.

### find falls through to the web

Small models reach for `find` to look up facts ("Emma Stone's latest movie"), and an empty
`find` used to say "Try different words", so a 0.6B model called it again and again in a plan
and never searched the web (2026-11-04, Qwen3 0.6B on WebLLM). Now, when `find` turns up no
recipe, memory fact, past chat or task item (only tools, or only the web tools), and the query
isn't about a past chat, the harness runs `web_search` with the same words and `find` returns
those results, reranked against the query (MiniLM cosine when "Search by meaning" has loaded
it, else BM25 over title + snippet, plus a little for the engine's own order) and cut to the
best 3 (small models) or 5. The search shows in the tool list as its own call, and a
`web_search` with the same query afterwards counts as a repeat. `need` never falls through
(it asks the user). When web_search is off, the empty text says to use web_search or need.

### Checking claims, URLs and step results (small models)

- **Pushback**: when the user disputes the last answer or asks to confirm it ("no, it's X",
  "can you confirm that?", "what's your source?"; `find.js PUSHBACK`), the harness searches
  the web for the earlier question plus the user's claim (or the disputed answer) before the
  model replies, and adds the results to the request with a line saying to answer only from
  them. The 0.6B agreed with "the correct answer is Bugonia" and "confirmed" it twice
  without a single lookup.
- **URLs**: `fetch_url` only opens a URL the model was given (in the user's messages, a
  search result, saved tool output or a page it read), or another page on one of those
  sites. Made-up URLs (bugonia.com/confirmation, example.com/movies/…) get an error that
  says to web_search first. Any HTTP 4xx/5xx is a failed call, not a page.
- **Step results**: a step that ends with a tool call typed out as text
  (`{"name": …, "arguments": …}`, `</tool_call>`) is nudged to make the call; that text is
  never a step's result (`tasks.toolCallText`).
- **"Latest" searches** get the current year added when the query names none
  (`web.js withYear`); the relay also sends them to Tavily's past-year search first.

## Task state

Stored on the session (synced, merged by id like messages):

```js
session.tasks[taskId] = {
  id, msg, thread,       // the user message that started it
  request, goal, created, updated, mts,
  status: 'active' | 'done' | 'stopped',
  steps: [{ id, text, status: 'todo' | 'active' | 'done' | 'blocked', result?, need?, calls: n }],
  recipe?: recipeId,     // recipe it started from (or was saved as)
  waiting?,              // a `need` question is waiting for the user's answer
  answers?: [{ q, a }],  // the user's answers to `need` questions
  revisions?,            // plan revisions so far (max 3)
  attachNote?,           // paths of files the user attached
  tools: [name],         // tools looked up with find (the small model sees their details in every step)
  log: [{ step, name, args, ok, label, text }],   // tool calls; the newest 40 keep their output
}
```

The reply message carries `task: taskId`. Finished or stopped tasks older than
3 days drop their logged output (plan, results and call arguments stay).

The UI shows the active task as a checklist above the reply (goal, steps with
state, the current step highlighted, results in small text), and as a compact
"N/M steps" chip on finished replies that expands to the same list.

## Step prompt (what the model sees in step mode)

Rebuilt from scratch for every step, so context never fills up. It is budgeted
to 45% of the context window: the last 2 finished steps show their whole result
and older ones are cut to 120 characters (`find` still has them), and when it is
still too long the sections go in reverse order (references first, the
attachments note last). The final prompt (goal + every step's result, no tools)
is budgeted the same way.

```
system:   short system prompt (model-appropriate; see below)
          ## Goal
          <goal>
          ## Plan
          1. [done] <step> → <result>
          2. [now]  <step>
          3. [todo] <step>
          ## The user answered your questions             (the last 3 `need` answers, if any)
          ## Files the user attached                      (paths, if any)
          ## Recipe from a similar task (if the model found one with find)
          <recipe steps + specifics>
          ## What you know about the user and their work   (memory facts above an absolute bar; v3 dialect:
                                                             "Notes saved from earlier chats (background only; may not fit this request)")
          ## Found earlier in this task                     (retrieved step results / tool output for this step)
          ## Resolved references                             (if any)
          ## Tools                                           (big models: all; small: looked-up only)
user:     <the original request, verbatim (first 700 characters)>

          Work on step 2 now: <step text>                               ← v2 (fenced, frozen)
          When the step is finished, call done with what you found.

          (Squiggle: Work on step 2 now: <step text> When the step     ← v3 (everyone else)
          is finished, call done with what you found.)
```

See "Prompt dialects" below for why the user turn differs.

Within a step the model's own tool calls and results accumulate normally (that
is short). They are saved as observations, so later steps can `find` them, but
are not replayed into later steps.

## Recipes

`memory/recipes.jsonl` in the storage repo (one JSON object per line, merged by
id like facts):

```js
{ id, title,            // "Kill whatever is listening on a port"
  when,                 // what requests it fits, in plain words, with example phrasings
  steps: [string],      // the plan that worked, generalised ("Find the PID with lsof -i :<port>")
  specifics: [string],  // concrete things worth reusing: paths, repo names, commands, URLs
  uses, created, lastUsed, sessions: [sessionId], pinned? }
```

- **Written** when a task finishes `done` and got somewhere (`tasks.worked`: every step
  has a real result, not "ran out of room", a typed-out tool call or "nothing found",
  and at least one tool call worked; failed calls are left out of its specifics): a background
  job asks the model to generalise the finished plan + step results + tool log
  into a recipe. The small model can't do that well, so when the active model is
  lite the harness builds it deterministically from the tool log (steps = the
  step texts; specifics = tool arguments that were paths, repos, URLs, commands)
  and lets the next big-model session refine it (saved with `draft: true`; a
  big model refines one draft per turn, in the background).
- **Approved**: every new recipe is saved `pending: true` (a "possible recipe") and isn't
  matched until the user approves it in Memory → Recipes (Keal, 2026-11-04: a failed
  "confirm Bugonia" task taught find + example.com). Small-model drafts saved before this
  load as pending.
- **Merged**: if a new recipe's `when` matches an existing one closely, update that
  one (append example phrasing, refresh steps if they changed) instead of adding. An
  approved recipe only gains the new phrasing; its steps stay as approved.
- **Used**: the model looks recipes up with `find` (results include "Recipes from
  similar tasks"); nothing is injected into the prompt (Keal, 2026-10-29: an injected
  recipe for "What is the date?" took over a small model's turn). The best recipe the
  model found in the chat phase goes with the plan it makes, into each step prompt.
  Using one bumps `uses` and `lastUsed`. Note: fine-tunes up to v2 were trained with
  injected recipes (families recipe_web, recipe_skip); the next corpus should have the
  model call `find` instead.
  Matching is by words, typo-tolerant (one edit, two for long words; never in
  numbers), and slot-aware: the same request about different names ("who was born
  first, A or B" against a recipe learned from C and D) lines up with the recipe's
  phrasing and the new names fill its slots.
- **Forgotten**: recipes unused for 90 days are deleted (pinned ones stay). They
  are cheap to relearn. The Memory panel lists recipes with uses/last used,
  and the user can pin, edit or delete them.

## Smart context v2

- **Query** = the new message + the active goal + the current step (not just the
  message).
- **Scope**: this chat first, then every other chat's messages and saved tool
  output (the same index `search_history` uses), then recipes and facts.
  Cross-chat items need a higher score.
- **Reference resolution** before the model sees the message: an entity table
  from recent turns (files, repos, branches, URLs, named projects, people, from
  messages, tool arguments and memory). Pronouns and definite references ("that",
  "it", "the file", "the repo", "the thing from yesterday") resolve to the most
  recent entity of the fitting type; the result goes in "Resolved references" as
  a hint, never rewriting the user's words. No hard-coded meanings: "kill 8080"
  is not assumed to be a port; context decides, and if context doesn't, the model
  investigates.
- Smart becomes the default mode; embeddings (MiniLM on CPU) stay optional and
  BM25 alone must be good enough on a phone.
- The "What the model saw" panel shows every section, including recipe, refs and
  plan.

## Fresh context (prefetch.js)

Settings → Context → Fresh (experimental). Smart context quoted recalled messages after the request, and small
models read them as the user talking (2026-11-04: Qwen3 0.6B answered recalled questions instead of the new one).
Fresh replays nothing just for being recent. Before the model sees a message, the agent looks things up for it:

1. **The question on its own.** A follow-up that names nothing ("what about his most recent one?") borrows the
   names, or failing that the topic words, of the last real question before it ("thanks!" is skipped).
2. **Saved things.** This chat's earlier exchanges (question + reply; the last one gets +0.05) and its saved pages,
   other chats when "Bring in other chats" is on, and memory facts (memory.js's own bar, 0.3). By meaning when
   "Search by meaning" is on (MiniLM cosine ≥ 0.45), else by words (two of the query's words and a third of them).
   A query that names someone only matches text that names them too.
3. **The web**, with the same words, unless the message is small talk or bare arithmetic, is about past chats, or
   is clearly a job for another tool (find's rankTools score over 4). Reranked, best 3 (small) or 5. On pushback
   ("no, it's X", "confirm that") the claim is searched instead, with the don't-just-agree note.

4. **Wikipedia and Wikidata** (`wiki_lookup`, tools/wiki.js), alongside the web search, when the question names
   someone or something: the article's opening, the item's key facts and its newest works by release date (cast
   member, performer, author, director…, with "not out yet" past today), and any list/filmography article to
   fetch. The model can call it itself too (it's in the gate). It passes words only: a 0.6B model doesn't know
   Wikidata ids or SPARQL, so the harness does the search and both queries.

The result goes in as a `find` call the model already made, with the result as its first input: the question is
the only user turn. Engines that can't start that way (Gemma 4 on LiteRT, the fenced format) get it as a system
section headed "Looked up before this message (search results, not the user's words)". Small talk gets nothing.
The seeded find and web queries count as made, so the repeat guard catches a model that asks again. Step mode is
unchanged (it was already one fresh prompt per step).

## Small-model format (Gemma 3 270M / the fine-tune)

This is the exact text the fine-tune is trained on. `engine-wllama.js` renders
and parses it.

- Chat template: Gemma's (`<start_of_turn>user` / `model`), one system message
  folded into the first user turn by the template.
- **Thinking**: the model may open with `<think>` … `</think>`. The engine streams
  it to the thinking view and does not show it in the reply.
- **Tool call**: a fenced block, alone at the end of the model's turn:

  ````
  ```tool_call
  {"name": "find", "arguments": {"query": "kill a process on a port"}}
  ```
  ````

- **Tool result**: comes back as the next user turn:
  `Result of find:\n<json>`
- **System prompt for the small model** (short; tool names never appear in
  prose it could copy):

  ```
  You are Squiggle, an assistant that figures things out. Think first. If you
  don't know something, don't guess: find it or look it up. For anything with
  more than one step, make a plan, then do one step at a time.
  Call a tool with a ```tool_call block containing {"name", "arguments"}; tools
  you have: plan, done, need, find, and any tool you have looked up with find.
  Arguments: plan(goal, steps), done(result), need(what), find(query).
  Today is <Day Mon DD YYYY>.
  ```

  (`LITE_SYSTEM` in agent.js; the date line is `new Date().toDateString()`.)

- **Small-model mode switch** (Settings → Small-model mode, stored per model in `settings.smallMode` as
  true or false; unset means the model's default): always on for small models in this fenced format
  (Squiggle Small; it's their training text and the only format their engine parses), **on by default for
  every other small model** (`agent.smallModeDefault`: anything on the wllama runtime, so tiny Gemma 4 and
  the Qwens — with the full prompt and every schema, half of a phone's 4K window was gone before the
  person typed, and a 0.8B model answered the instructions instead of the person; measured 2026-11-04,
  docs/measurements-2026-11-04.md: 430 more tokens, about 40 s of prefill on a phone-class CPU, no better),
  off by default for big ones (Gemma 4 E2B/E4B, the cloud model). Switched on, those models get
  `LITE_SYSTEM_NATIVE`: `LITE_SYSTEM`'s first three lines, without the ```` ```tool_call ```` line (their
  own template declares the tools), plus one line each on what web_search/fetch_url, find and need are for,
  and "Plan only when the request takes more than one step". It used to say "Start with plan, done, need and
  find", which small models obeyed literally: a 0.6B told "use web_search" argued with the prompt until its
  output ran out, and Qwen3.5 0.8B called need for arithmetic and for facts the user had just stated
  (measured 2026-11-04).
  Big models still get every tool declared natively; small native models are gated (next section). Context
  budgets and background jobs follow the runtime (wllama or not), not this switch.
  Tools the model has looked up are appended as
  `Tools you have looked up:\n- name(arg, optional?): first sentence of the description`.

- Tools the small model has not looked up are not described in its prompt; `find`
  returns their name, arguments and one line of description. Calling a real tool
  without looking it up is allowed.
- Anti-loop: the engine stops generation when any run of 8 words appears three
  times (and says so in the reply), and uses repeat penalty 1.15.
- `find` results come back as `{"found": "<text>", "tools": [names]}`; the
  engine describes those tools from then on (and carries them into later steps).

## Tool names up front (small native models)

Small models on wllama that call tools in their own template (`native: true`: Qwen3.5 0.8B, tiny Gemma 4)
used to get every schema declared, about 3.4k tokens of a 4K phone window, which no context mode can shrink.
Now (agent.js `gated()`):

- Declared with full schemas from the start (`GATE`): `plan`, `done` (steps), `need`, `find`, `tool_info`,
  `web_search`, `fetch_url`, `remember`, `calculate` (and `checkpoint` in AI-managed mode). About 940 tokens
  (by `estTokens`), plus about 110 for the name lines below, against about 3.4k before. `remember` and
  `calculate` joined on 2026-11-04: a 0.8B model told to save a fact with remember called `need` instead of
  looking remember up first, and did arithmetic with web_search.
- The prompt names what is declared and what is not, generated from the same sets the engine declares
  (`toolNamesLine`, in both the full prompt and `LITE_SYSTEM_NATIVE`): `Tools ready to call: plan, done,
  need, find, tool_info, web_search, fetch_url, remember, calculate.` then the rest grouped by the tool's
  `group` (tools/registry.js `defineTool`): `Other tools, by area: files: list_files, read_file, …; git and
  GitHub: …; memory: recall, …; maths and code: run_js. To use one, first call tool_info(names) with every
  one you expect to need.` Tools looked up earlier in the task (`task.tools`) count as ready. Nothing usable
  is left unnamed: web_search used to be declared but never mentioned, and a model went looking for it
  through tool_info instead of calling it. Not in the final reply's prompt (no tools). `need` and `find`
  called without an argument get an error back (never a question to the user).
- `tool_info(names)` answers `{"tools": [names], "ready": "… ready to call now."}`, or an error listing the
  valid names. The schema itself reaches the model through the declared tools on the next request, so the
  result stays short. `find` results that name tools declare them the same way.
- Declared tools stay declared for the rest of the chat phase or step (`NativeConversation.active`); tools looked
  up before a plan, or in a step, are carried into later steps (`task.tools`, passed as `known`).
- A call to a listed tool that wasn't looked up still runs and declares it, if the template and llama.cpp's
  parser let it through (they may constrain calls to declared names, so `tool_info` is the reliable path).
- The window meter's tool definitions grow by each newly declared schema.
- Not for the fenced format (Squiggle Small: `LITE_SYSTEM` is training text) or LiteRT/cloud models (their tool
  lists are fixed per conversation).

When the instructions plus tool definitions leave no room for a reply (`checkOverhead`), the turn fails with
that explanation instead of the generic "conversation got too long", since shortening history can't help.

## Prompt dialects

Built 2026-11-04, after three Qwen chats on a phone showed the same failure from different angles: a
0.8B model told the person "you had 2,030 tokens used" (the budget line, read as the user's words), described
"/home syncs across all devices" back to them (the system prompt, read as the user's setup), and reasoned
about "the user's current task: Work on step 1 now" (the step instruction). Small models can't tell harness
text from the person's text when both sit in the user turn. The fix is structural, not a reworded line:

- **v2** is the fenced small-model format above: Squiggle Small's training text, frozen. Every string it
  renders (`LITE_SYSTEM`, the step and final user turns, `Result of <tool>:\n<json>`, the section titles)
  stays byte-for-byte what the fine-tune saw; lm-experiments renders episodes through this code.
- **v3** is every other model. Any text the harness adds to a user turn is marked as Squiggle's:
  `(Squiggle: …)`, the way the loop note already was. The step instruction, the final-reply instruction, the
  AI-managed budget line and the "finish your thought" nudges all go through `DIALECT.v3.note`. The
  person's own words are never paraphrased. The memory section is titled "Notes saved from earlier chats
  (background only; may not fit this request)" instead of "What you know about the user and their work",
  which a small model read as things the person had just said.

`tasks.js DIALECT`; `agent.dialect()` picks v2 for fenced models and v3 for the rest; `tasks.js` functions
take `{ dialect }` and default to v2, so the fine-tune's rendering is untouched. The next fine-tune corpus
should move Squiggle Small to v3 (render with `DIALECT.v3` and retrain), after which v2 can go.

## Memory recall: an absolute bar

The old recall scored facts with BM25 normalised by the best match, then pulled in every fact sharing a
subject or object with a hit. Two things followed: the least unrelated fact always scored 1, so something
always cleared the 0.25 bar; and nearly every fact has the subject "user" or "Squiggle", so one weak hit
dragged the rest in. A request about a movie got "user considers using SQLite for a memory store", and a
0.6B model built its plan around SQLite.

Now (`search.js overlap`, `memory-rank.js rankFacts`):

- The score is the cosine between the two sets of content words, |shared| / √(|fact| · |request|): one
  shared word between a two-word fact and a three-word question is 0.41, one word out of eight in a long
  request against a four-word fact 0.18, nothing shared 0. Unweighted: with a few dozen facts, rarity
  statistics are noise.
- Words on 30% or more of the facts (at least three) are generic — "user", "Squiggle", the person's name —
  and count for nothing on either side.
- One hop through a shared entity still happens, at half the score, but only through a specific entity
  (one with a non-generic word), never through "user" or "Squiggle".
- Bars: 0.2 in the chat-phase section and the step prompt (about one shared rare word), 0.35 for the
  eager facts small models get in the recalled block. With embeddings the semantic score is blended in on
  the same absolute scale (`blend({ absolute: true })`).
- `memory.aboutTheUser` keeps extracted facts about the assistant itself ("Squiggle is_a private AI agent",
  "Squiggle has_tool chat renaming" — the system prompt and the assistant's own replies, read back as
  facts) out of memory unless the person's message names what the fact says. Memory is what the person said.

## Per-model generation settings

`engine.js generationFor(id)`: sampling, whether the model thinks, and a thinking budget, from each
model's card instead of one setting for all (`MODELS[id].family`, overridable per model with `sampling`,
`thinking`, `thinkBudget`):

| family | models | temperature / top_k / top_p | repeat / presence penalty | thinking |
|---|---|---|---|---|
| `fenced` | Squiggle Small, Gemma 3 270M | 0.7 / 64 / 0.95 | 1.15 / 0 | as trained (`<think>` in text) |
| `gemma4` | E2B, E4B, tiny Gemma 4, the cloud 26B | 1.0 / 64 / 0.95 (the card's one setting) | 1.0 / 0 | on with tools (TG4A: off, trained without) |
| `qwen3` | Qwen3 0.6B | 0.6 / 20 / 0.95 (thinking mode) | 1.0 / 1.5 | on, budgeted |
| `qwen35` | Qwen3.5 0.8B | 1.0 / 20 / 1.0 (non-thinking text) | 1.0 / 2.0 | **off**: its card runs the 0.8B non-thinking by default and warns it loops in thinking mode |
| `default` | Llama 3.2 1B, LFM2.5 1.2B | 0.7 / 64 / 0.95 | 1.15 / 0 | — |

`fenced` must not change: lm-experiments' eval (`backends.py HFStudent`) runs with exactly those numbers.
The Qwen cards say no repeat penalty (presence penalty against loops instead); the old 1.15 over the last
64 tokens punished re-writing the tokens a tool call copies from just above, and is the likely cause of
"SQuile" and "Quirk" for "Squiggle". The loop guard's retry still adds 0.15 to whichever repeat penalty the
model has. WebLLM has no top_k or min_p. The relay forwards temperature, top_p and top_k.

**Thinking budget** (`thinkBudget`, default 400 reasoning tokens for small models, none for big ones):
past it the engine stops the thinking and gets the answer. Fenced models continue from the closed think
block (prefill: the thinking so far plus "[Squiggle stopped the thinking at its N-token budget and asked
for the answer.]"); native-template models get the same request again with thinking off (those templates
can't continue a half-written turn), and the first try's thinking stays attached to the call it leads to.
Rule 2 above ("never trim thinking to save time") stands: this is not about time. A 0.6B model thought
until the 1,024-token output cap and never answered, three turns in a row; the window, not the clock, sets
the budget. The UI shows the note in the thinking view.

**Thinking inside a tool round.** The Qwen3, Qwen3.5 and Gemma 4 cards all say past turns' thinking leaves
the history, except within a tool round: the thinking that led to a call stays while its results are
answered. `nativeMessages` keeps `reasoning_content` on the last assistant turn only while every message
after it is a tool result; the Qwen jinja templates and the WebLLM shim (`<think>…</think>` before the
call, as Qwen renders it) read it. Older rounds in the same step drop theirs (a 4K window can't hold
twelve). The raw Gemma 4 prompt on WebLLM (`gemma4Prompt`) does not render it yet: its real template's
rendering of a thought in a tool-call turn isn't pinned in `tests/fixtures/gemma4-template.json`.

**Tool results as text** (`engine-wllama.js resultText`, native models only): a string as it is, a flat
object as `key: value` lines with multi-line strings whole, anything deeper as indented JSON.
`JSON.stringify` put a whole search result into one quoted string with `\n` written out, which a 0.6B
model read badly. The fenced format keeps `Result of <tool>:\n<json>`: training text.

**Provenance.** Every reply saves `model: { id, label, how, smallMode?, contextSize, contextMode }`
(`agent.js replyModel`), so a saved chat can be read against the model that wrote it; the sidebar shows
"Last reply by" when it isn't the current model.

## What the fine-tune should learn (training targets)

Episodes are rendered in the small-model format above, with real data (real
web pages, real repos and files, real messages): never invented names or facts.
Each episode is one turn of the loop: the model's prompt as the harness builds
it, then the model's output (thinking + one tool call, or the final reply).

Habits, in order of importance:
1. **Don't guess**: when the answer depends on a fact, look it up (`find`,
   `web_search`, `read_file`…), and check that what came back is about the right
   thing.
2. **Plan when it's more than one step**, then work the current step only; end it
   with `done(result)` holding the facts later steps need.
3. **Use a recipe when the prompt has one**; skip steps it already answers.
4. **Say what's missing** with `need` instead of stalling or bluffing.
4b. **Never do math in your head**: every sum, price, percentage or conversion goes
   through `calculate(expression)` (calc.js: a safe expression parser, no code), and
   the number in the reply is the one it returned. `run_js` is for real code and data
   tasks only.
5. **Messy input**: Keal's rambling, voice-dictated, self-correcting messages,
   bare links, references to old chats.
6. Plain chat stays plain: "hey whats up lol" gets a short normal reply.

## The model manages its own context (AI-managed mode)

Status: **built 2026-10-29** as Settings → Context → "AI-managed (experimental)" (Keal: "it's always a toggle so easy
enough to turn off"). Proposed 2026-10-28; 0b was built first. What differs from the proposal below:

- **Everything is behind the setting**, including sections 1, 2 and 5 that the proposal applied to every mode: Squiggle
  Small's system prompt is the exact text it was fine-tuned on, so Compress and Smart stay byte-for-byte as before.
  Plain chat (stock small models) never gets it.
- **Chat-phase history** in AI-managed mode is Compress's (rolling summary + recent messages, a bit more of them); the
  model fetches anything else with `find` or attaches it to a step.
- **Code:** `tasks.js` (`MANAGED_SPECS` plan/checkpoint, `normSteps`, `parseRef`, `budgetLine`, `fitAttachments`,
  `stepUser` variants), `agent.js` (`managed()`, `UPFRONT`, `attachment()`, `checkpointTask()`, the `again` step
  outcome). Attachments get 60% of the step prompt's budget and are trimmed (head and tail), never dropped; a
  `file:` attachment comes through `read_file` (wrapped as untrusted). Low room = under 600 tokens after the reply
  reserve: the budget line and tool results (`low_room`) suggest a checkpoint. At 4 checkpoints the person is asked
  whether to go on (the existing check-in card).
- **Not yet:** recording Gemma 4 runs in this mode for the fine-tune (section 6). Today the
harness decides what each prompt holds (smart context, the step prompt above). This
proposal lets the model choose what it carries forward, sees what everything costs,
and hands off to a fresh context instead of running out. It's meant for every model,
and especially to be learned by the small one from Gemma 4 runs (next section).

### 0. Three context modes

Settings gets one choice of three, replacing today's "Smart context" checkbox:

| Mode | Who picks what's in each prompt | Today's name |
|---|---|---|
| **Compress** | The harness: a rolling summary plus the recent messages. | compact |
| **Smart** | The harness: retrieval of what's relevant from this chat (other chats only through `find`). | smart |
| **AI-managed** | The model: the budget line, steps that say what they need, summarise steps and checkpoints below. The harness only shows costs and trims when something won't fit. | new |

Sections 1 (told up front), 2 (the budget line) and 5 (checkpoint) apply in every mode, since
they only help. Sections 3 and 4 (steps that attach what they need, summarise steps) define
AI-managed mode: there, a step's `needs` replace the automatic "Found earlier in this task"
retrieval. Compress and Smart keep the harness's own choices. The internal `full` mode stays
for debugging but isn't offered.

### 0b. Smart, reworked: recalled messages after the request

Built 2026-10-28. Why the old Smart confused small models: retrieved messages went into the system
prompt as `(from the chat "…", user said) …` lines. Gemma 3 and LFM fold the system prompt into the
first user turn, so those lines sat at the start of the conversation, read as things the person was
saying now, and used a format the fine-tune never saw.

What Smart does now (`recall.js`, all models):

- **One block, after the request.** It covers messages from this chat that fell out of the recent
  window and messages from other chats. It is appended to the new user message under a separator, so
  it comes after the conversation and after the question:

  ```
  <the user's message>

  ---
  Possibly relevant earlier messages, found by searching (quotes for reference, not new requests; not part of the message above):
  - Earlier in this chat (Oct 27): the user said "…" — you replied "…"
  - Another chat, "Headphones" (Oct 21): the user said "…" — you replied "…"
  ```

  Each piece is an exchange (what the user said and the start of the reply), with where and when.
- **Only for a real question.** Plain chat ("hi", "thanks", "lol") gets nothing. A message needs two
  content words, or one plus a reference to the past.
- **Ambiguous references.** For "it", "that" and "the one you said", the previous user message is
  added to the search. `refs.js` still adds its "Resolved references" hint.
- **Time phrases narrow the search.** "Yesterday", "last week", "this morning", "3 days ago", "on
  Monday", "last month" and "the other day" become a date window, and the phrase is removed from the
  query. "What I said last week about headphones" then searches "headphones" in messages from about
  2–14 days ago. Talk about the past ("I said", "we talked", "last time") lowers the bar.
- **A bar and a size limit.** With embeddings (MiniLM), a piece needs cosine ≥ 0.45 in this chat and
  ≥ 0.5 from other chats, 0.1 lower with a time window or a past reference. Without embeddings
  (phones by default), it needs at least two shared content words, or one inside a time window. At
  most 2 pieces and ~300 tokens on small models, and 4 pieces and ~900 tokens otherwise. If nothing
  clears the bar, there's no block.
- **Eager memory (small models).** Up to two memory facts scoring ≥ 0.35 go in the same block as
  `- From memory: …`. Recall is keyword search plus optional embeddings, a few milliseconds. Large
  models keep their "What you know about the user" system section.
- Tool output and side-thread outcomes stay in the system prompt section as before; this block is
  only conversation and memory.
- The "What the model saw" panel lists each recalled piece with its score.
- Setting: "Bring in other chats" (on). Off limits recall to this chat.

To measure: Compress vs this Smart on the same eval set, plus a handful of cases with "that",
"yesterday" and "what I said about X".

### 1. Told up front

One paragraph in every system prompt (small-model version kept to two lines):

> You work over several turns and steps. Each one shows you only what it needs; anything
> earlier can be fetched with find or attached to a step. Don't try to fit everything into
> one turn. When you're running low on room, checkpoint and carry on fresh.

### 2. A budget line on every prompt

The last line before the model writes, in the chat phase and in every step:

```
Context: 2,310 of 4,096 tokens used (about 1,000 left after room for your reply).
```

Tool results already carry `context_left`; this makes the budget visible before the
model's first call too, and counts what the attachments below cost.

### 3. Steps that say what they need

`plan(goal, steps)` takes steps as objects as well as strings:

```json
{"text": "Compare the two birth years", "needs": ["step:1", "step:2"]}
{"text": "Fix the wave function", "needs": ["file:/repos/squiggle/app/src/main.js:610-640", "note:n3"]}
```

- **What can be attached:** `step:N` (that step's result), `note:<id>`, `file:<path>[:lines]`
  (also `/web/<n>.txt` pages), `find:<query>` (whatever `find` returns at that point).
- **What the step prompt shows:** each attachment with its cost, e.g.
  `## Attached for this step (612 tokens)`. Unattached earlier results still show as
  one-liners, as now.
- **Revising:** calling `plan` again can add steps, reorder the remaining ones, and change
  any step's `needs`; finished steps keep their results (today's revise rule).
- **Over budget:** the harness trims the largest attachment (head and tail, or its line
  range), and the prompt says what was trimmed and how to get the rest. A step never fails
  for attaching too much.

### 4. Summarise steps

A step can be `{"text": "...", "kind": "summarize", "needs": ["file:/web/2.txt"]}`. It reads
something big and ends with `done(summary)`. Later steps attach `step:N` (the short summary)
instead of the big thing. The harness suggests one when a `needs` entry alone would take
more than about a third of the window.

### 5. Checkpoint: hand off to a fresh context

A harness tool, available in the chat phase and inside steps:

| Tool | Arguments | What it does |
|---|---|---|
| `checkpoint` | `summary` (what's known and done so far), `needs` (the same attachment refs as above), `next` (what to do next) | Saves the summary as a note on the task and ends this turn's context. The harness starts a fresh one with: the original request, the summary, the `needs` attachments and `next` as the instruction. The user sees one continuous reply. |

- **When it's offered:** when less than about 600 tokens are left, a tool result (or the
  budget line) adds: "You're running low on room. Finish now, or checkpoint with what you
  need for the next turn." Long reasoning is a reason to checkpoint too: thinking that isn't
  done can go in `summary`.
- **In the chat phase:** a checkpoint turns the turn into a task, so the summary and
  attachments survive like step results and `find` can reach them.
- **Limits:** at most 4 checkpoints per turn, then the harness asks the user whether to go
  on (the check-in that already exists).
- **Fallbacks:** if the model never checkpoints and the window fills, today's behaviour
  stands (the call is refused with "context almost full"), so nothing gets worse.

### 6. How the small model learns it

- **Gemma 4 plays the model** inside this harness, with the small model's 4,096-token window
  and the small-model prompt. Its real runs are saved: thinking (kept only when short), tool
  calls, `plan` with `needs`, summarise steps and checkpoints. Gemma 4 is Apache-2.0;
  Anthropic support confirmed Claude can't write these examples (2026-10-28).
- **New families:** a long page that needs a summarise step; a multi-step task whose later
  steps attach earlier results; a task too big for one window that has to checkpoint; a
  revised plan after a step finds something unexpected.
- **New checks:** attachments that are used (the step's Check or result quotes them);
  checkpoint summaries that carry the facts the next turn needed; no checkpoint when there
  was plenty of room.

### Open questions

- ~~Should `needs` replace the automatic retrieval?~~ Settled: in AI-managed mode yes; Smart
  keeps retrieval (section 0).
- Which mode the phone should default to once AI-managed exists: probably AI-managed after
  the Gemma-taught model learns it, Smart until then.
- The checkpoint threshold (600 tokens) and the summarise suggestion (a third of the window)
  need measuring on the phone.
- Big models have room to spare; they get the same tools, but the budget line matters
  mostly for small ones.
