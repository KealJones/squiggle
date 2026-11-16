// A reply's checkpoint, so a reply the page lost (iOS reloads a Safari tab it killed in the background) is picked up
// again on the next open instead of vanishing. One record in localStorage (writes are synchronous, so it survives the
// tab being killed, like model-ui.js's crash marker); the turn state itself stays where it already lives
// (session.tasks, the saved session). The checkpoint only adds what isn't saved anywhere else: which turn, which phase,
// the reply text so far, the tool calls that already ran (with results, so none runs again) and the raw text of the
// call in flight, which the WebLLM raw formats carry on from (engine-webllm.js `resume_raw`).
// The GPU going away with the tab still open never reaches this: the engine shim carries on by itself.
const KEY = 'squiggle-resume';
// A reply picked up this many times that still died is left as it is: a tab killed for memory every time would loop.
export const MAX_TRIES = 2;
export const SAVE_EVERY = 1000;

const store = () => { try { return globalThis.localStorage; } catch { return null; } };

export function load(s = store()) {
  try { const c = JSON.parse(s.getItem(KEY)); return c && c.v === 1 && c.session && c.user ? c : null; } catch { return null; }
}
export function clear(s = store()) { try { s.removeItem(KEY); } catch {} }

// Keeps the record for one turn. set() writes now (tool results, step boundaries); partial() is for the stream and
// writes about once a second. A full storage drops the tool results first (the turn goes on from their labels).
export class Checkpoint {
  constructor(base, { s = store(), now = Date.now, every = SAVE_EVERY } = {}) {
    this.cp = { v: 1, raw: '', tools: [], prefix: '', ...base };
    Object.assign(this, { s, now, every, last: 0 });
    this.write();
  }
  write() {
    this.last = this.now();
    this.cp.ts = this.last;
    try { this.s.setItem(KEY, JSON.stringify(this.cp)); } catch {
      try { this.s.setItem(KEY, JSON.stringify({ ...this.cp, tools: this.cp.tools.map(({ result, ...t }) => t) })); } catch {}
    }
  }
  set(patch) { Object.assign(this.cp, patch); this.write(); }
  partial(raw) { this.cp.raw = raw; if (!raw || this.now() - this.last >= this.every) this.write(); }
  clear() { clear(this.s); }
}

// What a loaded checkpoint should do now: 'resume' it (counting the try), or 'give-up' (it was tried MAX_TRIES times).
export const decide = (cp) => ((cp.tries || 0) >= MAX_TRIES ? 'give-up' : 'resume');

// What was written when a reply is given up: the text so far (or the thinking, if that's all there was), and why it stopped.
export function leftOver(cp) {
  const after = /<\/think>([\s\S]*)$/.exec(cp.raw || '');   // what follows the thinking; thinking alone isn't a reply
  const rawText = after ? after[1].replace(/<tool_call>[\s\S]*$/, '').trim() : '';
  const text = [cp.prefix, rawText].filter(Boolean).join('\n\n').trim();
  return `${text ? text + '\n\n' : ''}_(This reply was interrupted ${MAX_TRIES} times and picked up again each time, so Squiggle stopped. Send the message again to retry.)_`;
}
