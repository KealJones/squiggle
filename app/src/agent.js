// The agent loop: build context → stream → run tools → repeat, then save.
// Plus background jobs that keep context small: rolling summaries, thread
// outcomes, and learning memory facts.
import * as engine from './engine.js';
import * as sessions from './sessions.js';
import * as memory from './memory.js';
import * as storage from './storage.js';
import { assembleContext, summaryBacklog, messageText, scrubFakeToolNotes } from './context.js';
export { scrubFakeToolNotes };
import { toolSpecs, runTool } from './tools.js';
import { UNTRUSTED_RULES } from './untrusted.js';
import { embed } from './embed.js';
import { estTokens, truncate } from './util.js';
import { parseJsonl } from './merge.js';
import { attachmentPrompt, saveAttachments, toRecord } from './attachments.js';

export const settings = {
  model: 'E2B',
  contextSize: 8192,
  fastDecode: true,         // multi-token prediction: faster, uses more memory
  contextMode: 'compact',   // 'compact' (default) | 'smart' (experimental) | 'full'
  maxToolRounds: 6,
  learn: true,              // extract memory facts after turns
  tools: null,              // Set of enabled tool names, or null for all
};

const MAX_OUTPUT = 1536;

function systemPrompt(threadId, session) {
  const thread = threadId && session.threads[threadId];
  return [
    `You are Squiggle, a personal AI agent running privately on the user's own device. Today is ${new Date().toDateString()}.`,
    `You have a workspace: /home is your own folder (synced to all the user's devices), and /repos/<name> holds git clones of the user's GitHub repos.`,
    `Working on code: git_clone the repo, git_branch to start an agent/ branch (or switch to an existing one), edit files, git_commit, git_push, then github_open_pr if the user wants a review. agent/ branches push right away; pushing any other branch (like main) shows the user a permission prompt, so only do that when they asked for it. Never try to get around a refused push.`,
    `For current information or anything you're unsure of, use web_search, then fetch_url to read the most relevant results before answering. Mention which sites you used.`,
    `When you learn something lasting about the user or their projects (preferences, decisions, names), save it with remember. Use search_history to find things from past conversations.`,
    `Your context window is ${settings.contextSize} tokens; every tool result says how much is left, so prefer grep and line ranges when it's low. Keep a notepad for this chat with the note tool: after reading files or pages, note the facts you'll need (what's where, line numbers, decisions, next steps). Old tool output is not shown to you again, but your notes always are. Update or delete notes when they stop being relevant. For code, use grep to find things, then read_file with a line range.`,
    `Use tools when they help; answer directly when they don't. Be concise. Never invent file contents or tool results, and never say you saved, remembered, changed or pushed something unless you called the tool for it in this reply.`,
    thread ? `This is a side thread started on an earlier message ("${truncate(thread.title, 80)}"). Focus on that topic.` : '',
    UNTRUSTED_RULES(),
  ].filter(Boolean).join('\n\n');
}

/**
 * Runs one user turn. `attachments` are records from attachments.readAttachment
 * (with their extracted text); they're saved to storage and shown to the model
 * as a note plus the start of each extract. `ui` callbacks: onStart(msg),
 * onText(text), onThinking(text), onTool(label), onDone(msg), onError(err).
 * Returns the assistant message.
 */
