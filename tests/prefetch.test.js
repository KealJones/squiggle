import test from 'node:test';
import assert from 'node:assert/strict';
import { namesIn, isFollowUp, standalone, smallTalk, rank, exchangeCandidates, render, doRequest, pointsBack } from '../app/src/prefetch.js';

const PREV = 'What is the latest movie that Patrick Stewart was is?';
const LINE = [
  { id: 'm1', role: 'user', content: PREV, ts: 1 },
  { id: 'm2', role: 'assistant', content: 'Patrick Stewart has been acting in Avengers: Doomsday as Professor X.', ts: 2 },
  { id: 'm3', role: 'user', content: 'Can you tell me what 5 * 5 / 129 is?', ts: 3 },
  { id: 'm4', role: 'assistant', content: 'It is about 0.19.', ts: 4 },
];

test('namesIn keeps names and drops question and filler words', () => {
  assert.deepEqual(namesIn(PREV), ['Patrick', 'Stewart']);
  assert.deepEqual(namesIn('Awesome, what about his most recent released movie?'), []);
  assert.deepEqual(namesIn("What is Emma stone's latest movie? Is it Bugonia?"), ['Emma', 'Bugonia']);
});

test('a follow-up borrows the names of the question before it; a new question stands on its own', () => {
  assert.equal(isFollowUp('Awesome, what about his most recent released movie?'), true);
  assert.equal(isFollowUp('What is Emma Stone\'s latest movie?'), false);
  assert.deepEqual(standalone('Awesome, what about his most recent released movie?', { prevUser: PREV }),
    { query: 'Patrick Stewart his most recent released movie?', borrowed: 'Patrick Stewart' });
  assert.equal(standalone('What is Emma Stone\'s latest movie?', { prevUser: PREV }).query, 'What is Emma Stone\'s latest movie?');
  assert.equal(standalone('what about that one?', { prevUser: '' }).query, 'what about that one?', 'nothing to borrow from');
});

test('small talk and bare arithmetic are not looked up', () => {
  for (const m of ['hi', 'Thanks!', 'ok', 'lol', '5 * 5 / 129', 'sounds good']) assert.equal(smallTalk(m), true, m);
  for (const m of ['hi, what is the weather in Phoenix?', 'What is Emma Stone\'s latest movie?', 'thanks, can you also find his newest one?']) assert.equal(smallTalk(m), false, m);
});

test('rank keeps only what clears the bar, and a named query needs the name', () => {
  const ex = exchangeCandidates(LINE);
  assert.equal(ex.length, 2);
  assert.equal(ex[1].boost, 0.05, 'the last exchange gets a small boost');
  const follow = standalone('Awesome, what about his most recent released movie?', { prevUser: PREV }).query;
  assert.deepEqual(rank(follow, ex).map(x => x.ref), ['m1']);
  assert.deepEqual(rank('What is Emma Stone\'s latest movie?', ex), [], '"latest movie" alone is not a match for another person');
  assert.deepEqual(rank('how do I bake bread', ex), []);
});

test('rank by meaning uses the vectors and the same name rule', () => {
  const cands = [{ id: 'a', text: 'Patrick Stewart latest film' }, { id: 'b', text: 'bread recipe with yeast' }, { id: 'c', text: 'Emma Stone newest movie' }];
  const vecs = [[1, 0], [0.9, 0.1], [0, 1], [0.95, 0.05]];   // query, a, b, c
  assert.deepEqual(rank('newest Patrick Stewart movie', cands, { vecs }).map(x => x.id), ['a'], 'c is close by meaning but names someone else');
  assert.deepEqual(rank('a new movie to watch', cands, { vecs }).map(x => x.id), ['c', 'a']);
});

test('render labels everything as looked up, never as the user, and is empty when nothing was found', () => {
  assert.equal(render({ query: 'x' }), '');
  const wrap = (src, t) => `<untrusted key="${src}">${t}</untrusted>`;
  const text = render({
    query: 'Patrick Stewart most recent movie',
    exchanges: [{ question: PREV, answer: 'Avengers: Doomsday (2026).' }],
    facts: ['User likes sci-fi'],
    web: { query: 'Patrick Stewart most recent movie 2026', items: [{ title: 'Patrick Stewart', url: 'https://example.org/ps', snippet: 'His last role…' }] },
  }, { wrap, small: true });
  assert.match(text, /^Looked up before answering, for "Patrick Stewart most recent movie" \(search results, not the user's words\):/);
  assert.match(text, /Earlier in this chat:\n- The user asked "What is the latest movie.*"; you answered "Avengers: Doomsday \(2026\)\."/);
  assert.match(text, /Memory:\n- User likes sci-fi/);
  assert.match(text, /Web search for "Patrick Stewart most recent movie 2026":\n<untrusted key="web search">1\. Patrick Stewart\n {3}https:\/\/example\.org\/ps/);
  assert.match(text, /call fetch_url with its link/);
  assert.match(render({ query: 'q', web: { error: 'HTTP 503', items: [] } }), /The web search failed: HTTP 503/);
});

// Keal's messages from 2026-11-09 (LFM2.5 1.2B, Fresh context): Fresh looked up "Sick, Sick, Sick" and the actress
// Uhm Ji-won for them, then the model planned around the junk; and "that console.log" lost the script it meant.
const SICK = 'Sick I only asked if you could run js which you did immediately so idk why you took so long to explain it, but anyway. can you help me write a generator js for loop function that like returns every mod 2 of 1 to 100.';
const UHM = 'Uhm thank you for that! Can run that console.log of the generator script using run_js and share the output?';

test('namesIn: a capitalised word starting a sentence is a name only when another name follows it', () => {
  assert.deepEqual(namesIn(SICK), []);
  assert.deepEqual(namesIn(UHM), []);
  assert.deepEqual(namesIn('Patrick Stewart was great. Bugonia too'), ['Patrick', 'Stewart']);
  assert.deepEqual(namesIn('Did you see Bugonia? Emma Stone is in it'), ['Bugonia', 'Emma', 'Stone']);
});

test('doRequest: asking Squiggle to do or make something is not a question to look up', () => {
  for (const m of [SICK, UHM, 'write me a for loop that prints the evens', 'Run that script with run_js', 'could u help me fix this function', 'ok cool, now make it a generator']) assert.equal(doRequest(m), true, m);
  for (const m of [PREV, 'Who directed Jaws?', 'Can you tell me what 5 * 5 / 129 is?', 'what is a generator function in js?', 'Hiii']) assert.equal(doRequest(m), false, m);
});

test('a message that points back is a follow-up once filler words stop counting as names', () => {
  assert.equal(pointsBack(UHM), true);
  assert.equal(isFollowUp(UHM), true);
});

test('render: the exchange a message points back at keeps its reply as written (code and all)', () => {
  const code = 'function* odds() {\n  for (let i = 1; i <= 100; i++) if (i % 2) yield i;\n}';
  const text = render({ query: UHM, exchanges: [{ question: 'write the generator', answer: `Here it is:\n\n\`\`\`js\n${code}\n\`\`\``, full: true }] }, { small: true });
  assert.ok(text.includes(`you answered:\nHere it is:\n\n\`\`\`js\n${code}\n\`\`\``), text);
});
