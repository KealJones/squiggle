# Squiggle harness v2: goals, steps, recipes

The design every piece of Squiggle's agent loop follows, and the format the
small-model fine-tune (in tp-parse, `experiments/squiggle-ft/`) trains on. If
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

## Tools the harness adds

All models get these. Native tool calling (LiteRT, cloud) uses them as normal
tools; the small model calls them with fenced blocks (see "Small-model format").

| tool | arguments | what it does |
| --- | --- | --- |
| `plan` | `goal` (string), `steps` (string[]) | Start or replace the plan for this turn. Steps are short imperative lines ("Find where the login form is defined"). Calling it again mid-task revises the plan; finished steps keep their results. |
| `done` | `result` (string) | Finish the current step. `result` is the one-to-three-line finding the rest of the task needs (paths, numbers, names, decisions), not a narration. |
| `need` | `what` (string) | Say what is missing. The harness tries `find` with it first; if memory, a recipe, or another chat (sharing at least two words with the question) answers it, that comes back as the result. Otherwise it asks the user: the question is the reply, and the user's next message, in any form, is the answer (shown in later step prompts under "The user answered your questions"). Tools, this task's own results and this chat don't count as answers: the model already had those. |
| `find` | `query` (string) | One search across everything Squiggle knows: tools (name + how to call), recipes, memory facts, past chats (all sessions), and this task's step results and saved tool output. Returns the top few of each kind that clear a relevance bar, labelled by kind. |

`find_tools` (current small-model engine) becomes the tools part of `find`.
`note` stays for chats without a plan but is no longer advertised in step mode
(step results replace it). `recall` and `search_history` stay for the big models;
`find` covers both for the small one.

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
          ## Recipe from a similar task (if any)
          <recipe steps + specifics>
          ## What you know about the user and their work   (memory facts, goal+step query)
          ## Found earlier in this task                     (retrieved step results / tool output for this step)
          ## Resolved references                             (if any)
          ## Tools                                           (big models: all; small: looked-up only)
user:     <the original request, verbatim (first 700 characters)>

          Work on step 2 now: <step text>
          When the step is finished, call done with what you found.
```

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

- **Written** when a task finishes `done` (not stopped, not failed): a background
  job asks the model to generalise the finished plan + step results + tool log
  into a recipe. The small model can't do that well, so when the active model is
  lite the harness builds it deterministically from the tool log (steps = the
  step texts; specifics = tool arguments that were paths, repos, URLs, commands)
  and lets the next big-model session refine it (saved with `draft: true`; a
  big model refines one draft per turn, in the background).
- **Merged**: if a new recipe's `when` matches an existing one closely, update that
  one (append example phrasing, refresh steps if they changed) instead of adding.
- **Used**: at the start of a turn the harness retrieves recipes for the request;
  a strong match goes in the prompt and is offered as the starting plan. Using
  one bumps `uses` and `lastUsed`.
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
  Tools the model has looked up are appended as
  `Tools you have looked up:\n- name(arg, optional?): first sentence of the description`.

- Tools the small model has not looked up are not described in its prompt; `find`
  returns their name, arguments and one line of description. Calling a real tool
  without looking it up is allowed.
- Anti-loop: the engine stops generation when any run of 8 words appears three
  times (and says so in the reply), and uses repeat penalty 1.15.
- `find` results come back as `{"found": "<text>", "tools": [names]}`; the
  engine describes those tools from then on (and carries them into later steps).

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

## Proposal: the model manages its own context (not built yet)

Status: **proposed** (Keal, 2026-10-28), for review before any code changes. Today the
harness decides what each prompt holds (smart context, the step prompt above). This
proposal lets the model choose what it carries forward, sees what everything costs,
and hands off to a fresh context instead of running out. It's meant for every model,
and especially to be learned by the small one from Gemma 4 runs (next section).

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

- Should `needs` on a step replace the automatic "Found earlier in this task" retrieval, or
  only add to it? (Proposed: add to it at first, then measure whether retrieval still helps.)
- The checkpoint threshold (600 tokens) and the summarise suggestion (a third of the window)
  need measuring on the phone.
- Big models have room to spare; they get the same tools, but the budget line matters
  mostly for small ones.
