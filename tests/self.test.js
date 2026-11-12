// The `squiggle` bash command (app/src/tools/self.js): the agent's view of itself, this chat and the user's others.
import test from 'node:test';
import assert from 'node:assert/strict';
import { squiggle, chatMarkdown, chatText, HELP_SELF } from '../app/src/tools/self.js';

const MODES = { compact: { label: 'Compress', short: 'Compress' }, smart: { label: 'Smart', short: 'Smart' } };
const chat = (id, title, updated, extra = {}) => ({ id, title, created: updated - 1000, updated, messages: [
  { id: 'm1', role: 'user', content: extra.text || 'hello' }, { id: 'm2', role: 'assistant', content: 'hi' }], ...extra });

function deps(over = {}) {
  const here = chat('s_here', 'New chat', Date.UTC(2026, 10, 11), { model: 'WLF3QAD', contextMode: 'compact' });
  const all = [here,
    chat('s_tok', 'Tokenizer zoo ideas', Date.UTC(2026, 9, 12), { text: 'compare tokenizers for the small model', model: 'cloud', contextMode: 'smart' }),
    chat('s_lunch', 'Lunch [ideas]', Date.UTC(2026, 9, 1), { text: 'what should i make tonight' })];
  const facts = [{ id: 'f1', s: 'Keal', p: 'has a son named', o: 'Dash', ts: 2 }, { id: 'f2', s: 'Keal', p: 'prefers', o: 'pushing straight to main', ts: 1 }];
  const touched = [];
  return {
    session: here, list: () => all, get: (id) => all.find(s => s.id === id) || null, touch: (s) => touched.push(s.id), touched,
    about: { model: 'LFM3 1.7B', how: 'on your GPU (WebGPU)', contextMode: 'compact', contextSize: 4096, tools: 'bash, remember, plan, ask_user, find', storage: 'synced to KealJones/squiggle-state' },
    contextModes: MODES, modelLabel: (id) => ({ WLF3QAD: 'LFM3 1.7B', cloud: 'Gemma 4 26B (Cloudflare)' })[id] || id,
    facts: () => facts.filter(f => !f.deleted), factText: (f) => `${f.s} ${f.p} ${f.o}`,
    forget: (id) => { const f = facts.find(x => x.id === id); if (f) f.deleted = true; return f || null; },
    ...over,
  };
}

