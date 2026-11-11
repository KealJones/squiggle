// Demo mode: Squiggle without a GitHub account. The real app, with its storage in this browser only
// (storage.js `useLocalStorage`): chats, memory and /home files are saved to the same local git repo the
// synced setup uses, but nothing is pushed anywhere. The git and GitHub tools are left out (agent.js
// `modelTools`), everything else works: the on-device model, web search and page reads, Wikipedia lookups,
// memory, past-chat search, files, run_js, voice. Signing in later carries what was made here into the
// chosen storage repo (storage.js `useStorage`).
//
// Sample data is seeded so there's something for memory and search to find on the first message: a short
// past chat where the person named a project, a few facts about them, and one file in /home. Every seeded
// record is marked `demo: true` so `clearSamples` can remove just those.
import * as storage from './storage.js';
import * as sessions from './sessions.js';
import * as memory from './memory.js';

export const isDemo = () => storage.isLocal();

const DAY = 24 * 3600 * 1000;

// Things to try, shown on the banner. Each is answered from the seeded data, not from the model's weights.
export const TRY = [
  'What did I name my log parser, and why?',
  'What do you know about me?',
  'Read /home/pip/README.md and suggest a first milestone',
];

export const FACTS = [
  { s: 'the user', p: 'is trying', o: 'Squiggle in demo mode', note: 'sample' },
  { s: 'the user', p: 'prefers', o: 'short answers that say which sources they used', note: 'sample' },
  { s: 'the user', p: 'is building', o: 'Pip, a command-line log parser', note: 'sample' },
  { s: 'Pip', p: 'is written in', o: 'Rust', note: 'sample' },
  { s: 'Pip', p: 'reads', o: 'nginx access and error logs', note: 'sample' },
];

const PIP_README = `# Pip

A small Rust command-line tool that reads nginx access and error logs and
summarises error spikes: which routes, which status codes, when.

## Plan

- Parse the combined log format (done)
- Group 5xx responses by route and minute
- Print a one-screen summary; \`--json\` for scripts
- Later: tail a live log file
`;

export async function seed() {
  await storage.write('home/pip/README.md', PIP_README);
  for (const f of FACTS) {
    const fact = memory.add({ ...f, source: 'demo' });
    memory.update(fact.id, { demo: true });
  }
  const s = sessions.newSession('Naming the log parser');
  s.demo = true;
  const t0 = Date.now() - 2 * DAY;
  const say = (role, content, i) => { const m = sessions.addMessage(s, { role, content }); m.ts = t0 + i * 60000; return m; };
  say('user', "I'm writing a Rust CLI that reads nginx logs and summarises error spikes. Need a name. Short, typeable, not taken by anything big.", 0);
  say('assistant', 'A few short ones: **pip** (a small seed; also what a log line is), **tally**, **sift**, **lumen**. Of those, `pip` is the shortest to type, but it collides with the Python package manager on PATH, so the binary might want a different name.', 1);
  say('user', "Pip it is. I like that it's a seed. I'll call the binary `pipl` if the clash bites.", 2);
  say('assistant', 'Noted: the project is **Pip**, a Rust CLI for parsing nginx logs, named for a seed; the binary may be `pipl` if `pip` clashes.', 3);
  s.created = t0; s.updated = t0 + 4 * 60000;   // after addMessage, which touches (and dates) the session
  await memory.flush();
  await sessions.flush({ sync: false });
  await storage.sync();
}

// Removes the seeded chat, facts and file; what the person made stays.
export async function clearSamples() {
  for (const s of [...sessions.list(), ...sessions.listArchived()]) if (s.demo) sessions.remove(s);
  for (const f of memory.all()) if (f.demo) memory.remove(f.id);
  await storage.remove('home/pip/README.md').catch(() => {});
  await memory.flush();
  await sessions.flush({ sync: false });
  await storage.sync();
}
