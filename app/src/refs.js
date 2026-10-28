// Reference resolution (docs/harness.md, "Smart context v2"): before the model
// sees a message, work out what "that", "it", "the repo", "the file from
// yesterday" or a bare link point at, from an entity table built from recent
// turns, tool arguments and memory. The result is a hint for the prompt
// ("'that' probably means …"), never a rewrite of the user's words.
//
// Rules this module keeps:
//   - Never invent. If nothing fits, the phrase gets no entry.
//   - No hard-coded meanings. Numbers and bare words are never typed ("kill
//     8080" is not a port); only shapes with a clear form (URLs, paths, owner/name,
//     branch commands, people/projects named in memory or introduced as such)
//     become entities.
//   - Outside text never makes entities: tool-role messages and <untrusted>
//     blocks are skipped, and failed tool calls don't count.
//
// Pure functions; no storage, no clock unless passed (tests/refs.test.js).

const EXT = 'js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|html|css|toml|yml|yaml|py|sh|txt|csv|pdf|png|jpg|jpeg|svg|lock|wasm|gguf|ipynb|rs|go|sql|log|xml|ini|cfg|conf';
const FILE_END = new RegExp(`\\.(?:${EXT})$`, 'i');
// "Node.js" and friends look like file names but are products.
const NOT_FILES = new Set(['node.js', 'vue.js', 'react.js', 'next.js', 'nuxt.js', 'three.js', 'd3.js', 'express.js', 'chart.js', 'backbone.js', 'ember.js', 'socket.io', 'deno.js']);
// First path segments that mean "folder", not a GitHub owner.
const DIRS = new Set(('app src tests test docs doc worker workers scripts script lib libs vendor home repos node_modules assets public dist build bin etc usr var tmp ' +
  'agent feature fix bugfix hotfix release chore refactor e2e fixtures memory sessions settings attachments input output read write and or yes no true false client server he she w on off i tcp ui ux ' +
  'either both before after up down in out to from with without ios android os pc cd dvd ac dc ad am pm km kg kb mb gb tb').split(' '));
const REPO_CONTEXT = /\b(repos?|repositor(?:y|ies)|github|clone[ds]?|fork(?:ed)?|upstream)\W+(?:[\w-]+\W+){0,3}$/i;

// Capitalised words that are not somebody's project or name.
const COMMON_CAPS = new Set(('i i\'m i\'ll i\'ve i\'d monday tuesday wednesday thursday friday saturday sunday january february march april may june july august ' +
  'september october november december github git google cloudflare safari chrome firefox claude anthropic gemma wikipedia linux mac macos windows iphone ipad android ' +
  'apple microsoft python javascript typescript node npm docker wrangler readme ok okay yes no hey hi thanks please sorry also but and the this that then so well ' +
  'maybe actually basically honestly right alright yeah hmm um uh duckduckgo reddit youtube twitter slack discord notion figma stack overflow hugging face kaggle ' +
  'huggingface openai ollama llama gpt ai api url html css json sql ui ux ios pr ci cd md').split(' '));

// Words that can't be a project's name in "the X project" / "my X app".
const NOT_NAMES = new Set(('new old same other first last next previous whole entire main current actual real whole own another any some this that these those ' +
  'github git web mobile android ios test demo example sample python javascript node react big small little tiny cool good bad great other whole full ' +
  'one two three my your our their his her its a an the').split(' '));

const PERSON_REL = /\b(son|daughter|kid|child|wife|husband|partner|girlfriend|boyfriend|friend|brother|sister|mother|mom|dad|father|colleague|coworker|co-worker|boss|manager|teacher|cousin|uncle|aunt|grandma|grandpa|grandmother|grandfather|cat|dog|pet)\b/i;
const PERSONAL_REL = /\b(prefers?|likes?|loves?|hates?|born|birthday|lives?|works?|wants?|has an?|is married|married|says|thinks|owns|wakes?|speaks?)\b/i;
const PROJECT_REL = /\b(app|project|repo|repository|tool|site|worker|model|experiment|harness|library|framework|extension|bot|game|website|service|prototype|pipeline|dataset|zoo|block|stores?|deploys?|built|builds?|runs?|hosted|hosts|syncs?|written|ships?)\b/i;

const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('')
  : c == null ? '' : String(c);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trimPunct = (s) => s.replace(/[.,;:!?)\]}'"”’]+$/, '');

// What the model said about outside content, or pasted code blobs, don't make entities.
function cleanText(raw) {
  return textOf(raw)
    .replace(/<untrusted[^>]*>[\s\S]*?<\/untrusted[^>]*>/gi, ' ')
    .replace(/```[\s\S]{300,}?```/g, ' ');
}

