// The tools the agent harnesses LFM3 was benched in give a model, under their usual names (2026-11-17): read,
// write, edit, web_fetch, Hermes's memory and session_search (web_search already has the common name and schema,
// web.js). They sit next to bash on the bash surface (agent.js BASH_SURFACE); bash keeps its own commands for all of
// it too. Each one runs the Squiggle tool that already does the job, so approvals, path rules and untrusted wrapping
// are unchanged; the fine-tunes keep the old names (read_file, write_file, edit_file, fetch_url, remember, recall,
// search_history) they were trained on.
//
// One convention: snake_case names and arguments (2026-11-17), as Hermes and Claude's tools write them
// (file_path, old_string, new_string, replace_all, old_text). The other harnesses' spellings of the same argument
// (path, filePath, oldString, oldText, maxChars…) are accepted too, since a model brings the habits of the one it
// knows; the schemas name only ours. No tool cuts its output (2026-11-15).
import { defineTool, params, str, num, bool, oneOf } from './registry.js';
import { readFile, writeFile, editFile } from './files.js';
import { fetchUrl } from './web.js';
import { remember, searchHistory } from './memory.js';
import * as memory from '../memory.js';
import * as sessions from '../sessions.js';

// What each common tool runs (and is enabled by: a device that switched read_file off has read off too).
export const COMMON_FROM = { read: 'read_file', write: 'write_file', edit: 'edit_file', web_fetch: 'fetch_url', memory: 'remember', session_search: 'search_history' };

// The first of these arguments the call has (other harnesses' spellings of the same thing).
const pick = (args, ...names) => { for (const n of names) if (args[n] !== undefined && args[n] !== null) return args[n]; return undefined; };
const PATH = ['file_path', 'path', 'filePath', 'file'];
const PATHS = { path: 'file_path', filePath: 'file_path', file: 'file_path' };
const EDITS = { ...PATHS, oldString: 'old_string', oldText: 'old_string', old_text: 'old_string', newString: 'new_string', newText: 'new_string', new_text: 'new_string', replaceAll: 'replace_all' };

// The wrapped tools' messages name the old tools and arguments; the model on this surface knows the new ones.
const RENAMES = [[/\bread_file\b/g, 'read'], [/\bwrite_file\b/g, 'write'], [/\bedit_file\b/g, 'edit'], [/\bfetch_url\b/g, 'web_fetch'],
  [/\bold_text\b/g, 'old_string'], [/\bnew_text\b/g, 'new_string'], [/\bstart_line\b/g, 'offset'], [/\bend_line\b/g, 'limit']];
const renamed = (v) => {
  if (typeof v === 'string') return RENAMES.reduce((s, [a, b]) => s.replace(a, b), v);
  if (Array.isArray(v)) return v.map(renamed);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renamed(x)]));
  return v;
};
const relabel = (r) => (r && r.model ? { ...r, model: renamed(r.model) } : r);

export const read = defineTool({
  name: 'read',
  group: 'files',
  description: 'Read a file. Lines are numbered from 1; for a large file read the part you need with offset and limit, then continue from where it stopped.',
  parameters: params({
    file_path: str('Path to the file, e.g. /home/notes/todo.md'),
    offset: num('Line to start reading from (1 = the first line)'),
    limit: num('How many lines to read'),
  }, ['file_path']),
  aliases: { ...PATHS, lines: 'limit' },
  async run(args, ctx = {}) {
    const start = Math.max(1, Number(args.offset) || 1);
    const limit = Number(pick(args, 'limit', 'lines'));
    return relabel(await readFile.run({ path: pick(args, ...PATH), start_line: start, end_line: limit > 0 ? start + limit - 1 : undefined }, ctx));
  },
});

export const write = defineTool({
  name: 'write',
  group: 'files',
  description: 'Write a file: creates it, or replaces it if it exists, making any folders it needs. To change part of a file, use edit.',
  parameters: params({
    file_path: str('Path to the file, e.g. /home/notes/todo.md'),
    content: str('The whole content of the file'),
  }, ['file_path', 'content']),
  aliases: { ...PATHS, text: 'content' },
  async run(args, ctx = {}) {
    return relabel(await writeFile.run({ path: pick(args, ...PATH), content: pick(args, 'content', 'text'), overwrite: true }, ctx));
  },
});

