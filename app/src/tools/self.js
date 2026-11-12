// `squiggle`: the agent's view of its own app, as one custom bash command (tools/bash.js). Nothing here costs
// prompt: the model learns it from `man squiggle` / `squiggle --help` when it needs it, like the other commands.
//   squiggle [about]            what it is: the model and how it runs, the context type and window, this chat, storage
//   squiggle chats [-n N] [WORDS]   recent chats (or ones matching WORDS) as markdown links the reply can copy
//   squiggle chat [ID]          one chat's own settings (model, context type, dates, size); this chat by default
//   squiggle read [ID]          the whole chat, every message, to pipe into tail/grep (chatText)
//   squiggle rename "TITLE"     renames this chat (small models never get an auto title, nameSession)
//   squiggle memory [WORDS]     what's saved about the user (all, or matching), with ids
//   squiggle forget ID          deletes a saved fact the user says is wrong
// Read-only except rename (this chat only) and forget (one fact): neither touches the token, other chats'
// content or settings, and both are easy to undo in the UI. Changing models or context types stays the user's.
//
// Pure over `deps` so it's testable without a browser; bash.js passes the real sessions/memory/agent info.

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const oneLine = (s, n = 80) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const date = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');
// Markdown link text can't hold ] or a newline; a title with them would break the link the model copies.
const linkText = (s) => oneLine(s, 60).replace(/[[\]]/g, '') || 'Untitled chat';
export const chatMarkdown = (s) => `[${linkText(s.title)}](#chat=${s.id})`;

// ── squiggle read: a whole chat on stdout, so the model can pipe it into tail, grep, sed ──