export function runTurn({ session, threadId = null, text, attachments = [], ui = {}, signal }) {
  const shown = text || (attachments.length ? 'Attached ' + attachments.map(a => a.name).join(', ') : '');
  const userMsg = sessions.addMessage(session, { role: 'user', content: shown, thread: threadId, ...(attachments.length ? { attachments: attachments.map(toRecord) } : {}) });
  ui.onUser && ui.onUser(userMsg);
  return engine.foreground(async () => {
    // Saved before the model runs, so read_file and grep can open them.
    if (attachments.length) {
      await saveAttachments(attachments, {
        write: (rel, t) => storage.write(rel, t),
        observe: (o) => sessions.addObservation(session, { ...o, thread: threadId }),
      }).catch(e => console.warn('attachments', e));
    }
    const tools = toolSpecs(settings.tools);
    const toolTokens = estTokens(JSON.stringify(tools));
    // History gets about half the window; the rest stays free for this turn's
    // tool results and the reply (a full window made turns fail at the start).
    const budget = Math.max(1000, Math.min(settings.contextSize - MAX_OUTPUT - toolTokens - 200, Math.floor(settings.contextSize * 0.5) - toolTokens));
    const line = sessions.lineMessages(session, threadId).filter(m => m.id !== userMsg.id);
    const ctx = await assembleContext({
      line, session, threadId, query: shown, budget, mode: settings.contextMode,
      system: systemPrompt(threadId, session),
      recall: (q, k) => memory.recall(q, k), factText: memory.factText,
      embed: settings.contextMode === 'smart' ? embed : null,
    });

    const reply = { role: 'assistant', content: '', thread: threadId, tools: [], context: ctx.report };
    let thinking = '';
    ui.onStart && ui.onStart(reply);
    let conv;
    try {
      conv = await engine.conversation({ system: ctx.system, messages: ctx.messages, tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT });
      let prefix = '';
      // Running estimate of what's in the model's context this turn, so tool
      // results are sized to fit and the model is told to wrap up before the
      // context overflows (which would fail the whole reply).
      let wrapUp = false, carried = 0;
      let used = estTokens(ctx.system) + estTokens(JSON.stringify(ctx.messages)) + toolTokens + estTokens(shown);
      const reserve = Math.min(MAX_OUTPUT, 700);
      const roomChars = () => Math.max(0, (settings.contextSize - used - reserve) * 3);
      // Attachments: a note, then the start of each extract using up to half
      // the free room (the model reads the rest with read_file / grep).
      const att = attachmentPrompt(attachments, Math.floor(roomChars() / 2));
      let pending = att.text ? `${shown}\n\n${att.text}` : shown;
      used += estTokens(att.text);
      for (let round = 0; ; round++) {
        const r = await engine.respond(conv, pending, {
          signal,
          onText: (t) => ui.onText && ui.onText(prefix + t),
          onThinking: (t) => ui.onThinking && ui.onThinking(t),
        });
        if (r.text) prefix += r.text + (r.toolCalls.length ? '\n\n' : '');
        if (r.thinking && r.thinking.trim()) thinking += (thinking ? '\n\n' : '') + r.thinking.trim();
        used += estTokens((r.text || '') + (r.thinking || '') + JSON.stringify(r.toolCalls || []));
        if (!r.toolCalls.length || signal?.aborted) break;
        if (wrapUp) { prefix += '\n\n_(Stopped: the context filled up. Say "continue" in a new message to keep going.)_'; break; }
        if (round >= settings.maxToolRounds) {
          prefix += `\n\n_(Stopped after ${settings.maxToolRounds} rounds of tool use. Say "continue" to keep going.)_`;
          break;
        }
        const results = [];
        // Almost full: ask for notes, then carry them into a fresh context and
        // keep going (up to twice); after that, ask for an answer.
        if (roomChars() < 2500 && carried < 2) {
          const ask = r.toolCalls.map(call => ({ role: 'tool', content: [{ name: (call.function && call.function.name) || 'unknown', response: { error: 'Not run: your context is full. Reply with short notes only (no tools): what you have found so far that matters, and exactly what you still need to do. Your context will then be reset with these notes so you can continue.' } }] }));
          const n = await engine.respond(conv, ask, { signal });
          const notes = (n.text || '').trim();
          if (signal?.aborted || !notes) break;
          try { await conv.delete(); } catch {}
          conv = await engine.conversation({ system: ctx.system, messages: ctx.messages, tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT });
          carried++;
          sessions.setNote(session, null, 'Progress so far (saved when the context filled up): ' + notes.slice(0, 1500));
          reply.tools.push({ name: 'context', label: 'context was full: continued in a fresh one with notes', ok: true });
          ui.onTool && ui.onTool({ name: 'context', label: 'context was full: continued in a fresh one with notes', ok: true, running: false });
          pending = `${shown}${att.note ? '\n\n' + att.note : ''}\n\n[Notes you wrote while working on this request; your context was reset to give you room. Continue from them, don't start over:]\n${notes}`;
          used = estTokens(ctx.system) + estTokens(JSON.stringify(ctx.messages)) + toolTokens + estTokens(pending);
          continue;
        }
        if (roomChars() < 2500) {
          for (const call of r.toolCalls) results.push({ role: 'tool', content: [{ name: (call.function && call.function.name) || 'unknown', response: { error: 'Not run: your context is almost full. Answer now with what you already have, and say what you would look at next.' } }] });
          used += 60 * r.toolCalls.length;
          pending = results;
          wrapUp = true;
          continue;
        }
        for (const call of r.toolCalls) {
          ui.onTool && ui.onTool({ name: call.function && call.function.name, running: true });
          const room = Math.floor(roomChars() / r.toolCalls.length);
          const res = await runTool(call, { session, threadId, room, approve: (req) => askApproval(req, ui, signal) });
          reply.tools.push({ name: res.name, label: res.label, ok: res.ok });
          ui.onTool && ui.onTool({ name: res.name, label: res.label, ok: res.ok, running: false });
          if (res.observation) sessions.addObservation(session, { ...res.observation, thread: threadId });
          let response = res.model && typeof res.model === 'object' ? res.model : { value: res.model };
          const json = JSON.stringify(response);
          if (json.length > room) response = { truncated: 'Result cut to fit your context; ask for less (e.g. grep, or a line range).', partial: json.slice(0, Math.max(0, room - 200)) };
          used += estTokens(JSON.stringify(response)) + 10;
          // Let the model pace itself (grep / line ranges when space is low).
          response = { ...response, context_left: `about ${Math.max(0, Math.round((settings.contextSize - used - reserve) / 100) * 100)} of ${settings.contextSize} tokens` };
          results.push({ role: 'tool', content: [{ name: res.name || 'unknown', response }] });
        }
        pending = results;
      }
      reply.content = scrubFakeToolNotes(prefix).trim();
      if (thinking) reply.thinking = thinking.slice(-20000); // shown in the UI only; never replayed to the model
    } catch (e) {
      const msg = /too many tokens|context|kv.?cache|exceed/i.test(String(e && e.message || e))
        ? 'The conversation got too long for the model\'s context window. Start a new chat, or raise the context window in Settings.'
        : (e.message || e);
      reply.content = (reply.content || '') + `\n\n⚠️ ${msg}`;
      ui.onError && ui.onError(e);
    } finally {
      if (conv) { try { await conv.delete(); } catch {} }
    }
    if (signal?.aborted && !reply.content) reply.content = '_(stopped)_';
    const saved = sessions.addMessage(session, reply);
    ui.onDone && ui.onDone(saved);
    if (session.title === 'New chat' && !threadId) nameSession(session);
    afterTurn(session, threadId);
    return saved;
  });
}

