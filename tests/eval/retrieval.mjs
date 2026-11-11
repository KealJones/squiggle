// Memory recall benchmark: how the rankers behind `recall` and `find` do on a small labelled set, with no model
// involved (pure node, a second to run). It exists to make the ranking decisions in search.js / memory-rank.js
// checkable: the absolute bar (overlap) against normalized BM25, the one-hop expansion, and find's rule that a
// question naming someone only takes facts naming them (docs/failures.md case 1).
//
//   node tests/eval/retrieval.mjs            prints the table (docs/evals.md keeps the last run)
//   node tests/eval/retrieval.mjs --json     the numbers as JSON
//   node tests/eval/retrieval.mjs --facts memory/facts.jsonl --queries my-queries.json
//        your own facts file and queries ([{ q, ids: [fact ids], none?: true }]) instead of the built-in set
//
// The built-in set is synthetic (written for this benchmark, not from a real chat): 40 facts about one person
// and their work, 24 questions, 8 of them about other things where the right answer is nothing. Treat the
// numbers as a regression check on the rankers, not as a claim about real usage.
import { readFileSync } from 'node:fs';
import { bm25, blend } from '../../app/src/search.js';
import { rankFacts, factText } from '../../app/src/memory-rank.js';
import { namesIn } from '../../app/src/prefetch.js';

const arg = (n, d) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d;

// ── The set ────────────────────────────────────────────────────────────────

const F = (id, s, p, o, note) => ({ id, s, p, o, ...(note ? { note } : {}) });
export const FACTS = [
  F('f1', 'the user', 'is named', 'Sam'),
  F('f2', 'the user', 'works at', 'Northwind as a frontend engineer'),
  F('f3', 'the user', 'prefers', 'short answers'),
  F('f4', 'the user', 'prefers', 'metric units'),
  F('f5', 'the user', 'drinks', 'tea, not coffee'),
  F('f6', 'the user', 'lives in', 'Phoenix'),
  F('f7', 'the user', 'has a dog named', 'Pip'),
  F('f8', 'the user', 'is building', 'Orbit, a React dashboard for shipping metrics'),
  F('f9', 'Orbit', 'uses', 'Vite and TypeScript'),
  F('f10', 'Orbit', 'deploys to', 'GitHub Pages'),
  F('f11', 'Orbit', 'has a bug in', 'the date picker on Safari'),
  F('f12', 'the user', 'is building', 'Lumen, a Rust CLI that parses nginx logs'),
  F('f13', 'Lumen', 'is written in', 'Rust'),
  F('f14', 'Lumen', 'reads', 'nginx access and error logs'),
  F('f15', 'Lumen', 'lives in', 'the repo sam/lumen'),
  F('f16', 'the user', 'decided', 'to store Orbit settings in SQLite, not JSON files'),
  F('f17', 'Dana', 'is', "the user's partner"),
  F('f18', 'Dana', 'likes', 'hiking and board games'),
  F('f19', 'Dana', 'has a birthday on', 'March 3'),
  F('f20', 'Lee', 'is', "the user's manager"),
  F('f21', 'Lee', 'wants', 'a demo of Orbit by Friday'),
  F('f22', 'the user', 'uses', 'an iPhone 16 and a MacBook Air'),
  F('f23', 'the user', 'runs', 'Squiggle on the iPhone with the small model'),
  F('f24', 'the user', 'is learning', 'Spanish on weekday mornings'),
  F('f25', 'the user', 'plays', 'chess online most evenings'),
  F('f26', 'the user', 'is training for', 'a half marathon in December'),
  F('f27', 'the user', 'is allergic to', 'nothing'),
  F('f28', 'the user', 'wants reminders', 'on Monday mornings'),
  F('f29', 'the user', 'keeps notes in', 'Obsidian'),
  F('f30', 'Northwind', 'uses', 'Jira for tickets and Slack for chat'),
  F('f31', 'Northwind', 'has a release', 'every second Tuesday'),
  F('f32', 'the user', 'is considering', 'moving Lumen from clap to argh'),
  F('f33', 'the user', 'likes', 'Oswald the Lucky Rabbit cartoons'),
  F('f34', 'the user', 'reads', 'mostly science fiction'),
  F('f35', 'the user', 'is planning', 'a trip to Lisbon in May with Dana'),
  F('f36', 'the user', 'asked Squiggle', 'to always show its sources'),
  F('f37', 'Orbit', 'shows', 'on-time delivery and refund rates'),
  F('f38', 'the user', 'tested', 'Qwen3 0.6B on the phone; it stayed under 1 GB'),
  F('f39', 'the user', 'has a sister named', 'Riley in Denver'),
  F('f40', 'Riley', 'works as', 'a nurse'),
];

