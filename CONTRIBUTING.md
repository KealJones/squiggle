# Contributing

## Setup

Node 22 (`.nvmrc`), then `npm ci`. There is no build step: `app/` is served as
is. `npm run dev` runs the Worker with the app at http://localhost:8787.

## Before you push

```bash
npm run check          # ESLint + unit tests
npm run test:e2e       # headless Chromium against a real git server (a few minutes)
```

CI runs both, plus the split-origin e2e mode and a Worker dry-run. Pull
requests from this repo also get a live preview on GitHub Pages
(`pr-preview/pr-<n>/`), linked from a comment on the PR.

## Where things go

[CLAUDE.md](CLAUDE.md) is the map of the codebase and the list of invariants;
read the invariants before touching tools, pushes, paths or anything the model
sees. [docs/extending.md](docs/extending.md) covers adding tools and context
modes. [docs/harness.md](docs/harness.md) is the contract for the agent loop
and the small-model fine-tune: change prompts and the doc together.

## Style

- Plain ES modules, no framework, no transpiling. Browser code must run as
  written in current Chrome and Safari.
- ESLint enforces correctness rules only (unused variables, undefined names,
  `prefer-const`, …). There is no formatter; match the surrounding code.
- Comments explain why, especially around model behaviour ("a small model did
  X, so …"). Keep those when you move code.
- Anything the model sees that came from outside goes through `wrapUntrusted`.
- Every synced file must merge or keep both versions (CLAUDE.md, Invariants).

## Tests

- Unit tests are `node --test` files in `tests/`; pure modules get one.
- `tests/e2e/run.mjs` drives two browser "devices" through sync, git tools,
  the sandbox and a scripted agent turn (`tests/e2e/fake-engine.js` replaces
  the model). `E2E_ONLY=<part of a check name>` runs a subset.
- Real-model behaviour needs a WebGPU device and is checked by hand;
  `tests/e2e/model-probes.mjs` has paired probes for small models.

## Commits

Small, focused commits with a message that says what changed and why. Pull
requests against `main`.