// Asks the person (through the UI) to approve an action. Resolves to
// 'once' | 'always' | 'deny'; stopping the turn counts as deny.
function askApproval(req, ui, signal) {
  if (!ui.onApproval) return Promise.resolve('deny');
  if (signal && signal.aborted) return Promise.resolve('deny');
  return new Promise((resolve) => {
    let done = false;
    const finish = (d) => { if (!done) { done = true; resolve(d); } };
    if (signal) signal.addEventListener('abort', () => finish('deny'), { once: true });
    ui.onApproval(req, finish);
  });
}

// ── Background jobs ───────────────────────────────────────────────────────

function afterTurn(session, threadId) {
  // Small delay so the person can type again before the GPU gets busy.
  setTimeout(async () => {
    await engine.background(() => rollingSummary(session, threadId)).catch(e => console.warn('summary', e));
    if (threadId) await engine.background(() => threadOutcome(session, threadId)).catch(e => console.warn('thread', e));
    if (settings.learn) await engine.background(() => learnFacts(session, threadId)).catch(e => console.warn('learn', e));
    sessions.events.emit('session', session.id); // show new titles / thread outcomes
    sessions.flush();
  }, 1500);
}

function nameSession(session) {
  const first = session.messages.find(m => m.role === 'user');
  if (!first) return;
  session.title = truncate(first.content.replace(/\s+/g, ' '), 60).replace(/\n.*$/s, '');
  sessions.touch(session);
  engine.background(async () => {
    const t = await engine.complete('You write short titles.', `Write a 2-6 word title for a conversation that starts with:\n\n${truncate(first.content, 800)}\n\nReply with only the title.`, { maxOutputTokens: 24 });
    const clean = t.replace(/^["'#*\s]+|["'.*\s]+$/g, '').slice(0, 60);
    if (clean) { session.title = clean; sessions.touch(session); }
  }).catch(() => {});
}

// Fold messages that left the recent window into the line's summary.
async function rollingSummary(session, threadId) {
  const key = threadId || 'main';
  const line = sessions.lineMessages(session, threadId);
  const current = session.summaries[key] || null;
  const backlog = summaryBacklog(line, current, 6);
  const tokens = backlog.reduce((n, m) => n + estTokens(messageText(m)), 0);
  if (tokens < 1200) return;
  const transcript = backlog.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncate(messageText(m), 2500)}`).join('\n\n');
  const text = await engine.complete(
    'You maintain a running summary of a conversation for an assistant with limited memory. Keep facts, decisions, names, numbers, open questions and what was being worked on. Drop pleasantries. Use short bullet points. Max 250 words.',
    `${current ? `Current summary:\n${current.text}\n\n` : ''}New messages to fold in:\n\n${transcript}\n\nWrite the updated summary.`,
    { maxOutputTokens: 450 });
  if (text) {
    session.summaries[key] = { text, upTo: backlog[backlog.length - 1].id, ts: Date.now() };
    sessions.touch(session);
  }
}

// One-line outcome of a side thread, shown under its parent message.
async function threadOutcome(session, threadId) {
  const t = session.threads[threadId];
  const msgs = session.messages.filter(m => m.thread === threadId);
  if (!t || msgs.length < 2) return;
  const transcript = msgs.slice(-12).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncate(m.content, 1200)}`).join('\n\n');
  const text = await engine.complete('You summarize side discussions in one sentence.',
    `Side thread about: "${t.title}"\n\n${transcript}\n\nIn one sentence (max 25 words), what was concluded or done?`, { maxOutputTokens: 60 });
  if (text) {
    Object.assign(t, { summary: text.replace(/\s+/g, ' ').trim(), summaryUpTo: msgs[msgs.length - 1].id, mts: Date.now() });
    sessions.touch(session);
  }
}