// ── Entity table ─────────────────────────────────────────────────────────

const normKey = (type, v) => {
  v = String(v).trim();
  switch (type) {
    case 'file': case 'dir': return v.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
    case 'url': return v.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
    case 'repo': return v.replace(/\.git$/i, '').toLowerCase();
    case 'branch': return v;
    default: return v.toLowerCase();
  }
};

function makeTable() {
  const map = new Map();
  let order = 0;
  const idOf = (type, key) => type + '\0' + key;
  return {
    map,
    // at: where on the timeline (message index; tool calls sit half a step after their message)
    add(type, value, { at, ts, source, weak = false }) {
      value = String(value).trim();
      if (!value) return null;
      const touch = (x) => {
        x.mentions++;
        x.order = ++order;
        if (!weak) x.weak = false;
        if (at >= x.lastSeen) { x.lastSeen = at; x.source = source || x.source; }
        if (ts && (!x.ts || ts > x.ts)) x.ts = ts;
        return x;
      };
      const key = normKey(type, value);
      if (type === 'file' || type === 'repo') {
        // "tools.js" and "app/src/tools.js", "squiggle" and "KealJones/squiggle" are one entity; the fuller spelling wins.
        const target = [...map.values()].filter(e => e.type === type && e.key !== key && (
          (!key.includes('/') && e.key.endsWith('/' + key)) || (!e.key.includes('/') && key.endsWith('/' + e.key))))
          .sort((a, b) => b.order - a.order)[0];
        if (target) {
          if (!key.includes('/')) return touch(target);
          map.delete(idOf(type, target.key));
          const prior = map.get(idOf(type, key));
          if (prior) {
            prior.mentions += target.mentions;
            prior.lastSeen = Math.max(prior.lastSeen, target.lastSeen);
            prior.firstSeen = Math.min(prior.firstSeen, target.firstSeen);
            return touch(prior);
          }
          Object.assign(target, { value, key });
          map.set(idOf(type, key), target);
          return touch(target);
        }
      }
      let e = map.get(idOf(type, key));
      if (!e) {
        e = { type, value, key, lastSeen: at, firstSeen: at, ts: null, source, mentions: 0, order: 0, weak };
        map.set(idOf(type, key), e);
      }
      return touch(e);
    },
  };
}

const entityList = (table) => [...table.map.values()];

// ── Extracting entities from text ────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const BARE_DOMAIN_RE = /(?<![\w@/.:-])((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|gov|edu|me|so|xyz)\b(?:\/[^\s<>"'`)\]}]*)?)/gi;
const GH_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99}?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s?#]+)(?:\/([^\s?#]+))?|\/(?:pull|issues|commit|releases|actions|wiki)\b[^\s]*)?\/?(?:[?#]\S*)?$/i;

const blank = (t, start, len) => t.slice(0, start) + ' '.repeat(len) + t.slice(start + len);

