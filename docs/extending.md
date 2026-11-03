# Extending Squiggle

Squiggle is plain ES modules with no build step, so extending it means adding a
module and registering what it provides at startup. Two things are designed to
be extended: the agent's **tools** and the **context modes**. Both keep the
invariants in [CLAUDE.md](../CLAUDE.md): the model never sees the GitHub token,
outside text is wrapped as untrusted, and approvals only ever come from the UI.

## Custom tools

A tool is `{ spec, run }`. `spec` is the JSON-schema function spec the model
sees; `run(args, ctx)` does the work and returns what the model should see.

```js
// app/src/tools/weather.js
import { defineTool, params, str } from './registry.js';
import { wrapUntrusted } from '../untrusted.js';

export const weather = defineTool({
  name: 'weather',                                   // ^[a-z][a-z0-9_]{1,63}$
  description: 'Current weather for a city.',        // the model reads this
  parameters: params({ city: str('City name, e.g. "Lisbon"') }, ['city']),
  async run({ city }, ctx) {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    if (!r.ok) return { model: { error: `wttr.in answered ${r.status}` } };
    const text = JSON.stringify((await r.json()).current_condition[0]);
    return {
      model: { city, weather: wrapUntrusted('wttr.in', text) },   // outside text: always wrapped
      label: `checked the weather in ${city}`,                     // shown in the chat and the sidebar
      observation: { source: 'web', title: `Weather: ${city}`, text }, // optional: smart context can recall it later
    };
  },
});
```

Register it once at startup. The simplest place is `app/src/tools/index.js`,
which registers the built-ins in a fixed order (append yours at the end; the
order is part of the small model's prompt, so don't reorder the built-ins):

```js
import { weather } from './weather.js';
export const BUILTIN = [ /* …built-ins… */, weather ];
```

Or keep it out of the core and register from your own module:

```js
import { registerTool } from './tools.js';
import { weather } from './tools/weather.js';
registerTool(weather);           // replaces a tool with the same name in place
```

What `run` gets and must return:

| | |
|---|---|
| `args` | the model's arguments, parsed; validate them yourself, small models send odd shapes |
| `ctx.session` | the open session (notes, observations) |
| `ctx.room` | characters left in the model's context; cap big outputs with it |
| `ctx.approve(req)` | asks the person through the UI card and resolves `'once' \| 'always' \| 'deny'`. Only the UI can resolve it; never let model output stand in for it |
| `ctx.pageCards` | true for small models: return a short card and save the rest as a file (see `fetch_url`) |
| returns `model` | what the model sees. `{ error }` marks the call failed |
| returns `label` | one short line for the UI and for replaying history |
| returns `observation` | `{ source, title, text }` kept on the session for smart context |

Rules that keep tools safe: anything from outside (web, files in cloned repos,
GitHub descriptions, git log) goes through `wrapUntrusted(key, text)`; paths
from the model resolve through `guard.resolveAgentPath`; never import
`github.js` internals to get at the token, call `gh()` instead; pushes go
through `guard.pushPolicy` and `ctx.approve`.

Enabling and disabling: `agent.settings.tools` is a `Set` of enabled names
(`null` = all). `find` and `tool_info` work on whatever is registered, so a new
tool is discoverable by small models without prompt changes.

Testing: `registry.js` has no browser dependencies (`tests/tools-registry.test.js`).
Tools that touch the filesystem or git are covered end to end in
`tests/e2e/run.mjs` against a real git server.

## Custom context modes

`settings.contextMode` names an entry of `CONTEXT_MODES` in `app/src/context.js`.
A mode says how the model's preface is built for each turn:

```js
import { registerContextMode } from './context.js';

registerContextMode('terse', {
  label: 'Terse (experimental)',   // Settings → Context
  short: 'Terse',                  // chat details sidebar
  hint: 'Recent messages only, no summary and nothing retrieved.',
  recentShare: 0.8,                // share of the budget for recent turns, replayed verbatim
  summary: false,                  // include the rolling summary of older turns
  retrieve: false,                 // smart retrieval: older messages, tool output, threads, other chats
  offered: true,                   // list it in Settings
});
```

Everything else that `assembleContext` does (pinned messages, the agent's notes,
memory facts, replaying recent turns) happens in every mode. For a mode that
needs more than these switches, extend `assembleContext` behind a check on the
mode's definition (as AI-managed does behind `managed()` in agent.js) so the
other modes, whose output is training text for Squiggle Small, stay unchanged.

## Models

Models are entries in `MODELS` in `app/src/engine.js` (`runtime: 'litert' |
'wllama' | 'cloud'`, with `backend: 'webllm'` for MLC builds). See the Phones
and WebLLM sections of [CLAUDE.md](../CLAUDE.md) for what each flag does;
`tests/e2e/model-probes.mjs` runs behaviour probes against a real GGUF.

## UI

The UI is plain DOM under `app/src/ui/`, one module per area, sharing one state
object (`ui/state.js`) and a dozen helpers (`ui/dom.js`). A new panel is a
function that calls `openDrawer(title, key)` and appends to the returned
element; wire it in `openPanel` (`ui/panels.js`) and add a button in
`index.html`.
