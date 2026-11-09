# README screenshots

The README has four screenshot slots (HTML comments `<!-- screenshot: docs/images/… -->`). They need the real
app with a real model, so they're taken by hand on a machine with WebGPU, not by the e2e suite (whose
screenshots show the scripted "Fake E4B" and would mislead). Take them at 1400 × 900 in light mode with the
chat details sidebar open, drop them here, and swap each comment for

```html
<p align="center"><img src="docs/images/NAME.png" width="900" alt="…"></p>
```

1. **demo.png**: demo mode, a new chat, after the "What did I name my log parser, and why?" chip: the demo
   banner, the reply naming Pip, "find" in the tool list, the sidebar's context breakdown.
2. **context.png**: the chat details sidebar on a Fresh-context reply: Instructions / Tool definitions /
   Recalled / Request / This turn / Free space, and "What the model saw" open beside it.
3. **steps.png**: a planned task mid-way: the live step list under the message, Progress in the sidebar with
   a step done and one running, the context bar for that step.
4. **approval.png**: the push-approval card (Allow once / Always allow / Don't allow) for a push to `main`,
   ideally after the agent read a page and said it ignored instructions in it.

A GIF of one turn (ask → find hits memory → reply → "What the model saw") would sit well under the first
heading; `tests/e2e/model-drive.mjs` can script the turn, Chrome's recorder or any screen tool can capture it.