// Returns mentions [{ type, value, pos, weak? }] found in one text, in order of position.
// `known` = { repos: Set(lowercase owner/name), names: Map(lowercase -> { type, value }) }
export function extractMentions(raw, known = { repos: new Set(), names: new Map() }) {
  let t = cleanText(raw);
  const out = [];
  const add = (type, value, pos, extra = {}) => out.push({ type, value, pos, ...extra });

  // Emails are not links or repos.
  t = t.replace(/\S+@\S+\.\w+/g, (m) => ' '.repeat(m.length));

  // URLs (also github.com/owner/name without a scheme)
  const urlSpans = [];
  for (const m of t.matchAll(URL_RE)) urlSpans.push({ start: m.index, text: trimPunct(m[0]) });
  for (const m of t.matchAll(BARE_DOMAIN_RE)) {
    const text = trimPunct(m[1]);
    if (NOT_FILES.has(text.toLowerCase()) || FILE_END.test(text.split('/')[0]) && !/\//.test(text)) continue;
    if (urlSpans.some(s => m.index >= s.start && m.index < s.start + s.text.length)) continue;
    urlSpans.push({ start: m.index, text });
  }
  for (const s of urlSpans) {
    add('url', s.text, s.start);
    const gh = s.text.match(GH_RE);
    if (gh) {
      add('repo', `${gh[1]}/${gh[2]}`, s.start);
      if (gh[3] && !/^[0-9a-f]{40}$/.test(gh[3])) add('branch', decodeURIComponent(gh[3]), s.start);
      if (gh[4] && FILE_END.test(gh[4])) add('file', decodeURIComponent(gh[4]), s.start);
    }
    t = blank(t, s.start, s.text.length);
  }

  // Paths and file names
  const pathRes = [
    [/(?<![\w/.@:-])(\/(?:home|repos|etc|usr|var|tmp|opt|mnt|Users)\/[\w.@~/-]*[\w@~/-])/g, 1],
    [new RegExp(`(?<![\\w/.@:-])((?:~|\\.{1,2})?/?(?:[\\w.@-]+/)+[\\w@-][\\w.@-]*\\.(?:${EXT}))(?![\\w@/-])`, 'gi'), 1],
    [/(?<![\w/.@:-])((?:~|\.{1,2})?\/?(?:[\w@-][\w.@-]*\/)+)(?![\w.@/-])/g, 1],
    [new RegExp(`(?<![\\w/.@:-])([\\w@-]+(?:\\.[\\w@-]+)*\\.(?:${EXT}))(?![\\w@/-])`, 'gi'), 1],
  ];
  for (const [re, g] of pathRes) {
    for (const m of t.matchAll(re)) {
      let v = trimPunct(m[g]);
      if (!v || NOT_FILES.has(v.toLowerCase())) continue;
      const isDirOnly = v.endsWith('/');
      if (/^\/(home|repos|usr|etc|var|tmp|opt|mnt|Users)?\/?$/.test(v)) continue;     // "/" and "/home" alone say nothing
      if (!isDirOnly && !FILE_END.test(v) && !/^\/(?:home|repos)\//.test(v) && !/\//.test(v)) continue;
      // "owner/name" style words with a slash but no extension are repos, handled below, not folders
      const type = FILE_END.test(v) ? 'file' : 'dir';
      add(type, v.replace(/\/$/, '') || v, m.index);
      t = blank(t, m.index, m[0].length);
    }
  }

  // owner/name repos: certain when known or after "repo", "github", "clone", …; otherwise only
  // when the owner looks like a GitHub login (has a capital or a digit) and is not a folder name.
  const repoSpans = [];
  for (const m of t.matchAll(/(?<![\w/.@:-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})(?![\w/@-])/g)) {
    const owner = m[1], name = m[2].replace(/\.$/, '');
    if (DIRS.has(owner.toLowerCase()) || FILE_END.test(name) || !/[A-Za-z]/.test(owner + name)) continue;
    const full = `${owner}/${name}`;
    const before = t.slice(Math.max(0, m.index - 60), m.index);
    const isKnown = known.repos.has(full.toLowerCase());
    if (isKnown || REPO_CONTEXT.test(before) || /[A-Z]/.test(owner) || /\d/.test(owner) && /[a-z]/.test(owner)) { add('repo', full, m.index); repoSpans.push([m.index, m[0].length]); }
  }
  for (const [start, len] of repoSpans) t = blank(t, start, len);

  // Branches: "branch foo", "git checkout -b foo", "push origin foo", "switch to foo"
  const BRANCH_WORDS = new Set(('is was and or to of the a an for on that this it in at as with has have had be been not no yes now then there here again already ' +
    'name named called from which will would should could can just still also but if so are were by my your our their his her its into off out up down over under').split(' '));
  const COMMON_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'staging', 'production', 'prod', 'trunk', 'gh-pages']);
  const branchRes = [
    /\bbranch(?:es)?\s+(?:called\s+|named\s+|name\s+)?[`"'“]?([A-Za-z0-9][\w./-]{1,80})/gi,   // checked below
    /\bgit\s+(?:checkout|switch)\s+(?:-[bcB]\s+)?([A-Za-z0-9][\w./-]{1,80})/gi,
    /\bgit\s+push\s+(?:-\w+\s+)*\w+\s+([A-Za-z0-9][\w./-]{1,80})/gi,
    /\b(?:merge|rebase)\s+([A-Za-z0-9][\w./-]{1,80})\s+(?:in)?to\b/gi,
    /\b(?:on|onto|into|off|from)\s+(?:the\s+)?([A-Za-z0-9][\w-]*\/[\w./-]{2,80})\s+branch\b/gi,
    /\b([A-Za-z0-9][\w./-]{1,80})\s+branch\b/gi,
  ];
  for (const re of branchRes) {
    for (const m of t.matchAll(re)) {
      const v = trimPunct(m[1]).replace(/[`"'”]+$/, '');
      if (!v || BRANCH_WORDS.has(v.toLowerCase()) || FILE_END.test(v) || /^\d+$/.test(v)) continue;
      // "branch tomorrow" is a sentence; "branch harness-memory", "branch main" and "branch called x" are names
      if (re === branchRes[0] && !/[-/_.\d]/.test(v) && !COMMON_BRANCHES.has(v.toLowerCase()) && !/\b(called|named|name)\s+\S+$/i.test(m[0])) continue;
      // "the other branch", "that branch", "my branch" are references, not names
      if (/^(other|new|old|same|last|current|first|next|main-ish|remote|local|feature|git|github)$/i.test(v) && re === branchRes[branchRes.length - 1]) continue;
      add('branch', v, m.index + m[0].indexOf(m[1]));
    }
  }

  // People introduced with a relation ("my son Dash") or addressed ("ask Sam")
  const REL = PERSON_REL.source.replace(/\\b/g, '');
  for (const m of t.matchAll(new RegExp(`\\b(?:my|his|her|our|their)\\s+(?:${REL})\\s*(?:is\\s+|named\\s+|called\\s+|,\\s*)?([A-Z][a-z]{1,20})\\b`, 'g'))) {
    const name = m[m.length - 1];
    if (!COMMON_CAPS.has(name.toLowerCase())) add('person', name, m.index + m[0].lastIndexOf(name));
  }
  for (const m of t.matchAll(/\b(?:with|ask|asked|tell|told|email|emailed|text|texted|call|called|message|messaged|ping|pinged|cc|remind|met|meet|meeting|thanks to|from)\s+([A-Z][a-z]{1,20})\b/g)) {
    const n = m[1];
    if (COMMON_CAPS.has(n.toLowerCase()) || known.names.has(n.toLowerCase()) && known.names.get(n.toLowerCase()).type !== 'person') continue;
    add('person', n, m.index + m[0].lastIndexOf(n));
  }

  // Named projects: "a project called X", "the X app", quoted Names, known names
  for (const m of t.matchAll(/\b(?:project|app|repo|repository|tool|site|experiment|library|model|bot|game|extension|harness|zoo)\s+(?:called|named)\s+["'“‘]?([A-Za-z][\w-]{1,30}(?:\s[A-Z][\w-]{1,20})?)/gi)) {
    if (!NOT_NAMES.has(m[1].toLowerCase())) add('project', m[1], m.index + m[0].indexOf(m[1]));
  }
  for (const m of t.matchAll(/\b(?:the|my|our|that|this)\s+([A-Za-z][\w-]{1,30})\s+(?:project|app|repo|repository|experiment|harness|extension|bot|library|worker|prototype)\b/gi)) {
    if (!NOT_NAMES.has(m[1].toLowerCase()) && !COMMON_CAPS.has(m[1].toLowerCase())) add('project', m[1], m.index + m[0].indexOf(m[1]), { weak: !/[A-Z]/.test(m[1]) && !known.names.has(m[1].toLowerCase()) });
  }
  for (const m of t.matchAll(/["“‘]([A-Z][\w-]*(?:\s[A-Z][\w-]*){0,2})["”’]/g)) {
    if (!COMMON_CAPS.has(m[1].toLowerCase())) add('project', m[1], m.index + 1, { weak: true });
  }
  for (const m of t.matchAll(/(?<=[a-z,;:)]\s)([A-Z][a-z]{2,}(?:[A-Z][a-z]+)+|[A-Z][a-z]{3,})\b/g)) {
    const n = m[1];
    if (COMMON_CAPS.has(n.toLowerCase()) || out.some(o => o.value === n)) continue;
    if (known.names.has(n.toLowerCase())) continue;           // handled below with its known type
    if (/^[A-Z][a-z]+[A-Z]/.test(n)) add('project', n, m.index, { weak: true });   // CamelCase reads as a name
  }
  for (const [lower, info] of known.names) {
    if (lower.length < 3 || COMMON_CAPS.has(lower) || NOT_NAMES.has(lower)) continue;
    const re = new RegExp(`(?<![\\w/.@-])${esc(lower).replace(/\\ /g, '\\s+')}(?![\\w@/-])`, 'gi');
    for (const m of t.matchAll(re)) add(info.type, info.value, m.index);
  }

  // Later mentions win; keep one mention per (type, value) at its last position.
  out.sort((a, b) => a.pos - b.pos);
  return out;
}

// ── buildEntities ────────────────────────────────────────────────────────

// Classify what a memory fact is about.
function factNames(f) {
  const s = String(f.s || '').trim(), p = String(f.p || ''), o = String(f.o || '').trim();
  const rel = `${p} ${f.note || ''}`;
  const names = [];
  const nameLike = (x) => x && x.split(/\s+/).length <= 3 && x.length <= 40 && /^[A-Za-z][\w'. -]*$/.test(x) && !/^(a|an|the|no|not)\b/i.test(x);
  if (nameLike(o) && PERSON_REL.test(rel)) names.push({ type: 'person', value: o });
  if (nameLike(s) && PERSONAL_REL.test(p) && /^[A-Z]/.test(s)) names.push({ type: 'person', value: s });
  if (nameLike(s) && !names.some(n => n.value === s) && PROJECT_REL.test(`${p} ${o}`) && s.split(/\s+/).length <= 2) names.push({ type: 'project', value: s });
  return names;
}

const pathLike = (v) => typeof v === 'string' && v.length < 300 && !/\n/.test(v);

// Entities a tool call's arguments name.
function callMentions(call) {
  const out = [];
  const args = call && call.args && typeof call.args === 'object' ? call.args : {};
  const owner = typeof args.owner === 'string' ? args.owner : '';
  for (const [k, raw] of Object.entries(args)) {
    if (!pathLike(raw)) continue;
    const v = raw.trim();
    if (!v) continue;
    const key = k.toLowerCase();
    if (/^https?:\/\/\S+$/i.test(v)) { out.push({ type: 'url', value: trimPunct(v) }); continue; }
    if (/^(repo|repository|full_name)$/.test(key) && /^[\w.-]+(\/[\w.-]+)?$/.test(v)) out.push({ type: 'repo', value: owner && !v.includes('/') ? `${owner}/${v}` : v });
    else if (/^(branch|ref|base|head)$/.test(key) && /^[\w][\w./-]*$/.test(v)) out.push({ type: 'branch', value: v });
    else if (/^(dir|directory|folder|cwd)$/.test(key) && v.length > 1) out.push({ type: 'dir', value: v });
    else if (/^(path|file|filepath|filename)$/.test(key) && v.length > 1) {
      if (v === '/' || /^\/(home|repos)\/?$/.test(v)) continue;
      out.push({ type: FILE_END.test(v) ? 'file' : 'dir', value: v });
    }
  }
  return out;
}

// messages: [{ role, content, ts? }] oldest first. facts: memory facts [{ s, p, o, note? }].
// toolCalls: [{ name, args, ok?, ts?, msgIndex? }] (a call with no position is placed after the last message).
// Messages may carry their own `tools: [{ name, args, ok }]`.
// Returns entities: { type: 'file'|'dir'|'repo'|'branch'|'url'|'project'|'person', value,
//   lastSeen (message index; tool calls sit at index + 0.5; memory is -1), firstSeen, ts, source
//   ('user'|'assistant'|'tool'|'memory'), mentions, order, weak? }.
export function buildEntities({ messages = [], facts = [], toolCalls = [] } = {}) {
  const table = makeTable();
  const known = { repos: new Set(), names: new Map() };

  // 1. What memory says we should recognise, and memory entities themselves.
  const events = [];
  for (const f of facts || []) {
    if (!f || f.deleted) continue;
    for (const n of factNames(f)) known.names.set(n.value.toLowerCase(), n);
    const text = `${f.s || ''} ${f.p || ''} ${f.o || ''} ${f.note || ''}`;
    for (const m of extractMentions(text, known)) if (m.type === 'repo') known.repos.add(m.value.toLowerCase());
    events.push({ at: -1, seq: events.length, kind: 'fact', f, text });
  }
  const all = messages || [];
  const calls = [];
  all.forEach((m, i) => { if (m && Array.isArray(m.tools)) for (const c of m.tools) if (c && c.args) calls.push({ ...c, msgIndex: i }); });
  for (const c of toolCalls || []) calls.push(c);
  for (const c of calls) {
    if (!c || c.ok === false) continue;
    for (const m of callMentions(c)) if (m.type === 'repo' && m.value.includes('/')) known.repos.add(m.value.toLowerCase());
  }

  // 2. A single timeline, oldest first.
  const tsIndex = all.map((m, i) => ({ i, ts: m && m.ts })).filter(x => x.ts);
  const placeCall = (c) => {
    if (Number.isFinite(c.msgIndex)) return c.msgIndex + 0.5;
    if (c.ts && tsIndex.length) {
      let at = -1;
      for (const x of tsIndex) if (x.ts <= c.ts) at = x.i;
      return at + 0.5;
    }
    return all.length - 0.5;
  };
  all.forEach((m, i) => {
    if (!m || !(m.role === 'user' || m.role === 'assistant' || m.role === 'model')) return;
    events.push({ at: i, seq: events.length, kind: 'msg', m, text: m.content, source: m.role === 'user' ? 'user' : 'assistant' });
  });
  for (const c of calls) {
    if (!c || c.ok === false) continue;
    events.push({ at: placeCall(c), seq: events.length, kind: 'call', c });
  }
  events.sort((a, b) => a.at - b.at || a.seq - b.seq);

  for (const ev of events) {
    if (ev.kind === 'fact') {
      for (const n of factNames(ev.f)) table.add(n.type, n.value, { at: -1, source: 'memory' });
      for (const m of extractMentions(ev.text, known)) table.add(m.type, m.value, { at: -1, source: 'memory', weak: m.weak });
    } else if (ev.kind === 'msg') {
      for (const m of extractMentions(ev.text, known)) {
        table.add(m.type, m.value, { at: ev.at, ts: ev.m.ts, source: ev.source, weak: m.weak });
        if (m.type === 'repo') table.add('project', m.value.split('/').pop(), { at: ev.at, ts: ev.m.ts, source: ev.source, weak: true });
      }
    } else {
      const ts = ev.c.ts || (all[Math.floor(ev.at)] && all[Math.floor(ev.at)].ts) || null;
      for (const m of callMentions(ev.c)) {
        table.add(m.type, m.value, { at: ev.at, ts, source: 'tool' });
        if (m.type === 'repo') table.add('project', m.value.split('/').pop(), { at: ev.at, ts, source: 'tool', weak: true });
      }
    }
  }
  const list = entityList(table).sort((a, b) => a.order - b.order);
  // resolve() measures "recent" from the end of the conversation, which the entities alone don't show.
  Object.defineProperty(list, 'messageCount', { value: all.length });
  return list;
}

// ── resolve ──────────────────────────────────────────────────────────────

const NOUNS = {
  file: 'file|script|document|doc|pdf|config|readme|notebook|spreadsheet|log',
  dir: 'folder|directory|dir',
  repo: 'repo|repository|codebase',
  branch: 'branch',
  url: 'link|url|page|site|website|webpage|article|tab|post|video|thread',
  project: 'project|app|extension|experiment|harness|library',
  person: 'person|guy|dude|girl|lady|woman|man',
};
const NOUN_TYPE = {};
for (const [type, alt] of Object.entries(NOUNS)) for (const w of alt.split('|')) NOUN_TYPE[w] = type;
const NOUN_ALT = Object.values(NOUNS).join('|');

const TEMPORAL = '(?:yesterday|last night|last week|last month|the other day|the other week|earlier today|this morning|earlier|last time|a while ago|a few days ago|previously|recently)';
const ANY_THING = ['file', 'dir', 'repo', 'branch', 'url', 'project'];

const VERB_TYPES = [
  [/^(clone|fork|star)$/, ['repo']],
  [/^(checkout|rebase|merge|switch)$/, ['branch']],
  [/^(push|pull|commit|publish)$/, ['branch', 'repo', 'project']],
  [/^(visit|browse|click|bookmark|watch|fetch|scrape|load)$/, ['url']],
  [/^(ask|tell|email|text|call|ping|message|remind|thank)$/, ['person']],
  [/^(open|read|cat|view|show|display|print|diff|grep|lint|format|rename|move|copy|delete|remove|rewrite|edit|write|attach|upload|download|summari[sz]e|translate|parse|send|share|explain|review|look|find|search)$/, ['file', 'url', 'dir']],
  [/^(fix|change|update|check|test|run|use|try|deploy|build|install|kill|stop|restart|start|launch|close|cancel|undo|revert|redo|rerun|refactor|continue|finish|keep|save|work|go)$/, ANY_THING],
];
const VERBS = VERB_TYPES.map(([re]) => re.source.replace(/^\^\(|\)\$$/g, '')).join('|');
const FOLLOW = 'to|and|in|on|for|with|into|please|again|now|then|too|as|back|up|out|from|real|quick|so|but|before|after|when|if|by|at|over|off|once|later|today|tomorrow|first|together|or|until|because|since';
const PRON = new RegExp(
  `\\b(${VERBS})\\s+(?:(?:out|up|over|into|in|on|at|for|to|from|with|through)\\s+)?(it|that|this|them)\\b(?=\\s*(?:[,.!?;:)]|$|\\s(?:${FOLLOW})\\b))`, 'gi');
const PREP_PRON = new RegExp(
  `\\b(?:in|inside|from|at|into)\\s+(it|that|this)\\b(?=\\s*(?:[,.!?;:)]|$|\\s(?:${FOLLOW})\\b))`, 'gi');

function typesForVerb(verb) {
  const v = String(verb || '').toLowerCase();
  for (const [re, types] of VERB_TYPES) if (re.test(v)) return types;
  return ANY_THING;
}

const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const DAY = 24 * 3600 * 1000;

// Which timestamps a temporal word allows: returns a predicate (entity, ctx) => bool, or null when it can't be judged without a time.
function temporalFilter(word, now) {
  const w = word.toLowerCase();
  const today = dayStart(now);
  const within = (from, to) => (e) => e.ts != null && e.ts >= from && e.ts < to;
  if (w === 'yesterday' || w === 'last night') return within(today - DAY, today);
  if (w === 'this morning' || w === 'earlier today') return within(today, now + 1);
  if (w === 'the other day') return within(today - 4 * DAY, today);
  if (w === 'a few days ago') return within(today - 8 * DAY, today - DAY);
  if (w === 'last week' || w === 'the other week') return within(today - 15 * DAY, today - 3 * DAY);
  if (w === 'last month') return within(today - 70 * DAY, today - 18 * DAY);
  return (e, ctx) => e.lastSeen < ctx.maxSeen - 1 || (e.ts != null && e.ts < now - 6 * 3600 * 1000);   // earlier, before, last time, …
}

const here = Number.MAX_SAFE_INTEGER;
// "tools.js" and "app/src/tools.js" (lower-cased keys) are the same file.
const sameFile = (a, b) => a === b || (!b.includes('/') && a.endsWith('/' + b)) || (!a.includes('/') && b.endsWith('/' + a));

// text: the user's new message. entities: buildEntities() output (may or may not include this message).
// Returns [{ phrase, entity, kind }] with kind 'link' | 'pronoun' | 'definite' | 'earlier'.
export function resolve(text, entities, { now = Date.now(), window = 12, definiteWindow = 40, limit = 6, messageCount } = {}) {
  const src = cleanText(text);
  if (!src.trim()) return [];
  const known = { repos: new Set(), names: new Map() };
  for (const e of entities || []) {
    if (e.type === 'repo') known.repos.add(String(e.value).toLowerCase());
    if (e.type === 'person' || e.type === 'project') known.names.set(String(e.value).toLowerCase(), { type: e.type, value: e.value });
  }

  // This message's own mentions count as the freshest entities ("open tools.js and fix it"),
  // but only for words after them: a phrase looks back, not ahead.
  const own = extractMentions(src, known);
  const pool = (entities || []).map(e => ({ ...e, heres: [] }));
  for (const m of own) {
    const key = normKey(m.type, m.value);
    const hit = pool.find(e => e.type === m.type && (e.key || normKey(e.type, e.value)) === key)
      || (m.type === 'file' ? pool.filter(e => e.type === 'file' && sameFile(e.key || normKey('file', e.value), key)).sort((a, b) => b.order - a.order)[0] : null);
    if (hit) { hit.heres.push(m.pos); continue; }
    pool.push({ type: m.type, value: m.value, key, lastSeen: null, ts: null, source: 'this message', mentions: 1, order: 0, weak: m.weak, heres: [m.pos] });
  }

  const seenIn = pool.filter(e => e.lastSeen >= 0).map(e => e.lastSeen);
  const count = messageCount ?? (entities && entities.messageCount);
  const maxSeen = Number.isFinite(count) ? count - 1 : seenIn.length ? Math.max(...seenIn) : -1;
  const ctx = { maxSeen };

  // How `e` looks from character `before` of this message: mentioned earlier in it, or as it was in the table.
  const view = (e, before) => {
    const p = e.heres.filter(x => x < before).pop();
    if (p !== undefined) return { ...e, lastSeen: here, order: p, inMessage: true };
    return e.lastSeen == null ? null : e;
  };

  const best = (types, { span, fromMemory = false, filter, before = Infinity } = {}) => {
    let c = pool.map(e => types.includes(e.type) ? view(e, before) : null).filter(Boolean);
    c = c.filter(e => e.lastSeen === here || (e.lastSeen >= 0 ? e.lastSeen >= maxSeen - span : fromMemory));
    if (filter) c = c.filter(e => filter(e, ctx));
    if (!c.length) return null;
    const rank = (e) => (e.lastSeen === here ? 1e9 + e.order : e.lastSeen) - (e.weak ? 3 : 0);
    return c.sort((a, b) => rank(b) - rank(a) || types.indexOf(a.type) - types.indexOf(b.type) || b.order - a.order)[0];
  };
  const asEntity = (e) => ({ type: e.type, value: e.value, lastSeen: e.inMessage ? null : e.lastSeen, ts: e.ts || null, source: e.inMessage && !e.mentions ? 'this message' : e.source });

  const results = [];
  const taken = [];   // character spans already explained
  const overlaps = (s, n) => taken.some(([a, b]) => s < b && s + n > a);
  const push = (phrase, entity, kind, s, n) => {
    if (!entity) return;
    if (kind === 'pronoun' && results.some(r => r.kind === 'link' && r.entity.value === entity.value)) return;
    if (results.some(r => r.phrase.toLowerCase() === phrase.toLowerCase() && r.entity.value === entity.value && r.entity.type === entity.type)) return;
    results.push({ phrase, entity: asEntity(entity), kind });
    taken.push([s, s + n]);
  };

  // 1. Bare links: the entity is the URL itself.
  for (const m of extractMentions(src, known)) {
    if (m.type !== 'url') continue;
    const at = src.indexOf(m.value);
    if (!results.some(r => r.kind === 'link' && r.phrase === m.value)) {
      results.push({ phrase: m.value, entity: { type: 'url', value: m.value, lastSeen: null, ts: null, source: 'this message' }, kind: 'link' });
      if (at >= 0) taken.push([at, at + m.value.length]);
    }
  }

  // 2. "the file from yesterday", "that thing we did last time"
  const temporal = new RegExp(`\\b${TEMPORAL}\\b`, 'gi');
  for (const tm of src.matchAll(temporal)) {
    const before = src.slice(Math.max(0, tm.index - 70), tm.index);
    let head = null;
    for (const m of before.matchAll(new RegExp(`\\b(?:the|that|this)\\s+(?:(${NOUN_ALT})|thing|stuff|one)\\b`, 'gi'))) head = m;
    if (!head) continue;
    const gap = before.slice(head.index + head[0].length);
    if (/[.!?;\n]/.test(gap) || gap.trim().split(/\s+/).filter(Boolean).length > 6) continue;
    const start = tm.index - before.length + head.index;
    const phrase = src.slice(start, tm.index + tm[0].length);
    if (overlaps(start, phrase.length)) continue;
    const type = head[1] ? NOUN_TYPE[head[1].toLowerCase()] : null;
    const filter = temporalFilter(tm[0], now);
    if (!filter) continue;
    const e = best(type ? [type] : ANY_THING, { span: Infinity, fromMemory: true, filter, before: start });
    push(phrase, e, 'earlier', start, phrase.length);
  }

  // 3. "the file", "that repo", "this link"
  const definite = new RegExp(`\\b(the|that|this)\\s+(same\\s+|last\\s+|previous\\s+|old\\s+)?(${NOUN_ALT})\\b(?!\\s+(?:from|of)\\b[^.?!]{0,40}${TEMPORAL})`, 'gi');
  for (const m of src.matchAll(definite)) {
    if (overlaps(m.index, m[0].length)) continue;
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 60);
    // "the file app/src/main.js" / "the repo called X" already names its target
    if (/^\s*(?:called|named|at)\b/i.test(after) || /^\s*[`"'“‘]?[\w@~./:-]*[./][\w@~./:?=&#%-]+/.test(after) && /[./]/.test(after.trim().split(/\s/)[0])) continue;
    const type = NOUN_TYPE[m[3].toLowerCase()];
    let e = best([type], { span: definiteWindow, fromMemory: true, before: m.index });
    if (!e && type === 'project') e = best(['repo'], { span: definiteWindow, fromMemory: true, before: m.index });
    push(m[0], e, 'definite', m.index, m[0].length);
  }

  // 4. "open it", "what's in that": only entities from the conversation count
  const handled = new Set();
  for (const re of [PRON, PREP_PRON]) {
    for (const m of src.matchAll(re)) {
      const pron = m[m.length - 1];
      const verb = re === PRON ? m[1] : '';
      const at = m.index + m[0].lastIndexOf(pron);
      if (overlaps(at, pron.length) || handled.has(at)) continue;
      handled.add(at);
      const types = re === PRON ? typesForVerb(verb) : ANY_THING;
      // "check this out https://…", "look at this: app/src/main.js": the thing comes right after, so it is not in the past
      if (own.some(o => types.includes(o.type) && o.pos > at && o.pos - at <= 40 && !/[.!?,;]\s/.test(src.slice(at, o.pos)))) continue;
      const e = best(types, { span: window, before: at });
      push(pron.toLowerCase(), e, 'pronoun', at, pron.length);
    }
  }
  return results.slice(0, limit);
}

// ── renderRefs ───────────────────────────────────────────────────────────

const LABEL = { file: 'file', dir: 'folder', repo: 'repo', branch: 'branch', url: 'link', project: 'project', person: 'person' };
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// Short hint lines for the prompt's "Resolved references" section (no heading). '' when nothing resolved.
export function renderRefs(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.slice(0, 6).map(({ phrase, entity, kind }) => {
    if (kind === 'link') return `- the message has a link: ${clip(entity.value, 160)}`;
    const what = `the ${LABEL[entity.type] || entity.type} ${clip(entity.value, 120)}`;
    const when = kind === 'earlier' && entity.ts ? ` (from ${new Date(entity.ts).toISOString().slice(0, 10)})` : '';
    return `- '${phrase.replace(/\s+/g, ' ')}' probably means ${what}${when}`;
  }).join('\n');
}