test('squiggle with no subcommand says what it is, how it runs, and this chat with its own settings', async () => {
  const r = await squiggle([], deps());
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /You are Squiggle/);
  assert.match(r.stdout, /Model: LFM3 1\.7B, running on your GPU \(WebGPU\)\./);
  assert.match(r.stdout, /Context: Compress, a 4096-token window\./);
  assert.match(r.stdout, /This chat: \[New chat\]\(#chat=s_here\)/);
  assert.match(r.stdout, /context type: Compress/);
  assert.ok(r.stdout.length < 900, `about is ${r.stdout.length} characters; it has to fit a 4K window`);
});

test('squiggle chats lists recent chats as links the reply can copy, newest first, this one marked', async () => {
  const r = await squiggle(['chats'], deps());
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^- \[New chat\]\(#chat=s_here\) 2026-11-11 \(this chat\)$/);
  assert.match(lines[1], /^- \[Tokenizer zoo ideas\]\(#chat=s_tok\) 2026-10-12$/);
  assert.match(lines[2], /^- \[Lunch ideas\]\(#chat=s_lunch\)/, 'brackets in a title would break the link');
  assert.match(r.stdout, /put its link in your reply exactly as shown/);
});

test('squiggle chats WORDS finds chats by title or message text', async () => {
  const r = await squiggle(['chats', 'tokenizers'], deps());
  assert.match(r.stdout, /^- \[Tokenizer zoo ideas\]\(#chat=s_tok\)/);
  assert.doesNotMatch(r.stdout, /Lunch/);
  const none = await squiggle(['chats', 'kubernetes'], deps());
  assert.equal(none.exitCode, 0);
  assert.match(none.stdout, /No chats mention "kubernetes"/);
});

test('squiggle chats -n caps the list and says how many more there are', async () => {
  const r = await squiggle(['chats', '-n', '1'], deps());
  assert.equal(r.stdout.split('\n').filter(l => l.startsWith('- ')).length, 1);
  assert.match(r.stdout, /\(2 more/);
});

test('squiggle chat ID shows another chat\'s own settings; unknown ids fail', async () => {
  const r = await squiggle(['chat', 's_tok'], deps());
  assert.match(r.stdout, /^Chat: \[Tokenizer zoo ideas\]\(#chat=s_tok\)/);
  assert.match(r.stdout, /model: Gemma 4 26B \(Cloudflare\)/);
  assert.match(r.stdout, /context type: Smart/);
  const bad = await squiggle(['chat', 'nope'], deps());
  assert.equal(bad.exitCode, 1);
});

test('squiggle rename renames only this chat and saves it', async () => {
  const d = deps();
  const r = await squiggle(['rename', '"Self-aware', 'Squiggle"'], d);
  assert.equal(r.exitCode, 0);
  assert.equal(d.session.title, 'Self-aware Squiggle');
  assert.deepEqual(d.touched, ['s_here']);
  assert.equal((await squiggle(['rename'], d)).exitCode, 1, 'no title is an error, not a blank name');
});

test('squiggle memory lists saved facts with ids (newest first), filters by words, and forget removes one', async () => {
  const d = deps();
  const all = await squiggle(['memory'], d);
  assert.match(all.stdout, /^- \[f1\] Keal has a son named Dash\n- \[f2\] Keal prefers pushing straight to main/);
  const some = await squiggle(['memory', 'main'], d);
  assert.doesNotMatch(some.stdout, /Dash/);
  assert.equal((await squiggle(['forget', 'f1'], d)).exitCode, 0);
  assert.doesNotMatch((await squiggle(['memory'], d)).stdout, /Dash/);
  assert.equal((await squiggle(['forget', 'f9'], d)).exitCode, 1);
});

test('squiggle memory with nothing saved tells the model how to save', async () => {
  const r = await squiggle(['memory'], deps({ facts: () => [] }));
  assert.match(r.stdout, /save it with remember/);
});

test('squiggle --help anywhere prints the help; unknown subcommands fail with the list', async () => {
  assert.equal((await squiggle(['chats', '--help'], deps())).stdout.trim(), HELP_SELF.trim());
  const r = await squiggle(['launch'], deps());
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /squiggle chats/);
});

test('chatMarkdown makes a hash link ui/links.js opens', () => {
  assert.equal(chatMarkdown({ id: 's0abc', title: 'A\nB [x]' }), '[A B x](#chat=s0abc)');
  assert.equal(chatMarkdown({ id: 's0abc', title: '' }), '[Untitled chat](#chat=s0abc)');
});

test('chatText is the whole chat as markdown: title first, settings, every message with who/when/id, tools, attachments', () => {
  const s = {
    id: 's_tok', title: 'Tokenizer zoo ideas', created: Date.UTC(2026, 9, 12, 15), updated: Date.UTC(2026, 9, 12, 16),
    model: 'WLF3QAD', contextMode: 'compact', threads: { t1: { title: 'side quest' } },
    messages: [
      { id: 'm1', role: 'user', content: 'compare tokenizers', ts: Date.UTC(2026, 9, 12, 15), attachments: [{ name: 'notes.pdf', path: 'home/attachments/s_tok/notes.pdf.txt' }] },
      { id: 'm2', role: 'assistant', content: 'Here is the plan.', ts: Date.UTC(2026, 9, 12, 15, 1), tools: [{ name: 'bash', label: 'ran ls /repos', ok: true }, { name: 'curl', label: 'fetch failed', ok: false }] },
      { id: 'm3', role: 'user', content: '(gone)', deleted: true },
      { id: 'm4', role: 'user', content: 'in a thread', thread: 't1', ts: Date.UTC(2026, 9, 12, 16) },
    ],
  };
  const t = chatText(s, { modelLabel: () => 'LFM3 1.7B', contextModes: MODES });
  const lines = t.split('\n');
  assert.equal(lines[0], '# Tokenizer zoo ideas');
  assert.match(lines[1], /^Link: \[Tokenizer zoo ideas\]\(#chat=s_tok\) · id s_tok · model: LFM3 1\.7B · context type: Compress$/);
  assert.match(lines[2], /3 messages$/, 'deleted messages are left out');
  assert.match(t, /\n## user · 2026-10-1\d \d\d:\d\d · m1\n\[attached: notes\.pdf → \/home\/attachments\/s_tok\/notes\.pdf\.txt\]\ncompare tokenizers\n/);
  assert.match(t, /\n## assistant · .* · m2\nHere is the plan\.\n\n- bash: ran ls \/repos\n- ✕ curl: fetch failed\n/);
  assert.match(t, /## user · .* · m4 · thread: side quest\nin a thread\n$/);
  assert.doesNotMatch(t, /\(gone\)/);
});

test('squiggle read prints a whole chat (this one by default) for pipes; unknown ids fail', async () => {
  const d = deps();
  const here = await squiggle(['read'], d);
  assert.equal(here.exitCode, 0);
  assert.match(here.stdout, /^# New chat\n/);
  const other = await squiggle(['read', 's_tok'], d);
  assert.match(other.stdout, /^# Tokenizer zoo ideas\n[\s\S]*compare tokenizers for the small model/);
  assert.equal((await squiggle(['read', 'nope'], d)).exitCode, 1);
});