export const edit = defineTool({
  name: 'edit',
  group: 'files',
  description: 'Replace text in a file. old_string must match the file exactly, spaces and line breaks included, and only once (add surrounding lines to make it unique), unless replace_all is true. Read the part you change first.',
  parameters: params({
    file_path: str('Path to the file, e.g. /home/notes/todo.md'),
    old_string: str('The exact text to replace'),
    new_string: str('What to put in its place'),
    replace_all: bool('Replace every match instead of exactly one'),
  }, ['file_path', 'old_string', 'new_string']),
  aliases: EDITS,
  // Pi's edits[{oldText, newText}] list: its first edit fills the two required arguments; run applies the whole list.
  prepare: (a) => (Array.isArray(a.edits) && a.edits[0] && a.old_string === undefined
    ? { ...a, old_string: pick(a.edits[0], 'old_string', 'oldString', 'oldText', 'old_text'), new_string: pick(a.edits[0], 'new_string', 'newString', 'newText', 'new_text') ?? '' } : a),
  async run(args, ctx = {}) {
    const path = pick(args, ...PATH);
    // Pi's edits[{oldText, newText}] list works too, applied in order.
    const list = Array.isArray(args.edits) ? args.edits.map(e => e || {})
      : [{ old_string: pick(args, 'old_string', 'oldString', 'oldText', 'old_text'), new_string: pick(args, 'new_string', 'newString', 'newText', 'new_text') }];
    let last = null;
    for (const [i, e] of list.entries()) {
      const from = pick(e, 'old_string', 'oldString', 'oldText', 'old_text');
      if (from === undefined) return { model: { error: 'Give old_string (the exact text to replace) and new_string.' } };
      const r = relabel(await editFile.run({ path, old_text: from, new_text: pick(e, 'new_string', 'newString', 'newText', 'new_text') || '', replace_all: Boolean(pick(args, 'replace_all', 'replaceAll')) }, ctx));
      if (r.model && r.model.error) return { ...r, model: { error: list.length > 1 ? `edits[${i}]: ${r.model.error}${i ? ' (the edits before it were applied)' : ''}` : r.model.error } };
      last = r;
    }
    return list.length > 1 ? { ...last, model: { ...last.model, edits: list.length }, label: `${last.label} (${list.length} edits)` } : last;
  },
});

export const webFetch = defineTool({
  name: 'web_fetch',
  group: 'web',
  description: 'Fetch a web page and give back its readable text (HTML turned into markdown or plain text).',
  parameters: params({
    url: str('The http or https URL'),
    extract_mode: oneOf(['markdown', 'text'], 'markdown (default) or text'),
    max_chars: num('Give back at most this many characters'),
  }, ['url']),
  aliases: { extractMode: 'extract_mode', maxChars: 'max_chars' },
  async run(args, ctx = {}) {
    const r = relabel(await fetchUrl.run({ url: args.url }, ctx));
    // The model asked for less: its own cut, not Squiggle's.
    const n = Number(pick(args, 'max_chars', 'maxChars'));
    if (n > 0 && r.model) {
      const t = r.model.text;
      const m = typeof t === 'string' && t.match(/^(\s*<untrusted[^>]*>\n?)([\s\S]*?)(\n?<\/untrusted>\s*)$/);
      const [open, body, close] = m ? [m[1], m[2], m[3]] : ['', t, ''];
      if (typeof body === 'string' && body.length > n) r.model = { ...r.model, text: open + body.slice(0, n) + close, truncated: `first ${n} of ${body.length} characters` };
    }
    return r;
  },
});