const pad = (n) => String(n).padStart(2, '0');
// Local time, as the user sees it in the app.
export const stamp = (ts) => { if (!ts) return ''; const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** The whole chat as markdown: a header (title, link, settings), then every message with who, when, its id and
 *  thread, attachments and the tools the reply used. No cap: bash.js saves big output to /tmp for the model. */
export function chatText(s, deps = {}) {
  const msgs = (s.messages || []).filter(m => !m.deleted);
  const model = s.model ? (deps.modelLabel ? deps.modelLabel(s.model) : s.model) : 'the device default';
  const out = [
    `# ${oneLine(s.title, 200) || 'Untitled chat'}`,
    `Link: ${chatMarkdown(s)} · id ${s.id} · model: ${model} · context type: ${s.contextMode ? modeLabel(deps, s.contextMode) : 'the device default'}`,
    `Started ${stamp(s.created)} · last message ${stamp(s.updated)} · ${msgs.length} message${msgs.length === 1 ? '' : 's'}${s.archived ? ' · archived' : ''}`,
  ];
  for (const m of msgs) {
    const thread = m.thread ? ` · thread: ${oneLine((s.threads && s.threads[m.thread] && s.threads[m.thread].title) || m.thread, 60)}` : '';
    out.push('', `## ${m.role} · ${stamp(m.ts)} · ${m.id}${thread}${m.pinned ? ' · pinned' : ''}`);
    for (const a of m.attachments || []) out.push(`[attached: ${a.name}${a.path ? ` → /home/${String(a.path).replace(/^home\//, '')}` : ''}]`);
    out.push(String(m.content || '').trim());
    const tools = (m.tools || []).filter(t => t && t.name);
    if (tools.length) out.push('', ...tools.map(t => `- ${t.ok === false ? '✕ ' : ''}${t.name}: ${oneLine(t.label || '', 160)}`));
  }
  return out.join('\n') + '\n';
}

export const HELP_SELF = `squiggle: about you (Squiggle), this chat and the user's other chats.
  squiggle                      what you are: model, how it runs, context type and window, this chat, storage
  squiggle chats [-n N] [WORDS] recent chats, or ones mentioning WORDS, as markdown links: put the link in your
                                reply as-is and the user can tap it to open that chat
  squiggle chat [ID]            a chat's settings (model, context type, dates, messages); this chat by default
  squiggle rename "TITLE"       rename this chat (do it when the user asks, or once the topic is clear)
  squiggle memory [WORDS]       facts saved about the user (all, or matching WORDS), with ids
  squiggle forget ID            delete a saved fact the user says is wrong or outdated
  squiggle read [ID]            a whole chat (this one by default), every message: pipe it, e.g.
                                squiggle read | tail -40, squiggle read ID | grep -i -A3 "toki pona"
Save a new fact with the remember tool. The model and context type are the user's to change, in the app.`;

function modeLabel(deps, mode) {
  const m = deps.contextModes && deps.contextModes[mode];
  return m ? m.short || m.label : mode || '';
}

function chatSettings(deps, s, here) {
  const msgs = (s.messages || []).filter(m => !m.deleted && (m.role === 'user' || m.role === 'assistant'));
  const model = s.model ? (deps.modelLabel ? deps.modelLabel(s.model) : s.model) : null;
  return [
    `${here ? 'This chat' : 'Chat'}: ${chatMarkdown(s)}  (id ${s.id})`,
    `  model: ${model || 'the device default'}${here && deps.about && deps.about.model ? ` (running now: ${deps.about.model})` : ''}`,
    `  context type: ${s.contextMode ? modeLabel(deps, s.contextMode) : 'the device default'}`,
    `  started ${date(s.created)}, last message ${date(s.updated)}, ${msgs.length} message${msgs.length === 1 ? '' : 's'}${s.archived ? ', archived' : ''}`,
  ].join('\n');
}

function about(deps, session) {
  const a = deps.about || {};
  return [
    'You are Squiggle: an AI agent that runs privately in the user\'s web browser, on their own device.',
    a.model ? `Model: ${a.model}${a.how ? `, running ${a.how}` : ''}.` : '',
    a.contextMode ? `Context: ${modeLabel(deps, a.contextMode)}, a ${a.contextSize || '?'}-token window${a.contextHint ? ` (${a.contextHint})` : ''}.` : '',
    a.tools ? `Your tools: ${a.tools}.` : '',
    a.storage ? `Storage: ${a.storage}.` : '',
    session ? chatSettings(deps, session, true) : '',
    'More: squiggle chats, squiggle read [ID] (a whole chat, to pipe into grep or tail), squiggle memory, squiggle --help.',
  ].filter(Boolean).join('\n');
}

/** Runs `squiggle <argv>`; returns { stdout, stderr, exitCode } like any just-bash command. */
export async function squiggle(argv, deps = {}) {
  const say = (s) => ({ stdout: s.endsWith('\n') ? s : s + '\n', stderr: '', exitCode: 0 });
  const fail = (s, code = 1) => ({ stdout: '', stderr: s.endsWith('\n') ? s : s + '\n', exitCode: code });
  const [sub = 'about', ...rest] = argv;
  const session = deps.session || null;
  const list = () => (deps.list ? deps.list() : []).filter(s => s && !s.deleted);

  if (argv.some(a => a === '--help' || a === '-h')) return say(HELP_SELF);
  switch (sub) {
    case 'help': return say(HELP_SELF);
    case 'about': case 'whoami': case 'info': return say(about(deps, session));

    case 'chats': case 'ls': {
      let n = 10;
      const words = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-n' && rest[i + 1]) n = Math.max(1, Math.min(50, Number(rest[++i]) || 10));
        else words.push(rest[i]);
      }
      const q = words.join(' ').toLowerCase().match(/[a-z0-9']{2,}/g) || [];
      let chats = list().sort((a, b) => (b.updated || 0) - (a.updated || 0));
      if (q.length) {
        // Title words count double; a chat needs at least half the words somewhere (titles + message text).
        const scored = chats.map(s => {
          const title = String(s.title || '').toLowerCase();
          const body = (s.messages || []).filter(m => !m.deleted).map(m => String(m.content || '')).join('\n').toLowerCase();
          const score = q.reduce((t, w) => t + (title.includes(w) ? 2 : body.includes(w) ? 1 : 0), 0);
          const hits = q.filter(w => title.includes(w) || body.includes(w)).length;
          return { s, score, hits };
        }).filter(x => x.hits >= Math.ceil(q.length / 2));
        chats = scored.sort((a, b) => b.score - a.score || (b.s.updated || 0) - (a.s.updated || 0)).map(x => x.s);
      }
      if (!chats.length) return say(q.length ? `No chats mention "${words.join(' ')}". Try fewer or other words, or squiggle chats for the latest.` : 'No chats yet.');
      const rows = chats.slice(0, n).map(s => `- ${chatMarkdown(s)} ${date(s.updated)}${session && s.id === session.id ? ' (this chat)' : ''}`);
      return say(`${rows.join('\n')}${chats.length > n ? `\n(${chats.length - n} more: -n N for more, or add words)` : ''}\nTo point the user at one, put its link in your reply exactly as shown.`);
    }

    case 'chat': {
      const id = rest[0];
      if (!id) return session ? say(chatSettings(deps, session, true)) : fail('squiggle chat: no chat open; give an id from squiggle chats');
      const s = ID.test(id) && (deps.get ? deps.get(id) : list().find(x => x.id === id));
      if (!s || s.deleted) return fail(`squiggle chat: no chat with id ${id} (squiggle chats lists them)`);
      return say(chatSettings(deps, s, session && s.id === session.id));
    }

    case 'read': case 'cat': case 'history': {
      const id = rest[0];
      const s = !id ? session : ID.test(id) && (deps.get ? deps.get(id) : list().find(x => x.id === id));
      if (!s || s.deleted) return fail(id ? `squiggle read: no chat with id ${id} (squiggle chats lists them)` : 'squiggle read: no chat open; give an id from squiggle chats');
      return { stdout: chatText(s, deps), stderr: '', exitCode: 0 };
    }

    case 'rename': case 'title': {
      if (!session) return fail('squiggle rename: no chat open');
      const title = oneLine(rest.join(' '), 60).replace(/^["']|["']$/g, '').trim();
      if (!title) return fail('usage: squiggle rename "New title"');
      const before = session.title;
      session.title = title;
      if (deps.touch) deps.touch(session);
      return say(`Renamed this chat from "${oneLine(before, 60)}" to "${title}".`);
    }

    case 'memory': case 'facts': {
      const facts = deps.facts ? deps.facts() : [];
      if (!facts.length) return say('Nothing saved about the user yet. When they tell you something lasting (their name, preferences, projects, decisions), save it with remember.');
      const q = rest.join(' ').toLowerCase().match(/[a-z0-9']{2,}/g) || [];
      const text = (f) => (deps.factText ? deps.factText(f) : `${f.s} ${f.p} ${f.o}`);
      const shown = q.length ? facts.filter(f => { const t = text(f).toLowerCase(); return q.some(w => t.includes(w)); }) : facts;
      if (!shown.length) return say(`No saved facts mention "${rest.join(' ')}" (${facts.length} saved in all: squiggle memory lists them).`);
      const recent = [...shown].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 30);
      return say(`${recent.map(f => `- [${f.id}] ${oneLine(text(f), 160)}`).join('\n')}${shown.length > recent.length ? `\n(${shown.length - recent.length} older not shown; add words to narrow)` : ''}`);
    }

    case 'forget': {
      const id = rest[0];
      if (!id) return fail('usage: squiggle forget ID (ids from squiggle memory)');
      return deps.forget && deps.forget(id) ? say(`Forgot fact ${id}.`) : fail(`squiggle forget: no fact with id ${id}`);
    }

    default: return fail(`squiggle: unknown subcommand '${sub}'. Try: squiggle, squiggle chats, squiggle chat, squiggle read, squiggle rename, squiggle memory (squiggle --help).`);
  }
}