// q: the question; ids: the facts a good recall returns (any order); none: a question about other things, where
// the right answer is nothing at all.
export const QUERIES = [
  { q: "What's my name?", ids: ['f1'] },
  { q: "What's my dog's name?", ids: ['f7'] },
  { q: 'Where do I live?', ids: ['f6'] },
  { q: 'What is Orbit built with?', ids: ['f8', 'f9'] },
  { q: 'Where does Orbit deploy?', ids: ['f10'] },
  { q: 'Remind me about the Orbit bug', ids: ['f11'] },
  { q: 'What language is Lumen in?', ids: ['f12', 'f13'] },
  { q: 'Which repo is the log parser in?', ids: ['f12', 'f14', 'f15'] },
  { q: 'Did I decide on SQLite or JSON for Orbit settings?', ids: ['f16'] },
  { q: "When is Dana's birthday?", ids: ['f19'] },
  { q: 'What does Dana like doing?', ids: ['f18'] },
  { q: 'Who is my manager and what do they want?', ids: ['f20', 'f21'] },
  { q: 'Which phone do I have?', ids: ['f22'] },
  { q: 'What am I training for?', ids: ['f26'] },
  { q: 'Where are we going in May?', ids: ['f35'] },
  { q: 'What does my sister do?', ids: ['f39', 'f40'] },
  // About other things: a good recall returns nothing (docs/failures.md case 1: "the user's name is Keal" answered
  // "What is Emma Stone's real name?").
  { q: "What is Emma Stone's real name?", ids: [], none: true },
  { q: 'Who directed Jaws?', ids: [], none: true },
  { q: 'How do I reverse a list in Python?', ids: [], none: true },
  { q: 'What is the capital of Peru?', ids: [], none: true },
  { q: "What is Patrick Stewart's most recent movie?", ids: [], none: true },
  { q: 'How many grams in an ounce?', ids: [], none: true },
  { q: 'Write a React hook that debounces a value', ids: [], none: true },
  { q: 'Is Rust faster than Go for parsing logs?', ids: [], none: true },
];

// ── Rankers ────────────────────────────────────────────────────────────────

const K = 8;
const top = (scores, bar) => [...scores.entries()].filter(([, s]) => s > bar).sort((a, b) => b[1] - a[1]).slice(0, K).map(([id]) => id);

// find's rule for named questions: a fact must name who the question names.
const named = (q, facts) => {
  const names = namesIn(q).map(n => n.toLowerCase());
  return names.length ? facts.filter(f => names.some(n => factText(f).toLowerCase().includes(n))) : facts;
};

export const RANKERS = {
  // Normalized BM25: the best match scores 1 whatever it is, so something always comes back.
  'BM25, relative bar 0.2': (facts, q) => top(blend(bm25(facts.map(f => ({ id: f.id, text: factText(f) })))(q), null), 0.2),
  // The absolute overlap bar alone (search.js overlap): nothing shared, nothing returned.
  'overlap, absolute bar 0.2': (facts, q) => rankFacts(facts, q, { k: K }).map(r => r.fact.id).filter((id, i, a) => a.indexOf(id) === i && !isHop(facts, q, id)),
  // What recall does: overlap plus one hop through a specific shared entity.
  'overlap + 1-hop (recall)': (facts, q) => rankFacts(facts, q, { k: K }).map(r => r.fact.id),
  // What find does on top: a question naming someone only takes facts naming them (a filter on recall's
  // result, as in find.js; ranking a pre-filtered set would make the name a "generic" word and lose it).
  'recall + named-only (find)': (facts, q) => named(q, rankFacts(facts, q, { k: K }).map(r => r.fact)).map(f => f.id),
};
// A hop is a fact that only comes back through the expansion (its own overlap score is 0).
function isHop(facts, q, id) {
  const own = rankFacts(facts.filter(f => f.id === id), q, { k: 1 });
  return own.length === 0;
}

// ── Scoring ────────────────────────────────────────────────────────────────

export function score(ranker, facts, queries) {
  let tp = 0, fp = 0, fn = 0, cleanNone = 0, nNone = 0, hit1 = 0, nAsk = 0;
  const rows = [];
  for (const { q, ids, none } of queries) {
    const got = ranker(facts, q);
    const want = new Set(ids);
    const g = new Set(got);
    const t = [...g].filter(x => want.has(x)).length;
    tp += t; fp += got.length - t; fn += ids.length - t;
    if (none) { nNone++; if (!got.length) cleanNone++; }
    else { nAsk++; if (got.length && want.has(got[0])) hit1++; }
    rows.push({ q, want: ids, got });
  }
  const precision = tp + fp ? tp / (tp + fp) : 1, recall = tp + fn ? tp / (tp + fn) : 1;
  return { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, top1: hit1 / nAsk, clean: cleanNone / nNone, rows };
}

function loadOwn() {
  const factsPath = arg('--facts', ''), queriesPath = arg('--queries', '');
  if (!factsPath) return { facts: FACTS, queries: QUERIES };
  const facts = readFileSync(factsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(f => !f.deleted);
  const queries = JSON.parse(readFileSync(queriesPath, 'utf8'));
  return { facts, queries };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { facts, queries } = loadOwn();
  const out = {};
  for (const [name, r] of Object.entries(RANKERS)) out[name] = score(r, facts, queries);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
  const pct = (x) => (100 * x).toFixed(0) + '%';
  console.log(`${facts.length} facts, ${queries.length} questions (${queries.filter(q => q.none).length} about other things), top ${K}\n`);
  console.log('| ranker | precision | recall | F1 | top-1 right | nothing for unrelated |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const [name, s] of Object.entries(out)) console.log(`| ${name} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)} | ${pct(s.top1)} | ${pct(s.clean)} |`);
  if (process.argv.includes('--verbose')) {
    for (const [name, s] of Object.entries(out)) {
      console.log(`\n${name}`);
      for (const row of s.rows) console.log(`  ${row.q}\n    want ${JSON.stringify(row.want)} got ${JSON.stringify(row.got)}`);
    }
  }
  console.log('\n(precision/recall over all returned facts; "top-1 right": the first fact answers the question; "nothing for unrelated": questions about other things that correctly got no memory at all. Memory stays out of the prompt when nothing clears the bar.)');
}
