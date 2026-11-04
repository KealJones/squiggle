// Workspace file tools: list, read, grep, write, edit, delete.
import { resolveAgentPath, agentPath } from '../guard.js';
import * as storage from '../storage.js';
import { rmrf } from '../git.js';
import { wrapUntrusted } from '../untrusted.js';
import { truncate } from '../util.js';
import { defineTool, params, str, num, bool } from './registry.js';
import { MAX_READ, realPath, isAttachmentPath, isWebPath, readAgentFile, writeAgentFile, listAgentDir, numberedLines } from './workspace.js';

export const listFiles = defineTool({
  name: 'list_files',
  description: 'List files in the workspace. /home is your own synced space; /repos/<name> are git clones.',
  parameters: params({ path: str('Folder, e.g. /home or /repos/myrepo/src') }),
  async run({ path = '/' }) {
    const items = await listAgentDir(path);
    return { model: { path: agentPath(resolveAgentPath(path)), entries: items.slice(0, 400), more: Math.max(0, items.length - 400) }, label: `listed ${path}` };
  },
});

export const readFile = defineTool({
  name: 'read_file',
  description: 'Read lines of a text file from the workspace, with line numbers. Long files come in parts: use grep to find the lines you need, then read just that range.',
  parameters: params({ path: str('File path, e.g. /home/notes.md or /repos/app/README.md'), start_line: num('First line to read (default 1)'), end_line: num('Last line to read (default start_line + 150)') }, ['path']),
  async run({ path, start_line = 1, end_line }, ctx = {}) {
    const text = await readAgentFile(path);
    if (text == null) return { model: { error: `No such file: ${path}` }, label: `read ${path} (missing)` };
    const lines = text.split('\n');
    const start = Math.max(1, Math.floor(start_line) || 1);
    // Never more than the room left in the model's context (ctx.room, in chars).
    const { out, end } = numberedLines(lines, start, Math.min(lines.length, Math.floor(end_line) || start + 149), Math.min(MAX_READ, ctx.room || MAX_READ));
    const fromRepo = resolveAgentPath(path).area === 'repos';
    return {
      model: { path, total_lines: lines.length, start_line: start, end_line: end, content: fromRepo || isAttachmentPath(path) || isWebPath(path) ? wrapUntrusted('file ' + path, out) : out, ...(end < lines.length ? { more: `lines ${end + 1}-${lines.length} not shown; read them with start_line, or grep for what you need` } : {}) },
      label: `read ${path}${start > 1 || end < lines.length ? ` lines ${start}-${end}` : ''}`,
      observation: fromRepo ? { source: 'read_file', title: path, text: text.slice(0, 20000) } : null,
    };
  },
});

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|wasm|lock|map|min\.js)$/i;

export const grep = defineTool({
  name: 'grep',
  description: 'Search files for a word or regular expression. Returns matching lines as path:line: text. Use it to find where something is before reading.',
  parameters: params({ pattern: str('Text or regular expression, e.g. "function send" or "TODO|FIXME"'), path: str('Folder or file to search, e.g. /repos/app or /repos/app/src (default /home)'), ignore_case: bool('Case-insensitive (default true)'), skip: num('Skip this many matches (to get the next page)') }, ['pattern']),
  async run({ pattern, path = '/home', ignore_case = true, skip = 0 }, ctx = {}) {
    let re;
    try { re = new RegExp(pattern, ignore_case ? 'i' : ''); } catch { re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignore_case ? 'i' : ''); }
    const base = agentPath(resolveAgentPath(path));
    const single = await readAgentFile(base);
    const files = single != null ? [''] : (await listAgentDir(base)).map(e => e.replace(/\s+\(\d+ B\)$/, '')).filter(f => !f.endsWith('/'));
    const cap = Math.min(6000, ctx.room || 6000);
    const hits = [];
    let size = 0, scanned = 0, more = false, seen = 0;
    for (const f of files) {
      if (BINARY.test(f)) continue;
      const fp = f ? base.replace(/\/$/, '') + '/' + f : base;
      const text = f ? await readAgentFile(fp) : single;
      if (text == null || text.length > 1e6) continue;
      scanned++;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (seen++ < skip) continue;
        const hit = `${fp}:${i + 1}: ${lines[i].trim().slice(0, 160)}`;
        if (size + hit.length > cap || hits.length >= 60) { more = true; break; }
        hits.push(hit); size += hit.length + 1;
      }
      if (more) break;
    }
    const fromRepo = resolveAgentPath(base).area === 'repos';
    const body = hits.join('\n') || '(no matches)';
    return {
      model: { pattern, path: base, files_searched: scanned, matches: fromRepo || isWebPath(base) || hits.some(h => h.startsWith('/home/attachments/')) ? wrapUntrusted('grep ' + base, body) : body, ...(more ? { more: `more matches not shown; call again with skip: ${skip + hits.length}, or narrow the pattern or path` } : {}) },
      label: `grep "${truncate(String(pattern), 40)}" in ${base} (${hits.length}${more ? '+' : ''})`,
    };
  },
});