// Hermes's memory tool (2026-11-17): one tool, add / replace / remove, an entry found by a piece of its text.
// No read: what's relevant is already in the prompt. Its two targets map onto Squiggle's two kinds of memory
// (2026-11-18): `user` is memory/facts.jsonl, kept for every chat; `memory` is this chat's own notes (the session's
// notes, shown in the prompt under "Your notes for this chat"). "Forget that…" is a remove, so a model never has to
// save the opposite instead (LFM3 1.7B did, on the CPU, 2026-11-17).
const userEntries = () => memory.all().map(f => ({ id: f.id, text: memory.factText(f), drop: () => memory.remove(f.id) }));
const chatEntries = (session) => (session ? sessions.liveNotes(session) : []).map(n => ({ id: n.id, text: n.text, drop: () => sessions.deleteNote(session, n.id) }));
const listed = (entries) => entries.slice(-12).map(e => e.text);
export const memoryTool = defineTool({
  name: 'memory',
  group: 'memory',
  description: 'Save what you should remember. target "user" (default) is kept for every chat: the user\'s preferences, corrections, names, decisions, how their things work. target "memory" is kept only in this chat: your notes on the task (findings, where things are, next steps). Both are shown to you in later turns. add saves a new entry in one sentence (for "user", about the user: "The user likes short answers"). replace changes the entry containing old_text; remove deletes it, for when it is wrong, done with, or the user asks you to forget it. old_text only needs to be a short piece of the entry that matches just that one.',
  parameters: params({
    action: oneOf(['add', 'replace', 'remove'], 'add, replace or remove'),
    target: oneOf(['user', 'memory'], 'user: kept for every chat (default); memory: kept only in this chat'),
    content: str('The entry to save (add and replace)'),
    old_text: str('A short piece of the entry to change or remove (replace and remove)'),
  }, ['action']),
  aliases: { oldText: 'old_text', old_string: 'old_text', fact: 'content', text: 'content' },
  async run(args, ctx = {}) {
    const action = String(args.action || (args.old_text ? 'replace' : 'add')).toLowerCase();
    const chat = String(args.target || 'user').toLowerCase() === 'memory';
    const scope = chat ? 'this chat' : 'everywhere';
    const content = pick(args, 'content', 'fact', 'text');
    if (chat && !ctx.session) return { model: { error: 'There is no chat to keep notes in; use target "user".' } };
    if (action === 'add') return remember.run({ fact: content, scope }, ctx);
    if (action !== 'replace' && action !== 'remove') return { model: { error: `action is add, replace or remove, not "${action}".` } };
    const old = pick(args, 'old_text', 'oldText', 'old_string');
    if (!old) return { model: { error: `Give old_text: a short piece of the entry to ${action}.` } };
    const all = chat ? chatEntries(ctx.session) : userEntries();
    const q = String(old).trim().toLowerCase();
    const hits = all.filter(e => e.text.toLowerCase().includes(q));
    const other = chat ? 'user' : 'memory';
    if (!hits.length) return { model: { error: `No ${chat ? 'note in this chat' : 'saved entry'} contains "${old}" (target "${other}" holds the ${chat ? 'entries kept for every chat' : 'notes for this chat'}).`, entries: listed(all) } };
    if (hits.length > 1) return { model: { error: `"${old}" is in ${hits.length} entries; give a piece that matches only one.`, matches: listed(hits) } };
    const was = hits[0].text;
    if (action === 'replace' && !content) return { model: { error: 'Give content: the entry as it should read now.' } };
    hits[0].drop();
    if (action === 'remove') return { model: { ok: true, removed: was }, label: `forgot${chat ? ' (this chat)' : ''}: ${was.slice(0, 60)}` };
    const r = await remember.run({ fact: content, scope }, ctx);
    return r.model && r.model.ok ? { ...r, model: { ...r.model, replaced: was }, label: `changed a memory${chat ? ' (this chat)' : ''}: ${String(content).slice(0, 60)}` } : r;
  },
});

// Past chats: Hermes calls it session_search, OpenClaw sessions_search, Claude's apps conversation_search.
export const sessionSearch = defineTool({
  name: 'session_search',
  group: 'memory',
  description: 'Search the user\'s past conversations (every chat, and files attached to them) for something discussed before: decisions, plans, names, what was said. Use it when the user refers to an earlier chat, or one may hold the answer, before asking them to repeat themselves.',
  parameters: params({ query: str('Words to look for, e.g. "eiffel tower trip"') }, ['query']),
  aliases: { q: 'query' },
  async run(args, ctx = {}) {
    return searchHistory.run({ query: pick(args, 'query', 'q') }, ctx);
  },
});

export const COMMON = [read, write, edit, webFetch, memoryTool, sessionSearch];
