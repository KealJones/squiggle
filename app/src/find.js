// `find`: one search across everything Squiggle knows (docs/harness.md, "Tools
// the harness adds"): tools, recipes, memory facts, past chats and this task's
// step results. Each kind only returns what clears its own relevance bar; the
// small model gets a compact rendering (renderFind) it can act on.
//
// Pure apart from the sources passed in, so it runs in node tests.
import { bm25, tokenize } from './search.js';

// Relevance bars (see each ranking function for the scale).
export const BARS = {
  tool: 3.2,      // tool score: name words 3 each, intent phrase 4, BM25 on description (usually 1-4)
  recipe: 0.35,   // recipes.MIN_SCORE: 0..1 coverage of the request
  fact: 0.3,      // memory recall score: 0..1 blend
  text: 1,        // chats / task items: query words that must appear (see lexHits)
};

// Always available to the model, so find never offers them as results.
const HARNESS_TOOLS = new Set(['plan', 'done', 'need', 'find', 'find_tools']);

// Words that are noise in a spoken or rambling query (search.js drops the usual stop words).
const CHATTER = new Set(('hey hi uh uhh um umm like yeah gonna wanna kinda thing things stuff basically actually really ' +
  'maybe probably guess mean know think need want get got let make again thanks thx pls plz something someone anything ' +
  'talked told said remember earlier before last time ago').split(' '));

const uniq = (a) => [...new Set(a)];
// search.js's tokenizer keeps "app/src/main.js" whole-ish; split paths so "main" can match.
const split = (s) => String(s || '').replace(/[/._]+/g, ' ');
const EXT_WORDS = new Set('js mjs ts json jsonl md html css py txt csv toml yml yaml'.split(' '));
const words = (query) => uniq(tokenize(split(query))).filter(w => !CHATTER.has(w) && !EXT_WORDS.has(w));

// ── Tools ────────────────────────────────────────────────────────────────

const fnOf = (t) => (t && t.function) || t || {};

function paramList(f) {
  const props = (f.parameters && f.parameters.properties) || {};
  const req = new Set((f.parameters && f.parameters.required) || []);
  return Object.keys(props).map(name => ({ name, required: req.has(name) }));
}

const firstSentence = (s, n = 140) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  const one = m ? m[0] : s;
  return one.length > n ? one.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : one;
};

