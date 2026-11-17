// The tools every agent harness LFM3 was trained in gives a model, under their usual names and schemas (Keal,
// 2026-11-17): Pi's read / write / edit (OpenClaw uses Pi's), OpenClaw's web_fetch (web_search already has the
// common name and schema, web.js), memory_read / memory_write, and Hermes's session_search. They sit next to bash on the bash surface
// (agent.js BASH_SURFACE); bash keeps its own commands for all of it too. Each one runs the Squiggle tool that
// already does the job, so approvals, path rules and untrusted wrapping are unchanged; the fine-tunes keep the
// old names (read_file, write_file, edit_file, fetch_url, remember, recall) they were trained on.
//
// Descriptions are Pi's and OpenClaw's own words, minus their output caps: no Squiggle tool cuts its output
// (Keal, 2026-11-15), so "use offset/limit" stays as advice rather than a limit.
import { defineTool, params, str, num, oneOf } from './registry.js';
import { readFile, writeFile, editFile } from './files.js';
import { fetchUrl } from './web.js';
import { remember, recall, searchHistory } from './memory.js';
import * as memory from '../memory.js';

// What each common tool runs (and is enabled by: a device that switched read_file off has read off too).
export const COMMON_FROM = { read: 'read_file', write: 'write_file', edit: 'edit_file', web_fetch: 'fetch_url', memory_read: 'recall', memory_write: 'remember', session_search: 'search_history' };

// The wrapped tools' messages name the old tools and arguments; the model on this surface knows the new ones.
const RENAMES = [[/\bread_file\b/g, 'read'], [/\bwrite_file\b/g, 'write'], [/\bedit_file\b/g, 'edit'], [/\bfetch_url\b/g, 'web_fetch'],
  [/, or set replace_all: true\./g, '.'], [/\bold_text\b/g, 'oldText'], [/\bnew_text\b/g, 'newText'], [/\bstart_line\b/g, 'offset'], [/\bend_line\b/g, 'limit']];
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
  description: 'Read the contents of a file. Use offset/limit for large files: read the part you need, then continue with offset.',
  parameters: params({
    path: str('Path to the file to read (relative or absolute)'),
    offset: num('Line number to start reading from (1-indexed)'),
    limit: num('Maximum number of lines to read'),
  }, ['path']),
  async run({ path, offset, limit }, ctx = {}) {
    const start = Math.max(1, Number(offset) || 1);
    const end = Number(limit) > 0 ? start + Number(limit) - 1 : undefined;
    return relabel(await readFile.run({ path, start_line: start, end_line: end }, ctx));
  },
});

export const write = defineTool({
  name: 'write',
  group: 'files',
  description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.',
  parameters: params({
    path: str('Path to the file to write (relative or absolute)'),
    content: str('Content to write to the file'),
  }, ['path', 'content']),
  async run({ path, content }, ctx = {}) {
    return relabel(await writeFile.run({ path, content, overwrite: true }, ctx));
  },
});

export const edit = defineTool({
  name: 'edit',
  group: 'files',
  description: 'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
  parameters: params({
    path: str('Path to the file to edit (relative or absolute)'),
    edits: {
      type: 'array',
      description: 'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
      items: {
        type: 'object',
        properties: {
          oldText: str('Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.'),
          newText: str('Replacement text for this targeted edit.'),
        },
        required: ['oldText', 'newText'],
      },
    },
  }, ['path', 'edits']),
  async run({ path, edits, oldText, newText }, ctx = {}) {
    // The older single-edit shape (Pi before edits[]) is accepted too.
    const list = Array.isArray(edits) ? edits : oldText != null ? [{ oldText, newText }] : [];
    if (!list.length) return { model: { error: 'Give edits: [{ oldText, newText }], with oldText copied exactly from the file.' } };
    let last = null;
    for (const [i, e] of list.entries()) {
      const r = relabel(await editFile.run({ path, old_text: e && e.oldText, new_text: (e && e.newText) || '' }, ctx));
      if (r.model && r.model.error) {
        return { ...r, model: { error: list.length > 1 ? `edits[${i}]: ${r.model.error}${i ? ` (edits before it were applied)` : ''}` : r.model.error } };
      }
      last = r;
    }
    return list.length > 1 ? { ...last, model: { ...last.model, edits: list.length }, label: `${last.label} (${list.length} edits)` } : last;
  },
});

export const webFetch = defineTool({
  name: 'web_fetch',
  group: 'web',
  description: 'Fetch and extract readable content from a URL (HTML → markdown/text).',
  parameters: params({
    url: str('HTTP or HTTPS URL to fetch'),
    extractMode: oneOf(['markdown', 'text'], 'Extraction mode ("markdown" or "text")'),
    maxChars: num('Maximum characters to return'),
  }, ['url']),
  async run({ url, maxChars }, ctx = {}) {
    const r = relabel(await fetchUrl.run({ url }, ctx));
    // The model asked for less: its own cut, not Squiggle's.
    const n = Number(maxChars);
    if (n > 0 && r.model) {
      const t = r.model.text;
      const m = typeof t === 'string' && t.match(/^(\s*<untrusted[^>]*>\n?)([\s\S]*?)(\n?<\/untrusted>\s*)$/);
      const [open, body, close] = m ? [m[1], m[2], m[3]] : ['', t, ''];
      if (typeof body === 'string' && body.length > n) r.model = { ...r.model, text: open + body.slice(0, n) + close, truncated: `first ${n} of ${body.length} characters` };
    }
    return r;
  },
});

export const memoryRead = defineTool({
  name: 'memory_read',
  group: 'memory',
  description: 'Read what you have saved about the user and their projects: the facts matching query, or the most recent ones without a query. Check it before answering anything about their preferences, decisions, people or work.',
  parameters: params({ query: str('What to look for, e.g. "git preferences"') }),
  async run({ query }, ctx = {}) {
    const q = String(query || '').trim();
    if (q) return relabel(await recall.run({ query: q }, ctx));
    const recent = memory.all().slice(-12).reverse();
    return { model: { facts: recent.map(f => ({ id: f.id, fact: memory.factText(f) })) }, label: 'read memory (most recent)' };
  },
});

export const memoryWrite = defineTool({
  name: 'memory_write',
  group: 'memory',
  description: 'Save something to remember, in one sentence about the user ("The user likes short answers", not "I like…"): a fact about them or their projects (preferences, decisions, names, how things work). "everywhere" (the default) keeps it for every chat; "this chat" keeps it only here.',
  parameters: params({ fact: str('What to remember, e.g. "Keal prefers short answers"'), scope: oneOf(['everywhere', 'this chat'], 'everywhere (default) or this chat') }, ['fact']),
  async run(args, ctx = {}) {
    return remember.run(args, ctx);
  },
});

// Past chats: Hermes calls it session_search, OpenClaw sessions_search, Claude's apps conversation_search.
export const sessionSearch = defineTool({
  name: 'session_search',
  group: 'memory',
  description: 'Search the user\'s past conversations (every chat, and files attached to them) for something discussed before: decisions, plans, names, what was said. Use it when the user refers to an earlier chat, or one may hold the answer, before asking them to repeat themselves.',
  parameters: params({ query: str('Words to look for, e.g. "eiffel tower trip"') }, ['query']),
  async run({ query }, ctx = {}) {
    return searchHistory.run({ query }, ctx);
  },
});

export const COMMON = [read, write, edit, webFetch, memoryRead, memoryWrite, sessionSearch];
