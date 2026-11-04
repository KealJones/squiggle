import test from 'node:test';
import assert from 'node:assert/strict';
import { overlap } from '../app/src/search.js';
import { rankFacts, aboutTheUser, factText } from '../app/src/memory-rank.js';

// Facts like the ones a few weeks of chats left in memory/facts.jsonl: most share "user" or "Squiggle".
const FACTS = [
  { id: 'f1', s: 'user', p: 'considers using', o: 'SQLite for a memory store' },
  { id: 'f2', s: 'user', p: 'uses', o: 'Markdown files', note: 'for memory storage' },
  { id: 'f3', s: 'user', p: 'prefers', o: 'Markdown files' },
  { id: 'f4', s: 'User', p: 'is exploring', o: 'Gemma 4 E2B model optimization' },
  { id: 'f5', s: 'Squiggle', p: 'has_tools', o: 'git_show,edit_file' },
  { id: 'f6', s: 'Squiggle', p: 'is_a', o: 'private AI agent' },
  { id: 'f7', s: 'Squiggle', p: 'runs_in', o: 'web browser' },
  { id: 'f8', s: 'KealJones', p: 'has_project', o: 'Shorten' },
  { id: 'f9', s: 'KealJones', p: 'has_project', o: 'animate.as' },
  { id: 'f10', s: 'the user\'s name', p: 'is', o: 'Keal' },
];

test('overlap: an absolute score; words on most records count for nothing', () => {
  const cov = overlap(FACTS.map(f => ({ id: f.id, text: factText(f) })));
  assert.ok(cov.generic.has('user'), [...cov.generic].join(','));
  assert.ok(cov.generic.has('squiggle'));
  assert.ok(!cov.generic.has('markdown'));
  const s = cov.score('what is emma stone\'s latest movie? identify topics, start exploring');
  assert.ok([...s.values()].every(v => v < 0.2), 'one word ("exploring") out of eight scores under the bar: ' + JSON.stringify([...s]));
  assert.equal(cov.score('what is emma stone\'s latest movie?').size, 0, 'nothing in common with any fact: nothing scores');
  const m = cov.score('convert my notes to markdown');
  assert.ok(m.get("f3") >= 0.3 && m.get("f3") <= 1, String(m.get("f3")));
  assert.ok(m.get('f2') > 0 && m.get('f2') < m.get('f3'), 'a longer fact is covered less by the same word');
  assert.equal(m.get('f1'), undefined);
  // "user" and "squiggle" alone match nothing, even though they're in most facts.
  assert.equal(cov.score('hello user, squiggle').size, 0);
});

test('rankFacts: unrelated requests recall nothing, and no hop through "user" or "Squiggle"', () => {
  assert.deepEqual(rankFacts(FACTS, 'What is Emma Stone\'s latest movie?'), []);
  assert.deepEqual(rankFacts(FACTS, 'lol you have some pretty shit tools how would you figure anything out'), []);
  const r = rankFacts(FACTS, 'where do I keep my notes, markdown or sqlite?').map(x => x.fact.id);
  assert.ok(r.includes('f3') && r.includes('f2') && r.includes('f1'), r.join(','));
  assert.ok(!r.includes('f4') && !r.includes('f6') && !r.includes('f7'), 'facts that only share "user"/"Squiggle" stay out: ' + r.join(','));
});

test('rankFacts: one hop through a specific entity, at half the score', () => {
  const r = rankFacts(FACTS, 'tell me about the Shorten project');
  const ids = r.map(x => x.fact.id);
  assert.equal(ids[0], 'f8');
  assert.ok(ids.includes('f9'), 'KealJones is specific (two of ten facts), so the other project comes along: ' + ids.join(','));
  const top = r.find(x => x.fact.id === 'f8').score, hop = r.find(x => x.fact.id === 'f9').score;
  assert.ok(hop <= top * 0.5 + 1e-9);
  assert.ok(!ids.includes('f10'));
});

test('rankFacts: with embeddings the semantic score is blended, still on an absolute scale', () => {
  const sem = new Map(FACTS.map(f => [f.id, f.id === 'f4' ? 0.7 : 0.05]));
  const r = rankFacts(FACTS, 'making small gemma models faster', { sem }).map(x => [x.fact.id, Math.round(x.score * 100) / 100]);
  assert.equal(r[0][0], 'f4');
  assert.ok(r.every(([id, s]) => id === 'f4' || s < 0.25), JSON.stringify(r));
});

test('aboutTheUser: facts about the assistant itself are kept only when the user said them', () => {
  assert.equal(aboutTheUser({ s: 'user', p: 'prefers', o: 'Markdown files' }, 'I like markdown'), true);
  assert.equal(aboutTheUser({ s: 'Squiggle', p: 'is_a', o: 'private AI agent' }, 'what is Emma Stone\'s latest movie?'), false);
  assert.equal(aboutTheUser({ s: 'Squiggle', p: 'has_tool', o: 'chat renaming' }, 'hiii'), false);
  assert.equal(aboutTheUser({ s: 'squiggle', p: 'stores sessions in', o: 'a private GitHub repo' }, 'remember that squiggle stores its sessions in a private github repo'), true);
  assert.equal(aboutTheUser({ s: 'the assistant', p: 'can', o: 'search the web' }, 'can you search the web?'), true);
});
