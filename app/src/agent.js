// The agent loop: build context → stream → run tools → repeat, then save.
// Plus background jobs that keep context small: rolling summaries, thread
// outcomes, and learning memory facts.
import * as engine from './engine.js';
import * as sessions from './sessions.js';
import * as memory from './memory.js';
import { assembleContext, summaryBacklog, messageText } from './context.js';
import { toolSpecs, runTool } from './tools.js';
import { UNTRUSTED_RULES } from './untrusted.js';
import { embed } from './embed.js';
import { estTokens, truncate } from './util.js';
import { parseJsonl } from './merge.js';

export const settings = {
  model: 'E2B',
  contextSize: 8192,
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
    `When you learn something lasting about the user or their projects (preferences, decisions, names), save it with remember. Use search_history to find things from past conversations.`,
    `Use tools when they help; answer directly when they don't. Be concise. Never invent file contents or tool results.`,
    thread ? `This is a side thread started on an earlier message ("${truncate(thread.title, 80)}"). Focus on that topic.` : '',
    UNTRUSTED_RULES(),
  ].filter(Boolean).join('\n\n');
}

/**
 * Runs one user turn. `ui` callbacks: onStart(msg), onText(text), onThinking(text),
 * onTool(label), onDone(msg), onError(err). Returns the assistant message.
 */
export function runTurn({ session, threadId = null, text, ui = {}, signal }) {
  const userMsg = sessions.addMessage(session, { role: 'user', content: text, thread: threadId });
  ui.onUser && ui.onUser(userMsg);
  return engine.foreground(async () => {
    const tools = toolSpecs(settings.tools);
    const toolTokens = estTokens(JSON.stringify(tools));
    const budget = settings.contextSize - MAX_OUTPUT - toolTokens - 200;
    const line = sessions.lineMessages(session, threadId).filter(m => m.id !== userMsg.id);
    const ctx = await assembleContext({
      line, session, threadId, query: text, budget, mode: settings.contextMode,
      system: systemPrompt(threadId, session),
      recall: (q, k) => memory.recall(q, k), factText: memory.factText,
      embed: settings.contextMode === 'smart' ? embed : null,
    });

    const reply = { role: 'assistant', content: '', thread: threadId, tools: [], context: ctx.report };
    ui.onStart && ui.onStart(reply);
    let conv;
    try {
      conv = await engine.conversation({ system: ctx.system, messages: ctx.messages, tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT });
      let pending = text;
      let prefix = '';
      for (let round = 0; ; round++) {
        const r = await engine.respond(conv, pending, {
          signal,
          onText: (t) => ui.onText && ui.onText(prefix + t),
          onThinking: (t) => ui.onThinking && ui.onThinking(t),
        });
        if (r.text) prefix += r.text + (r.toolCalls.length ? '\n\n' : '');
        if (!r.toolCalls.length || signal?.aborted) break;
        if (round >= settings.maxToolRounds) {
          prefix += `\n\n_(Stopped after ${settings.maxToolRounds} rounds of tool use. Say "continue" to keep going.)_`;
          break;
        }
        const results = [];
        for (const call of r.toolCalls) {
          ui.onTool && ui.onTool({ name: call.function && call.function.name, running: true });
          const res = await runTool(call, { session, threadId, approve: (req) => askApproval(req, ui, signal) });
          reply.tools.push({ name: res.name, label: res.label, ok: res.ok });
          ui.onTool && ui.onTool({ name: res.name, label: res.label, ok: res.ok, running: false });
          if (res.observation) sessions.addObservation(session, { ...res.observation, thread: threadId });
          const response = res.model && typeof res.model === 'object' ? res.model : { value: res.model };
          results.push({ role: 'tool', content: [{ name: res.name || 'unknown', response }] });
        }
        pending = results;
      }
      reply.content = prefix.trim();
    } catch (e) {
      reply.content = (reply.content || '') + `\n\n⚠️ ${e.message || e}`;
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