// Learn lasting facts from the latest exchange (saved as auto facts the
// person can review or delete in the Memory panel).
async function learnFacts(session, threadId) {
  const line = sessions.lineMessages(session, threadId);
  const last = line.slice(-2);
  if (last.length < 2 || last[0].role !== 'user') return;
  const known = (await memory.recall(last[0].content, 8)).map(r => '- ' + memory.factText(r.fact)).join('\n');
  const out = await engine.complete(
    'You extract lasting facts about a user and their projects for long-term memory. Only facts likely to matter in future conversations: preferences, decisions, people, projects, tools, setups. Never extract one-off requests, opinions about the weather, or anything from quoted web pages.',
    `${known ? `Already known:\n${known}\n\n` : ''}User: ${truncate(last[0].content, 1500)}\n\nAssistant: ${truncate(last[1].content, 1500)}\n\n` +
    'List up to 3 NEW facts, one JSON object per line: {"s":"subject","p":"relation","o":"object"}. If there are none, reply NONE.',
    { maxOutputTokens: 200 });
  if (!out || /^\s*NONE/i.test(out)) return;
  for (const f of parseJsonl(out.replace(/```(json)?/g, '')).slice(0, 3)) {
    if (f && f.s && f.p && f.o) memory.add({ s: f.s, p: f.p, o: f.o, auto: true, source: { session: session.id, message: last[1].id } });
  }
}