// Intent phrases people use that the tool descriptions don't. [regex on the
// lower-cased query, { tool name or 'prefix*': extra score }]. Deliberately
// short and obvious; anything cleverer belongs in the descriptions.
const INTENTS = [
  [/\b(google|duckduckgo|ddg|web ?search|look ?(it |this |that )?up|lookup|search (for )?(it )?(on )?(the )?(web|internet|online|net)|on the (web|internet|net)|online)\b/, { web_search: 6 }],
  [/\b(news|latest|weather|current price|who won|score of)\b/, { web_search: 3 }],
  [/https?:\/\/|\b(link|url|web ?page|website|site|article|blog post)\b/, { fetch_url: 4 }],
  [/\b(open|visit|go to|browse|download|scrape|summari[sz]e|read)\b.*\b(page|site|website|article|link|url)\b/, { fetch_url: 6 }],
  [/\b(open|read|show|view|cat|display|print|look at|peek at|check)\b.*\b(file|contents?|source|script|config|readme|code)\b|\b(open|read|cat|show|view)\b.*\.(js|mjs|ts|json|jsonl|md|html|css|toml|ya?ml|py|txt|csv)\b/, { read_file: 8 }],
  [/\b(what'?s in|whats in|list|ls|tree|show me the)\b.*\b(folder|directory|dir|files)\b|\bwhat files\b/, { list_files: 4 }],
  [/\b(grep|ripgrep|where is .{1,40}(defined|used|called)|occurrences?|search (the )?(code|codebase|files|repo)|find (the )?(line|function|usages?))\b/, { grep: 4 }],
  [/\b(write|create|make|save|put)\b.*\b(a |the )?(new )?(file|script|doc|readme|markdown)\b|\bsave (it |this |that )?(to|in|as)\b/, { write_file: 4 }],
  [/\b(delete|remove|rm|trash|get rid of)\b.*\b(file|folder|directory)\b|\brm\b/, { delete_file: 4 }],
  [/\b(remember|memori[sz]e|keep in mind|don'?t forget|dont forget|from now on|always|never)\b|\bsave (this|that|it)\b(?!.*\b(file|to|in|as)\b)/, { remember: 4 }],
  [/\b(what do you (know|remember)|do you (know|remember)|recall|my preferences?|about me)\b/, { recall: 4 }],
  [/\b(forget|unlearn|that'?s wrong|thats wrong|outdated|not true anymore)\b/, { forget: 4 }],
  [/\b(last time|earlier|yesterday|we (talked|discussed|did)|previous (chat|conversation)|past (chat|conversation)s?|other chat|old chat|you said|i (said|told you|mentioned))\b/, { search_history: 4 }],
  [/\b(jot|write down|notepad|scratch ?pad|todo list|take a note|note (to self|this))\b/, { note: 4 }],
  [/\b(clone|fork|download the repo|pull down the repo|check ?out the repo|pull (it |that |this |them )?down|grab (the |that |this )?(github|repo))\b/, { git_clone: 6 }],
  [/\bcommit\b/, { git_commit: 4 }],
  [/\b(push|publish|upload)\b.*\b(branch|changes|commits?|repo|github|code|origin|main)\b|\bgit push\b/, { git_push: 4 }],
  [/\b(branch|switch to|check ?out|new branch)\b/, { git_branch: 4 }],
  [/\b(pull(?! (it |that |this |them )?down)|get (the )?latest|update the repo|fast.?forward)\b/, { git_pull: 3 }],
  [/\b(git status|what changed|what'?s changed|modified files|uncommitted|dirty|diff)\b/, { git_status: 4 }],
  [/\b(git log|recent commits|commit history|commits)\b/, { git_log: 4 }],
  [/\b(pull request|open a pr|make a pr|pr for)\b/, { github_open_pr: 5 }],
  [/\b(my repos|list (my )?repos|which repos|what repos|repositories)\b/, { github_list_repos: 4 }],
  [/\bgit\b/, { 'git_*': 1.5 }],
  [/\b(calculate|compute|math|javascript|regex|parse (this|the)|convert|sort|sum of|average|how many days)\b/, { run_js: 4 }],
];

const URLISH = /\bhttps?:\/\/\S+/gi;
const FILEISH = /(?:^|\s)[~./\w@-]*\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|html|css|toml|ya?ml|py|sh|txt|csv|pdf|png|jpg|svg|lock|wasm|gguf|ipynb)\b|(?:^|\s)[~.]?\/?[\w@-]+(?:\/[\w.@-]+)+/gi;

const intentBoost = (q, name) => {
  let s = 0;
  for (const [re, boosts] of INTENTS) {
    if (!re.test(q)) continue;
    for (const [pat, w] of Object.entries(boosts)) {
      if (pat.endsWith('*') ? name.startsWith(pat.slice(0, -1)) : name === pat) s += w;
    }
  }
  return s;
};

// Ranks tools for a query. Score = BM25 over the tool's text (name words
// repeated so they weigh more) + 3 per query word that is a word of the name
// + intent phrases above. Returns [{ name, description, args, score, spec }]
// for tools scoring at least BARS.tool, best first.
export function rankTools(query, tools, { k = 3 } = {}) {
  const specs = (tools || []).filter(t => fnOf(t).name && !HARNESS_TOOLS.has(fnOf(t).name));
  const q = String(query || '').toLowerCase();
  // File names and URLs would only add noise words ("js", "md", "https") to the tokens; the intents still see them.
  const qw = words(query.replace(URLISH, ' ').replace(FILEISH, ' '));
  if (!specs.length || (!qw.length && !INTENTS.some(([re]) => re.test(q)))) return [];
  const docs = specs.map((t) => {
    const f = fnOf(t);
    const nameWords = f.name.replace(/_/g, ' ');
    const props = (f.parameters && f.parameters.properties) || {};
    const paramText = Object.entries(props).map(([n, p]) => `${n.replace(/_/g, ' ')} ${(p && p.description) || ''}`).join(' ');
    return { id: f.name, text: `${nameWords} ${nameWords} ${f.description || ''} ${paramText}` };
  });
  const rel = bm25(docs)(qw.join(' '));
  // A word that is in many tool names ("file", "git") says less than one that is in few ("push").
  const nameDf = new Map();
  for (const t of specs) for (const w of new Set(tokenize(fnOf(t).name.replace(/_/g, ' ')))) nameDf.set(w, (nameDf.get(w) || 0) + 1);
  const out = [];
  for (const t of specs) {
    const f = fnOf(t);
    const nameTokens = new Set(tokenize(f.name.replace(/_/g, ' ')));
    let score = Math.min(rel.get(f.name) || 0, 4);       // a long description can't carry a tool alone
    score += qw.filter(w => nameTokens.has(w)).reduce((n, w) => n + 3 / Math.sqrt(nameDf.get(w)), 0);
    if (new RegExp(`\\b${f.name.replace(/_/g, '[_ ]')}\\b`).test(q)) score += 3;
    score += intentBoost(q, f.name);
    if (score >= BARS.tool) {
      out.push({ name: f.name, description: firstSentence(f.description), args: paramList(f), score: Math.round(score * 100) / 100, spec: t });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, k);
}

// ── Plain text matching (chats, task items) ──────────────────────────────

// How many of the query's distinct words appear in `text`.
function lexHits(qw, text) {
  const have = new Set(tokenize(split(text)));
  return qw.filter(w => have.has(w)).length;
}
const needed = (qw) => qw.length <= 2 ? Math.min(1, qw.length) : 2;

// The ~170 characters of `text` that hold the most query words.
export function snippet(text, qw, max = 170) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const low = t.toLowerCase();
  const positions = [];
  for (const w of qw) {
    const stem = w.length > 4 ? w.slice(0, -1) : w;
    let at = low.indexOf(stem);
    while (at >= 0 && positions.length < 200) { positions.push(at); at = low.indexOf(stem, at + stem.length); }
  }
  if (!positions.length) return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  let best = positions[0], bestN = -1;
  for (const p of positions) {
    const start = Math.max(0, p - 40);
    const win = low.slice(start, start + max);
    const n = qw.filter(w => win.includes(w.length > 4 ? w.slice(0, -1) : w)).length;
    if (n > bestN) { bestN = n; best = p; }
  }
  let start = Math.max(0, best - 40);
  if (start > 0) start = (low.indexOf(' ', start) + 1) || start;
  let end = Math.min(t.length, start + max);
  const cut = end < t.length ? t.lastIndexOf(' ', end) : end;
  if (cut > start + 40) end = cut;
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}

const dateOf = (ts) => {
  const d = new Date(Number(ts));
  return Number.isFinite(d.getTime()) && ts ? d.toISOString().slice(0, 10) : '';
};

const factLine = (f) => `${f.s} ${f.p} ${f.o}${f.note ? ` (${f.note})` : ''}`;

// ── find ─────────────────────────────────────────────────────────────────

export async function find(query, sources = {}, { k = 3 } = {}) {
  const out = { tools: [], recipes: [], facts: [], chats: [], task: [] };
  query = String(query || '').trim();
  if (!query) return out;
  const qw = words(query);
  const src = sources || {};
  const attempt = async (fn) => { try { return await fn(); } catch { return null; } };

  if (src.tools) out.tools = rankTools(query, src.tools, { k });

  if (src.recipes && typeof src.recipes.match === 'function') {
    const r = await attempt(() => src.recipes.match(query, k));
    out.recipes = (r || []).filter(x => x && x.recipe && (x.score == null || x.score >= BARS.recipe)).slice(0, k);
  }

  if (typeof src.recall === 'function') {
    const r = await attempt(() => src.recall(query, k + 3));
    const seen = new Set();
    out.facts = (r || []).filter(x => x && x.fact && (x.score == null || x.score >= BARS.fact))
      .map(x => ({ fact: x.fact, text: factLine(x.fact), score: x.score ?? 1 }))
      .filter(x => !seen.has(x.text.toLowerCase()) && seen.add(x.text.toLowerCase()))
      .slice(0, k);
  }

  if (typeof src.searchHistory === 'function' && qw.length) {
    const r = await attempt(() => src.searchHistory(query, k * 4));
    const need = needed(qw);
    const best = new Map();
    for (const x of r || []) {
      if (!x || !x.text) continue;
      const hits = Math.max(lexHits(qw, `${x.title || ''} ${x.text}`), 0);
      if (hits < need) continue;
      const rank = hits + 0.01 * Math.min(Number(x.score) || 0, 50);
      const key = x.session || x.title || x.text;
      if (!best.has(key) || best.get(key).rank < rank) best.set(key, { ...x, rank, hits });
    }
    out.chats = [...best.values()].sort((a, b) => b.rank - a.rank).slice(0, k)
      .map(x => ({ session: x.session, title: x.title || '', text: snippet(x.text, qw), ts: x.ts, score: x.score, hits: x.hits }));
  }

  if (Array.isArray(src.taskItems) && qw.length) {
    const need = needed(qw);
    out.task = src.taskItems.filter(x => x && x.text)
      .map(x => ({ ...x, hits: lexHits(qw, x.text) }))
      .filter(x => x.hits >= need)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, k)
      .map(x => ({ id: x.id, source: x.source, text: snippet(x.text, qw, 240), score: x.hits / qw.length }));
  }
  return out;
}

// ── renderFind ───────────────────────────────────────────────────────────

const argList = (args) => args.map(a => a.required ? a.name : a.name + '?').join(', ');
const oneLine = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
};
const sourceLabel = (s) => !s || /step|result/i.test(s) ? 'earlier step' : /tool|output|obs/i.test(s) ? 'earlier tool output' : String(s);

export const NOTHING = 'Nothing found. Try different words, look it up with a tool, or ask the user.';

export function renderFind(result) {
  const r = result || {};
  const parts = [];
  if (r.tools && r.tools.length) {
    parts.push('Tools:\n' + r.tools.map(t => `- ${t.name}(${argList(t.args || [])}): ${t.description}`).join('\n'));
  }
  if (r.recipes && r.recipes.length) {
    parts.push('Recipes from similar tasks:\n' + r.recipes.map(({ recipe: c }) => {
      const lines = [`* ${c.title}`, ...(c.steps || []).slice(0, 8).map((s, i) => `  ${i + 1}. ${oneLine(s, 160)}`)];
      if (c.specifics && c.specifics.length) lines.push('  Specifics: ' + c.specifics.slice(0, 8).map(s => oneLine(s, 120)).join('; '));
      return lines.join('\n');
    }).join('\n'));
  }
  if (r.facts && r.facts.length) {
    parts.push('Memory:\n' + r.facts.map(f => `- ${oneLine(f.text || factLine(f.fact), 200)}`).join('\n'));
  }
  if (r.chats && r.chats.length) {
    parts.push('Past chats:\n' + r.chats.map(c => {
      const when = dateOf(c.ts);
      const head = [when, oneLine(c.title, 50)].filter(Boolean).join(', ');
      return `- (${head || 'earlier chat'}) ${oneLine(c.text, 200)}`;
    }).join('\n'));
  }
  if (r.task && r.task.length) {
    parts.push('This task:\n' + r.task.map(t => `- (${sourceLabel(t.source)}) ${oneLine(t.text, 240)}`).join('\n'));
  }
  return parts.length ? parts.join('\n\n') : NOTHING;
}