export const writeFile = defineTool({
  name: 'write_file',
  description: 'Create a text file, or replace a whole file. To change part of an existing file, use edit_file. Files under /home sync to all the user\'s devices.',
  parameters: params({ path: str('File path'), content: str('Full file contents'), overwrite: bool('Set true to replace an existing file with much shorter content') }, ['path', 'content']),
  async run({ path, content, overwrite = false }) {
    const r = resolveAgentPath(path);
    const text = String(content ?? '');
    // A small model asked to change one function wrote the snippet over the whole
    // 2,000-line file. Shrinking a real file to under a third needs overwrite: true.
    const old = await readAgentFile(path).catch(() => null);
    if (old != null && !overwrite) {
      const oldLines = old.split('\n').length, newLines = text.split('\n').length;
      if (oldLines >= 40 && text.length < old.length / 3) {
        return { model: { error: `Not written: this would replace all ${oldLines} lines of ${agentPath(r)} with ${newLines}. To change part of the file, use edit_file (old_text → new_text). Only if you really mean to replace the whole file, call write_file again with overwrite: true.` }, label: `write_file refused (would shrink ${agentPath(r)})` };
      }
    }
    const err = await writeAgentFile(r, text);
    if (err) return { model: { error: err } };
    return { model: { ok: true, path: agentPath(r), chars: text.length }, label: `wrote ${agentPath(r)}` };
  },
});

export const editFile = defineTool({
  name: 'edit_file',
  description: 'Change part of a text file: replaces old_text with new_text. old_text must match the file exactly (copy it from read_file, without the line numbers) and appear only once, so include a few lines around the change.',
  parameters: params({ path: str('File path'), old_text: str('Exact text to replace, copied from the file'), new_text: str('What to put in its place (empty to delete it)'), replace_all: bool('Replace every occurrence instead of exactly one') }, ['path', 'old_text', 'new_text']),
  async run({ path, old_text, new_text = '', replace_all = false }) {
    const r = resolveAgentPath(path);
    const text = await readAgentFile(path);
    if (text == null) return { model: { error: `No such file: ${path}. To create a file, use write_file.` }, label: `edit ${path} (missing)` };
    const from = String(old_text ?? ''), to = String(new_text ?? '');
    if (!from) return { model: { error: 'old_text is empty. Copy the exact lines to change from read_file.' } };
    const at = [];
    for (let i = text.indexOf(from); i >= 0; i = text.indexOf(from, i + Math.max(1, from.length))) at.push(i);
    const lineOf = (i) => text.slice(0, i).split('\n').length;
    if (!at.length) {
      const first = from.split('\n').map(l => l.trim()).find(Boolean) || '';
      const lines = text.split('\n');
      const near = first ? lines.findIndex(l => l.trim() === first) : -1;
      return { model: { error: `old_text was not found in ${agentPath(r)}: it must match exactly, including spaces.` + (near >= 0 ? ` Its first line is at line ${near + 1}; read_file around there and copy the lines exactly.` : ' read_file the part you want to change and copy it exactly.') }, label: `edit ${agentPath(r)} (no match)` };
    }
    if (at.length > 1 && !replace_all) {
      return { model: { error: `old_text appears ${at.length} times (lines ${at.map(lineOf).slice(0, 10).join(', ')}). Include more surrounding lines so it matches once, or set replace_all: true.` }, label: `edit ${agentPath(r)} (${at.length} matches)` };
    }
    const out = replace_all ? text.split(from).join(to) : text.slice(0, at[0]) + to + text.slice(at[0] + from.length);
    const err = await writeAgentFile(r, out);
    if (err) return { model: { error: err } };
    const line = lineOf(at[0]);
    return { model: { ok: true, path: agentPath(r), replaced: replace_all ? at.length : 1, line, lines: out.split('\n').length }, label: `edited ${agentPath(r)} (line ${line}${replace_all && at.length > 1 ? `, ${at.length} places` : ''})` };
  },
});

export const deleteFile = defineTool({
  name: 'delete_file',
  description: 'Delete a file (or folder) in the workspace.',
  parameters: params({ path: str('Path to delete') }, ['path']),
  async run({ path }) {
    const r = resolveAgentPath(path);
    const rp = realPath(r);
    if (rp.kind === 'virtual' || (r.area === 'home' && !r.rel)) return { model: { error: 'Refusing to delete a workspace root.' } };
    if (rp.kind === 'home') await storage.remove(rp.rel);
    else await rmrf(rp.path);
    return { model: { ok: true }, label: `deleted ${agentPath(r)}` };
  },
});
