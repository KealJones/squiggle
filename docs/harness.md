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
(then the model is told to finish the step with what it has, or call `need`).
Each turn has a check-in every 60 tool calls: the UI shows a "Keep going"
button with the plan so far (never "say continue"). Stop always works.

## Tools the harness adds

All models get these. Native tool calling (LiteRT, cloud) uses them as normal
tools; the small model calls them with fenced blocks (see "Small-model format").

| tool | arguments | what it does |
| --- | --- | --- |
| `plan` | `goal` (string), `steps` (string[]) | Start or replace the plan for this turn. Steps are short imperative lines ("Find where the login form is defined"). Calling it again mid-task revises the plan; finished steps keep their results. |
| `done` | `result` (string) | Finish the current step. `result` is the one-to-three-line finding the rest of the task needs (paths, numbers, names, decisions), not a narration. |
| `need` | `what` (string) | Say what is missing. The harness tries `find` with it first; if nothing useful comes back, it asks the user (the question is shown as a normal assistant message and the user's reply, in any form, comes back as the result). |
| `find` | `query` (string) | One search across everything Squiggle knows: tools (name + how to call), recipes, memory facts, past chats (all sessions), and this task's step results and saved tool output. Returns the top few of each kind that clear a relevance bar, labelled by kind. |

`find_tools` (current small-model engine) becomes the tools part of `find`.
`note` stays for chats without a plan but is no longer advertised in step mode
(step results replace it). `recall` and `search_history` stay for the big models;
`find` covers both for the small one.

## Task state

Stored on the session (synced, merged by id like messages):

```js
session.tasks[taskId] = {
  id, msg,               // the user message that started it
  goal, created, updated,
  status: 'active' | 'done' | 'stopped',
  steps: [{ id, text, status: 'todo' | 'active' | 'done' | 'blocked', result?, need?, calls: n }],
  recipe?: recipeId,     // recipe it started from, if any
}
```

The UI shows the active task as a checklist above the reply (goal, steps with
state, the current step highlighted, results in small text), and as a compact
"N/M steps" chip on finished replies that expands to the same list.

## Step prompt (what the model sees in step mode)

Rebuilt from scratch for every step, so context never fills up:

```
system:   short system prompt (model-appropriate; see below)
          ## Goal
          <goal>
          ## Plan
          1. [done] <step> → <result>
          2. [now]  <step>
          3. [todo] <step>
          ## Recipe from a similar task (if any)
          <recipe steps + specifics>
          ## What you know about the user and their work   (memory facts, goal+step query)
          ## Found earlier in this task                     (retrieved step results / tool output for this step)
          ## Resolved references                             (if any)
          ## Tools                                           (big models: all; small: looked-up only)
user:     <the original request, verbatim>
          Work on step 2 now. When the step is finished, call done with what you found.
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
  and lets the next big-model session refine it.
- **Merged**: if a new recipe's `when` matches an existing one closely, update that
  one (append example phrasing, refresh steps if they changed) instead of adding.
- **Used**: at the start of a turn the harness retrieves recipes for the request;
  a strong match goes in the prompt and is offered as the starting plan. Using
  one bumps `uses` and `lastUsed`.
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
  ```

- Tools the small model has not looked up are not described in its prompt; `find`
  returns their name, arguments and one line of description. Calling a real tool
  without looking it up is allowed.
- Anti-loop: the engine stops generation when the same sentence (≥ 8 words)
  appears three times, and uses repeat penalty 1.15.

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
5. **Messy input**: Keal's rambling, voice-dictated, self-correcting messages,
   bare links, references to old chats.
6. Plain chat stays plain: "hey whats up lol" gets a short normal reply.
