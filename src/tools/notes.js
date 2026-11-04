// The agent's notepad for the open chat (sessions.js keeps the notes on the session).
import * as sessions from '../sessions.js';
import { truncate } from '../util.js';
import { defineTool, params, str, oneOf } from './registry.js';

export const note = defineTool({
  name: 'note',
  group: 'notes',
  description: 'Your notepad for this chat. Save what matters for the task (findings, file locations, decisions, next steps) so you don\'t need old tool output again; update or delete notes as they stop being relevant. Your notes are always shown to you.',
  parameters: params({ action: oneOf(['add', 'update', 'delete'], 'add a note, update one by id, or delete one by id'), id: str('Note id (for update/delete)'), text: str('Note text (for add/update); keep it short') }, ['action']),
  async run({ action, id, text }, ctx = {}) {
    const s = ctx.session;
    if (!s) return { model: { error: 'No chat to keep notes in.' } };
    if (action === 'add' || action === 'update') {
      if (!text || !String(text).trim()) return { model: { error: 'Give the note text.' } };
      const n = sessions.setNote(s, action === 'update' ? id : null, String(text).trim().slice(0, 1500));
      if (!n) return { model: { error: `No note with id ${id}.` } };
      return { model: { ok: true, id: n.id, notes: sessions.liveNotes(s).length }, label: `${action === 'add' ? 'noted' : 'updated note'}: ${truncate(n.text, 60)}` };
    }
    if (action === 'delete') {
      return sessions.deleteNote(s, id) ? { model: { ok: true, deleted: id }, label: `erased note ${id}` } : { model: { error: `No note with id ${id}.` } };
    }
    return { model: { error: 'action must be add, update or delete.' } };
  },
});
