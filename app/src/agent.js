// The agent loop (docs/harness.md): resolve references,
// then the model answers directly or makes a plan; a plan is worked one step
// at a time with a fresh prompt per step, and a finished plan is saved as a
// recipe so the next similar request is fast. Plus background jobs that keep
// context small: rolling summaries, thread outcomes, and learning memory facts.
import * as engine from './engine.js';
import * as sessions from './sessions.js';
import * as memory from './memory.js';
import * as storage from './storage.js';
import * as recipes from './recipes.js';
import * as tasks from './tasks.js';
import { find as findAll, renderFind, PAST_CHAT } from './find.js';
import { buildEntities, resolve as resolveRefs, renderRefs } from './refs.js';
import { assembleContext, summaryBacklog, messageText, scrubFakeToolNotes } from './context.js';
export { scrubFakeToolNotes };
import { toolSpecs, runTool } from './tools.js';
import { UNTRUSTED_RULES, wrapUntrusted } from './untrusted.js';
import { embed } from './embed.js';
import { bm25, tokenize } from './search.js';
import { estTokens, truncate } from './util.js';
import { parseJsonl } from './merge.js';
import { attachmentPrompt, saveAttachments, toRecord } from './attachments.js';

export const settings = {
  model: 'E2B',
  contextSize: 8192,
  fastDecode: true,         // multi-token prediction: faster, uses more memory
  smallGpu: false,          // small models (wllama): run on WebGPU (experimental)
  smallThreads: false,      // small models (wllama): use several CPU cores; needs an isolated page (sw.js)
  contextMode: 'smart',     // 'smart' (default) | 'compact' | 'full'
  semantic: true,           // MiniLM embeddings for retrieval (off on phones; BM25 alone works)
  recallChats: true,        // smart mode may recall messages from other chats too
  learn: true,              // extract memory facts after turns
  tools: null,              // Set of enabled tool names, or null for all
  promptSize: 'auto',       // small (wllama) models: 'auto' | 'small' | 'big' (see smallPrompt)
};

const MAX_OUTPUT = 1536;
const CHAT_PLAN_NUDGE = 6;  // tool calls without a plan before the model is reminded it can make one

// The small model's whole system prompt: the exact text the fine-tune trains
// on (docs/harness.md, "Small-model format"). Tool names appear only in the
// one list line, never in prose it could copy.
export const LITE_SYSTEM = [
  'You are Squiggle, an assistant that figures things out. Think first. If you',
  'don\'t know something, don\'t guess: find it or look it up. For anything with',
  'more than one step, make a plan, then do one step at a time.',
  'Call a tool with a ```tool_call block containing {"name", "arguments"}; tools',
  'you have: plan, done, need, find, and any tool you have looked up with find.',
  'Arguments: plan(goal, steps), done(result), need(what), find(query).',
].join('\n');

// Small-model prompt for models in their own tool format (native: Qwen3.5, …): the same short text as
// Squiggle Small's, but tools are called the model's own way and the web tools come up front.
const NATIVE_SMALL = [
  'You are Squiggle, an assistant that figures things out. Think first. If you',
  'don\'t know something, don\'t guess: find it or look it up. For anything with',
  'more than one step, make a plan, then do one step at a time.',
  'You start with these tools: plan, done, need, find, web_search, fetch_url.',
  'find looks up any other tool you need (calculate for math, files, repos,',
  'memory); after that you can call it. Never do math in your head.',
].join('\n');
// Squiggle Small's tool format, added to the full prompt when it runs in big mode.
const LITE_FORMAT = 'Call a tool with a ```tool_call block containing {"name", "arguments"}.';

const lite = () => engine.isLite(settings.model);
// A small (wllama) model that speaks Gemma 4's own tool format (engine nativeTools): it gets the full prompt
// and every tool, like E2B, and is otherwise treated as small (context budgets, no background jobs).
const native = () => Boolean(engine.nativeTools && engine.nativeTools(settings.model));
// AI-managed context (Settings → Context: AI-managed): the model sees what everything costs, steps say what
// they need attached, and it can checkpoint to a fresh context (docs/harness.md, "the model manages its own
// context"). Off in plain chat. Compress and Smart are unchanged.
const managed = () => settings.contextMode === 'managed' && !plain();
const UPFRONT = 'You work over several turns and steps. Each one shows you only what it needs; anything earlier can be fetched with find or attached to a step (a plan step\'s needs). Don\'t try to fit everything into one turn. The last line of each prompt says how much room is left; when you\'re running low, call checkpoint and carry on fresh.';
const UPFRONT_SMALL = 'Each step shows only what it needs: attach earlier results to a plan step (needs), or find them.\nThe last line says how much room is left; when it runs low, call checkpoint.';


// Plain chat for small models without tool training (engine.chatOnly).
const plain = () => Boolean(engine.chatOnly && engine.chatOnly(settings.model));
// Small vs big prompt (Settings → Prompt), for small (wllama) models with tools. Small: a short system
// prompt, the harness tools and web_search/fetch_url up front, everything else looked up with find.
// Big: the full computer prompt and every tool. Auto: small, except builds trained on the full
// prompt (MODELS fullPrompt, e.g. Tiny Gemma 4). Computers and the cloud model always get the full one.
export function smallPrompt(id = settings.model) {
  if (!engine.isLite(id) || (engine.chatOnly && engine.chatOnly(id))) return false;
  if (settings.promptSize === 'small') return true;
  if (settings.promptSize === 'big') return false;
  return !(engine.MODELS[id] && engine.MODELS[id].fullPrompt);
}
const small = () => smallPrompt();

function systemPrompt(threadId, session) {
  if (plain()) return '';
  if (small() && !native()) return `${LITE_SYSTEM}${managed() ? '\n' + UPFRONT_SMALL : ''}\nToday is ${new Date().toDateString()}.`;
  if (small()) return `${NATIVE_SMALL}${managed() ? '\n' + UPFRONT_SMALL : ''}\nToday is ${new Date().toDateString()}.\n\n${UNTRUSTED_RULES()}`;
  const thread = threadId && session.threads[threadId];
  return [
    `You are Squiggle, a personal AI agent running privately on the user's own device. Today is ${new Date().toDateString()}.`,
    `You have a workspace: /home is your own folder (synced to all the user's devices), and /repos/<name> holds git clones of the user's GitHub repos.`,
    `Working on code: git_clone the repo, git_branch to start an agent/ branch (or switch to an existing one), edit files, git_commit, git_push, then github_open_pr if the user wants a review. agent/ branches push right away; pushing any other branch (like main) shows the user a permission prompt, so only do that when they asked for it. Never try to get around a refused push.`,
    `For current information or anything you're unsure of, use web_search, then fetch_url to read the most relevant results before answering. Mention which sites you used.`,
    `Don't guess. If an answer depends on a fact you don't have, look it up: find searches tools, recipes from past tasks, memory and past chats; need says what is missing (Squiggle searches for it and asks the user if it can't be found).`,
    `For anything that takes more than one step, call plan(goal, steps) first. You then work one step at a time, each with a fresh view that shows the goal, the plan and what earlier steps found, and finish each step with done(result). Take as long as you need; thinking is shown to the user.`,
    `When you learn something lasting about the user or their projects (preferences, decisions, names), save it with remember. Use search_history to find things from past conversations.`,
    `Your context window is ${settings.contextSize} tokens; every tool result says how much is left, so prefer grep and line ranges when it's low. For quick tasks without a plan, keep notes with the note tool. For code, use grep to find things, then read_file with a line range.`,
    managed() ? UPFRONT : '',
    `Use tools when they help; answer directly when they don't. Be concise. Never invent file contents or tool results, and never say you saved, remembered, changed or pushed something unless you called the tool for it in this reply.`,
    thread ? `This is a side thread started on an earlier message ("${truncate(thread.title, 80)}"). Focus on that topic.` : '',
    UNTRUSTED_RULES(),
    lite() && !native() ? LITE_FORMAT : '',
  ].filter(Boolean).join('\n\n');
}

// Tools for a phase: the enabled agent tools plus the harness's own.
// Tools a small model starts with already "looked up", so it doesn't spend a model
// call on find first: nearly every phone request needs the web. Only ones enabled.
const PRELOADED = ['web_search', 'fetch_url'];
// Tools a small model starts out knowing: in small mode the web tools (the rest come through find);
// in big mode every tool (prompt-format models only; native ones get them all declared anyway).
function preloaded(tools) {
  if (!lite() || plain()) return [];
  if (!small()) return native() ? [] : tools.map(t => t.name);
  const names = new Set(tools.map(t => t.name));
  return PRELOADED.filter(n => names.has(n));
}
// Tool declarations a native small model is sent in small mode: the harness's plus the ones it knows.
const ALWAYS = new Set(['plan', 'done', 'need', 'find', 'checkpoint']);
// Rough token cost of the tools in the prompt.
function toolCost(tools, known) {
  if (lite() && !native() && small()) return 300;            // one list line + details of looked-up tools
  if (small()) { const k = new Set(known); return estTokens(JSON.stringify(tools.filter(t => ALWAYS.has(t.name) || k.has(t.name)))); }
  return estTokens(JSON.stringify(tools));
}

function phaseTools(step) {
  if (plain()) return [];
  const base = toolSpecs(settings.tools).filter(t => !(step && t.name === 'note'));
  const h = tasks.HARNESS_SPECS;
  if (managed()) return [...base, tasks.MANAGED_SPECS.plan, ...(step ? [h.done] : []), h.need, h.find, tasks.MANAGED_SPECS.checkpoint];
  return [...base, h.plan, ...(step ? [h.done] : []), h.need, h.find];
}

// A recipe, written for the prompt.
export function recipeText(r) {
  return [`${r.title}${r.when && r.when !== r.title ? ` (for: ${truncate(r.when, 160)})` : ''}`,
    ...(r.steps || []).map((s, i) => `${i + 1}. ${s}`),
    ...(r.specifics && r.specifics.length ? ['Specifics: ' + r.specifics.join('; ')] : [])].join('\n');
}

const STRIP_UNTRUSTED = /<\/?untrusted[^>]*>/g;

/**
 * Runs one user turn. `attachments` are records from attachments.readAttachment
 * (with their extracted text); they're saved to storage and shown to the model
 * as a note plus the start of each extract. `ui` callbacks: onUser(msg),
 * onStart(msg), onText(text), onThinking(text), onTool(t), onPlan(task),
 * onCheckIn(task, decide(boolean)), onApproval(req, decide), onDone(msg),
 * onError(err). Returns the assistant message.
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
    const turn = new Turn({ session, threadId, shown, attachments, ui, signal, userMsg });
    ui.onStart && ui.onStart(turn.reply);
    tasks.compactOld(session);
    try {
      const lastReply = [...sessions.lineMessages(session, threadId)].reverse().find(m => m.role === 'assistant');
      const resume = tasks.resumable(session, threadId, shown, lastReply && lastReply.task);
      if (resume) {
        const task = resume.task;
        // Files sent with the answer: the model sees their paths (it reads them with read_file).
        const note = attachments.length ? attachmentPrompt(attachments, 0).note : '';
        if (note) task.attachNote = [task.attachNote, note].filter(Boolean).join('\n');
        if (resume.how === 'answer') tasks.answerNeed(task, shown);
        else { task.status = 'active'; tasks.touch(task); }
        sessions.saveTask(session, task);
        await turn.steps(task);
      } else {
        const task = await turn.chat();
        if (task) await turn.steps(task);
      }
    } catch (e) {
      const msg = /too many tokens|context|kv.?cache|exceed/i.test(String(e && e.message || e))
        ? 'The conversation got too long for the model\'s context window. Start a new chat, or raise the context window in Settings.'
        : (e.message || e);
      turn.prefix += `\n\n⚠️ ${msg}`;
      if (turn.task && turn.task.status === 'active' && !turn.task.waiting) { turn.task.status = 'stopped'; sessions.saveTask(session, turn.task); }
      ui.onError && ui.onError(e);
    } finally {
      await turn.close();
      // Stopped mid-task: mark it so "continue" can pick it up (and the checklist doesn't show it as running).
      const t = turn.task;
      if (t && t.status === 'active' && !t.waiting && (turn.aborted || turn.paused)) {
        t.status = 'stopped';
        for (const st of t.steps) if (st.status === 'active') st.status = 'todo';
        tasks.touch(t); sessions.saveTask(session, t); ui.onPlan && ui.onPlan(t);
      }
    }
    const reply = turn.reply;
    reply.content = scrubFakeToolNotes(turn.prefix).trim();
    if (turn.thinking) reply.thinking = turn.thinking.slice(-20000); // shown in the UI only; never replayed to the model
    if (turn.task) reply.task = turn.task.id;
    if (signal?.aborted && !reply.content) reply.content = '_(stopped)_';
    const saved = sessions.addMessage(session, reply);
    ui.onDone && ui.onDone(saved);
    if (session.title === 'New chat' && !threadId) nameSession(session);
    afterTurn(session, threadId, turn.task && turn.task.status === 'done' && turn.finishedNow ? turn.task : null);
    return saved;
  });
}

// One turn's state: the reply being written, counters, and the phases.
class Turn {
  constructor({ session, threadId, shown, attachments, ui, signal, userMsg }) {
    Object.assign(this, { session, threadId, shown, attachments, ui, signal, userMsg });
    this.reply = { role: 'assistant', content: '', thread: threadId, tools: [], context: null };
    this.prefix = '';        // the reply text so far
    this.thinking = '';      // thinking + step narration (UI only)
    this.calls = 0;          // tool calls this turn (check-ins every CHECK_IN_EVERY)
    this.conv = null;
    this.task = null;
    this.recipe = null;      // the best recipe the model found with `find` this turn (carried into its plan's steps)
    this.finishedNow = false;
    this.paused = false;     // the person chose "Stop here" at a check-in
    this.nextCheckIn = tasks.CHECK_IN_EVERY;
    this.attNote = '';       // paths of files sent with this message
    this.checkpoints = 0;    // checkpoints this turn (AI-managed context)
  }

  get aborted() { return Boolean(this.signal && this.signal.aborted); }

  async close() { if (this.conv) { try { await this.conv.delete(); } catch {} this.conv = null; } }

  addThinking(t) {
    if (!t || !t.trim()) return;
    this.thinking += (this.thinking ? '\n\n' : '') + t.trim();
    this.ui.onThinking && this.ui.onThinking(this.thinking);
  }

  // Smart context, small models: once the model has written its Check on a tool
  // result, the raw result leaves its context. A result its Check calls useless
  // ("no results", "unrelated", "doesn't mention…") becomes a one-line note so it
  // won't repeat the call; any other becomes what its Check took from it (plus the
  // result's links and saved page path, so it can still open or grep them). The
  // full result stays in the task log and the chat's observations.
  trimJunk(input, r) {
    if (!lite() || settings.contextMode !== 'smart' || !Array.isArray(input) || !input.length) return 0;
    if (!this.conv || typeof this.conv.replaceResult !== 'function') return 0;
    const check = tasks.checkLine(r.thinking);
    if (!check) return 0;
    const junk = tasks.junkCheck(r.thinking);
    let saved = 0;
    for (const msg of input) {
      const part = Array.isArray(msg.content) && msg.content[0];
      if (!part || !part.response || part.response.error || part.response.left_out || part.response.kept) continue;
      const before = JSON.stringify(part.response);
      if (before.length < 300) continue;
      let response;
      if (junk) response = { left_out: `You judged this ${part.name} result not useful, so Squiggle removed it to save room. Don't make the same call again.` };
      else {
        const urls = [...new Set(before.match(/https?:\/\/[^\s"\\<>]+/g) || [])].slice(0, 6);
        response = {
          kept: check,
          ...(part.response.saved ? { saved: part.response.saved } : {}),
          ...(urls.length && !part.response.saved ? { links: urls } : {}),
          note: 'The full result was removed to save room; this is what you took from it.' + (part.response.saved ? ` The page is still in ${part.response.saved}.` : ''),
        };
      }
      if (this.conv.replaceResult(msg, response)) saved += estTokens(before) - estTokens(JSON.stringify(response));
    }
    return saved;
  }

  async respond(input, { show = true } = {}) {
    const base = this.thinking;
    const r = await engine.respond(this.conv, input, {
      signal: this.signal,
      onText: (t) => { if (show) this.ui.onText && this.ui.onText(this.prefix + t); },
      onThinking: (t) => this.ui.onThinking && this.ui.onThinking((base ? base + '\n\n' : '') + t),
    });
    if (r.thinking && r.thinking.trim()) this.thinking = (base ? base + '\n\n' : '') + r.thinking.trim();
    r.saved = this.trimJunk(input, r);
    return r;
  }

  // ── Before the model: references, recipes, context ──────────────────────
  async prepare(focus = '') {
    const { session, threadId, shown } = this;
    const line = sessions.lineMessages(session, threadId).filter(m => m.id !== this.userMsg.id);
    const extra = [];
    // Resolved references ("that", "the repo", bare links): a hint, never a rewrite.
    try {
      const recent = Object.values(session.tasks || {}).sort((a, b) => b.updated - a.updated).slice(0, 5);
      const toolCalls = recent.flatMap(t => (t.log || []).slice(-30).map(l => ({ name: l.name, args: l.args, ok: l.ok })));
      const ents = buildEntities({ messages: line.slice(-40).map(m => ({ role: m.role, content: m.content, ts: m.ts })), facts: memory.all(), toolCalls });
      const refs = renderRefs(resolveRefs(shown, ents, { messageCount: line.length }));
      if (refs) extra.push({ kind: 'refs', title: 'Resolved references (hints; the user\'s words win)', text: refs, label: 'Resolved references' });
    } catch (e) { console.warn('refs', e); }
    // Recipes aren't injected: the model looks them up with `find` when it wants one
    // (an injected recipe for an unrelated request took over small models' turns).
    return { line, extra, focus };
  }

  async context({ line, extra, focus }, budget) {
    const { session, threadId, shown } = this;
    return assembleContext({
      line, session, threadId, query: shown, budget, mode: settings.contextMode,
      system: systemPrompt(threadId, session), extra, focus,
      // Smart mode recalls a few earlier messages (this chat's and, with the setting
      // on, other chats') and, for small models, memory facts into a labelled block
      // after the request (recall.js); only on a real question and above a bar.
      others: settings.recallChats === false ? [] : sessions.list(),
      small: lite(),
      recall: (q, k) => memory.recall(q, k), factText: memory.factText,
      actions: !lite(),   // "Tool calls you made" read to small models as things the user said
      embed: settings.contextMode === 'smart' && settings.semantic ? embed : null,
    });
  }

  // ── Chat phase: answer directly, or make a plan ─────────────────────────
  async chat() {
    const tools = phaseTools(false);
    const known = preloaded(tools);
    const toolTokens = toolCost(tools, known);
    // History gets about half the window; the rest stays free for this turn's
    // tool results and the reply (a full window made turns fail at the start).
    // Small models get a quarter: on a 4K phone window half left too little room for a lookup.
    const share = lite() ? 0.25 : 0.5;
    const budget = Math.max(lite() ? 600 : 1000, Math.min(settings.contextSize - MAX_OUTPUT - toolTokens - 200, Math.floor(settings.contextSize * share) - toolTokens));
    const ctx = await this.context(await this.prepare(), budget);
    this.reply.context = ctx.report;
    // Plain chat: only the recent messages; extra sections would be read as instructions.
    if (plain()) ctx.system = '';
    this.conv = await engine.conversation({ system: ctx.system, messages: ctx.messages, tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT, known, filter: small() && native() });
    let used = estTokens(ctx.system) + estTokens(JSON.stringify(ctx.messages)) + toolTokens + estTokens(this.shown);
    const room = () => Math.max(0, (settings.contextSize - used - Math.min(MAX_OUTPUT, 700)) * 3);
    // Attachments: a note, then the start of each extract using up to half
    // the free room (the model reads the rest with read_file / grep).
    const att = attachmentPrompt(this.attachments, Math.floor(room() / 2));
    let pending = att.text ? `${this.shown}\n\n${att.text}` : this.shown;
    // Recalled earlier messages go after the request, clearly quoted (not for plain chat).
    if (ctx.recalled && !plain()) { pending += `\n\n${ctx.recalled}`; used += estTokens(ctx.recalled); }
    this.attNote = att.note || '';
    used += estTokens(att.text);
    const reserve = Math.min(MAX_OUTPUT, 700);
    if (managed()) pending += `\n\n${tasks.budgetLine(used, settings.contextSize, reserve)}`;
    let chatCalls = 0, full = false;
    for (;;) {
      const r = await this.respond(pending);
      if (r.text) this.prefix += r.text + (r.toolCalls.length ? '\n\n' : '');
      used += estTokens((r.text || '') + (r.thinking || '') + JSON.stringify(r.toolCalls || [])) - (r.saved || 0);
      if (!r.toolCalls.length || this.aborted) return null;
      // A plan switches to step mode (anything else in the same reply waits for its step).
      const planCall = r.toolCalls.find(c => c.function && c.function.name === 'plan');
      if (planCall) return this.startPlan(planCall.function.arguments);
      // A checkpoint in the chat phase turns the turn into a task, so its summary survives like a step result.
      const cp = managed() && r.toolCalls.find(c => c.function && c.function.name === 'checkpoint');
      if (cp) return this.checkpointTask(cp.function.arguments || {});
      if (full) { this.prefix += '\n\n_(Stopped: the context filled up. Ask again and I\'ll make a plan for what\'s left.)_'; return null; }
      const results = [];
      for (const call of r.toolCalls) {
        if (room() < 2500) {
          results.push(toolResult(call, { error: managed()
            ? 'Not run: your context is almost full. Call checkpoint (summary, needs, next) to carry on fresh, or answer now with what you have.'
            : 'Not run: your context is almost full. Call plan with the work that is left (you get a fresh context for each step), or answer now with what you have.' }));
          full = true;
          continue;
        }
        const out = await this.exec(call, { room: Math.floor(room() / r.toolCalls.length) });
        chatCalls++;
        if (out.ask) return null;  // `need` with nothing found: the question is the reply
        let response = out.response;
        if (chatCalls === CHAT_PLAN_NUDGE) response = { ...response, tip: 'This is taking several steps. If there is more to do, call plan so you can work through it one step at a time.' };
        used += estTokens(JSON.stringify(response)) + 10;
        response = { ...response, context_left: `about ${Math.max(0, Math.round((settings.contextSize - used) / 100) * 100)} of ${settings.contextSize} tokens` };
        if (managed() && settings.contextSize - used - reserve < tasks.LOW_ROOM) response = { ...response, low_room: tasks.lowRoomNote() };
        results.push(toolResult(call, response));
      }
      if (!await this.checkIn()) return null;
      pending = results;
    }
  }

  startPlan(args = {}) {
    const task = tasks.newTask({ msg: this.userMsg.id, thread: this.threadId, request: this.shown, goal: args.goal, steps: args.steps, recipe: this.recipe ? this.recipe.id : null });
    if (this.attNote) task.attachNote = this.attNote;
    if (this.recipe) { try { recipes.touch(this.recipe.id); } catch {} }
    this.task = task;
    sessions.saveTask(this.session, task);
    this.reply.tools.push({ name: 'plan', label: `planned ${task.steps.length} step${task.steps.length === 1 ? '' : 's'}: ${truncate(task.goal, 80)}`, ok: true });
    this.ui.onPlan && this.ui.onPlan(task);
    return task;
  }

  // checkpoint in the chat phase: a one-step task that carries on from the summary in a fresh context.
  checkpointTask(args = {}) {
    const next = String(args.next || '').trim() || 'Finish the request';
    const task = this.startPlan({ goal: truncate(this.shown, 200), steps: [next] });
    const step = task.steps[0];
    step.checkpoint = { summary: truncate(String(args.summary || ''), 2000), needs: tasks.normSteps([{ text: 'x', needs: args.needs }])[0].needs || [], next };
    this.checkpoints++;
    this.reply.tools.push({ name: 'checkpoint', label: `checkpointed: carrying on fresh (${truncate(next, 60)})`, ok: true });
    sessions.saveTask(this.session, task);
    return task;
  }

  // Text for an attachment ref (AI-managed context). Returns { ref, text, how } or null.
  async attachment(ref, task) {
    const r = tasks.parseRef(ref);
    if (!r) return null;
    if (r.kind === 'step') {
      const s = task.steps[r.n - 1];
      return s ? { ref, text: s.result ? `Step ${r.n} (${s.text}): ${s.result}` : `Step ${r.n} (${s.text}) has no result yet.` } : { ref, text: `There is no step ${r.n}.` };
    }
    if (r.kind === 'note') {
      const n = sessions.liveNotes(this.session).find(x => x.id === r.id);
      return { ref, text: n ? n.text : `No note ${r.id}.` };
    }
    if (r.kind === 'find') {
      const f = await this.find(r.query, task);
      return { ref, text: f.text, how: `find "${truncate(r.query, 40)}" again for more` };
    }
    const res = await runTool({ function: { name: 'read_file', arguments: { path: r.path, ...(r.start ? { start_line: r.start, end_line: r.end } : {}) } } }, { session: this.session, threadId: this.threadId, room: 24000 });
    const m = res.model || {};
    const body = m.error ? m.error : `(lines ${m.start_line}-${m.end_line} of ${m.total_lines})\n${String(m.content || '')}`;
    return { ref, text: m.error ? body : wrapUntrusted(`file ${r.path}`, String(body).replace(STRIP_UNTRUSTED, '')), how: `read_file ${r.path} with a line range for the rest` };
  }

  // ── Step mode ───────────────────────────────────────────────────────────
  async steps(task) {
    this.task = task;
    this.ui.onPlan && this.ui.onPlan(task);
    await this.close();
    while (!this.aborted) {
      const step = tasks.startStep(task);
      if (!step) break;
      sessions.saveTask(this.session, task);
      this.ui.onPlan && this.ui.onPlan(task);
      const outcome = await this.runStep(task, step);
      sessions.saveTask(this.session, task);
      this.ui.onPlan && this.ui.onPlan(task);
      if (outcome === 'ask' || outcome === 'stop') break;
    }
    // Stopped (Stop button or "Stop here"): runTurn marks the task stopped.
    if (this.aborted || this.paused || task.waiting) return;
    if (tasks.isFinished(task)) await this.final(task);
  }

  async stepSections(task, step) {
    const focus = `${task.goal}\n${step.text}`;
    // In priority order: when the prompt is too long, the last ones go first.
    const sections = [];
    if (task.attachNote) sections.push({ title: 'Files the user attached', text: task.attachNote });
    if (task.recipe) {
      const r = recipes.get(task.recipe);
      if (r) sections.push({ title: 'Recipe from a similar task', text: recipeText(r) });
    }
    try {
      const facts = (await memory.recall(`${this.shown}\n${focus}`, 8)).filter(r => r.score >= 0.25);
      if (facts.length) sections.push({ title: 'What you know about the user and their work', text: facts.map(f => '- ' + memory.factText(f.fact)).join('\n') });
    } catch {}
    if (managed()) {
      // The step's own choices replace the automatic retrieval: a checkpoint to carry on from, and attachments.
      if (step.checkpoint && step.checkpoint.summary) sections.unshift({ title: 'Your checkpoint (where you left off)', text: step.checkpoint.summary, keep: true });
      const refs = [...new Set([...(step.needs || []), ...((step.checkpoint && step.checkpoint.needs) || [])])];
      if (refs.length) {
        const got = (await Promise.all(refs.map(x => this.attachment(x, task).catch(e => ({ ref: x, text: `Couldn't attach: ${e.message || e}` }))))).filter(Boolean);
        const cap = Math.max(300, Math.floor(settings.contextSize * 0.45 * 0.6));
        const fitted = tasks.fitAttachments(got, cap);
        const big = got.filter(x => estTokens(x.text) > settings.contextSize / 3 && step.kind !== 'summarize');
        const total = fitted.reduce((n, x) => n + estTokens(x.text), 0);
        const body = fitted.map(x => `### ${x.ref} (${estTokens(x.text)} tokens${x.trimmed ? ', trimmed' : ''})\n${x.text}`).join('\n\n')
          + (big.length ? `\n\n(${big.map(x => x.ref).join(', ')} alone ${big.length > 1 ? 'are each' : 'is'} over a third of your room. Next time, make a summarize step for it and attach that step's result instead.)` : '');
        // Second in priority (after the attached-files note), so it is trimmed, never dropped.
        sections.splice(task.attachNote ? 1 : 0, 0, { title: `Attached for this step (${total} tokens)`, text: body, keep: true });
      }
      const prep = await this.prepare(focus);
      for (const x of prep.extra) if (x.kind === 'refs') sections.push({ title: x.title, text: x.text });
      return sections;
    }
    // Found earlier in this task: tool output from earlier steps that fits this one.
    const earlier = task.log.map((l, i) => ({ l, i }))
      .filter(({ l }) => l.step !== step.id && l.text && !tasks.HARNESS.has(l.name))
      .map(({ l, i }) => ({ id: 'l:' + i, source: 'tool output', text: `${l.label}\n${l.text}` }));
    if (earlier.length) {
      const r = await findAll(step.text, { taskItems: earlier }, { k: 2 });
      if (r.task.length) sections.push({ title: 'Found earlier in this task', text: wrapUntrusted('earlier tool output', r.task.map(t => t.text.replace(STRIP_UNTRUSTED, '')).join('\n\n')) });
    }
    const prep = await this.prepare(focus);
    for (const x of prep.extra) if (x.kind === 'refs') sections.push({ title: x.title, text: x.text });
    return sections;
  }

  async runStep(task, step) {
    const tools = phaseTools(true);
    const known = [...new Set([...preloaded(tools), ...(task.tools || [])])];
    const toolTokens = toolCost(tools, known);
    // The step prompt gets under half the window; the rest is for the step's
    // own tool calls and output (a phone has 4096 tokens in all).
    const maxTokens = Math.max(600, Math.floor(settings.contextSize * 0.45) - toolTokens);
    const sections = await this.stepSections(task, step);
    const prompt = tasks.stepPrompt(systemPrompt(this.threadId, this.session), task, sections, { maxTokens });
    const system = prompt.text;
    const n = tasks.stepIndex(task, step) + 1;
    this.reply.context = { mode: 'step', budget: settings.contextSize, used: estTokens(system),
      items: [{ kind: 'plan', label: `Step ${n}: ${truncate(step.text, 80)} (goal, plan and results)`, tokens: estTokens(tasks.stepSystem('', task)) },
        ...sections.filter(x => prompt.shown.includes(x.title)).map(x => ({ kind: 'section', label: x.title, tokens: estTokens(x.text) }))] };
    this.conv = await engine.conversation({ system, messages: [], tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT, known, filter: small() && native() });
    const reserve = Math.min(MAX_OUTPUT, 700);
    let pending = tasks.stepUser(task);
    let used = estTokens(system) + estTokens(pending) + toolTokens;
    if (managed()) { pending = tasks.stepUser(task, { budget: tasks.budgetLine(used + 30, settings.contextSize, reserve) }); used += 30; }
    const room = () => Math.max(0, (settings.contextSize - used - reserve) * 3);
    const label = `Step ${n}: ${step.text}`;
    let said = '', blank = 0, idle = 0, warnedFull = false;
    try {
      for (;;) {
        const r = await this.respond(pending, { show: false });
        used += estTokens((r.text || '') + (r.thinking || '') + JSON.stringify(r.toolCalls || []));
        const looped = LOOPED.test(r.text || '');
        const text = (r.text || '').replace(LOOPED, '').trim();
        if (text) { said = text; this.addThinking(`${label}\n${text}`); }
        if (this.aborted) return 'stop';
        if (!r.toolCalls.length) {
          // Answered without calling done: what it said is the step's result.
          if (text && !looped) { tasks.finishStep(task, text); return 'next'; }
          // Only thinking, nothing at all, or a loop: nudge it, then ask the person.
          if (++blank <= 2) {
            pending = looped ? 'You were repeating yourself. Say in one or two lines what you found, then call done, or call a tool.' : 'Finish your thought, then call a tool, or call done with what you found.';
            continue;
          }
          return this.ask(`I got stuck on step ${n} ("${truncate(step.text, 80)}"). How should I go on?`, task);
        }
        blank = 0;
        const results = [];
        let ended = null;
        for (const call of r.toolCalls) {
          const name = call.function && call.function.name;
          const args = (call.function && call.function.arguments) || {};
          if (name === 'done') {
            tasks.finishStep(task, args.result || said);
            this.toolEvent({ name: 'done', label: `done: ${truncate(step.text, 60)}`, ok: true });
            ended = 'next';
            break;
          }
          if (name === 'checkpoint' && managed()) {
            this.calls++;
            if (this.checkpoints >= tasks.MAX_CHECKPOINTS) {
              const go = await askCheckIn(task, this.ui, this.signal, this.calls);
              if (!go) { this.paused = true; this.prefix += `${this.prefix ? '\n\n' : ''}_(Paused after ${this.checkpoints} checkpoints. Say "continue" to pick up where it left off.)_`; return 'stop'; }
              this.checkpoints = 0;
            }
            this.checkpoints++;
            step.checkpoint = { summary: truncate(String(args.summary || said || ''), 2000), needs: tasks.normSteps([{ text: 'x', needs: args.needs }])[0].needs || [], next: String(args.next || '').trim() || step.text };
            tasks.logCall(task, step, { name: 'checkpoint', args: { next: step.checkpoint.next }, ok: true, label: 'checkpoint', text: step.checkpoint.summary });
            this.toolEvent({ name: 'checkpoint', label: `checkpointed step ${n}: carrying on fresh`, ok: true });
            ended = 'again';   // the same step, with a fresh context built from the checkpoint
            break;
          }
          if (name === 'plan') {
            this.calls++;
            const stale = tasks.samePlan(task, args.steps) || (task.revisions || 0) >= tasks.MAX_REVISIONS;
            if (stale) {
              // Re-planning instead of working: after a few of these, ask the person.
              if (++idle >= 3) return this.ask(`I got stuck on step ${n} ("${truncate(step.text, 80)}"). How should I go on?`, task);
              results.push(toolResult(call, tasks.samePlan(task, args.steps)
                ? { ok: true, note: `That is the current plan. Work on step ${n} now: ${step.text}` }
                : { error: `The plan has been revised ${task.revisions} times; it stands now. Work on step ${n}: ${step.text}, or call need if something is missing.` }));
              continue;
            }
            task.revisions = (task.revisions || 0) + 1;
            tasks.setPlan(task, args.goal, args.steps);
            this.toolEvent({ name: 'plan', label: `revised the plan (${task.steps.length} steps)`, ok: true });
            this.ui.onPlan && this.ui.onPlan(task);
            ended = 'next';  // the next step gets a fresh prompt with the new plan
            break;
          }
          if (step.calls >= tasks.STEP_HARD_CAP) {
            tasks.finishStep(task, `(step closed after ${step.calls} tool calls) ${said}`);
            ended = 'next';
            break;
          }
          if (room() < 2500) {
            // Out of room: warn once, then close the step with what it has.
            if (warnedFull) { tasks.finishStep(task, said || '(the step ran out of room before finishing)'); ended = 'next'; break; }
            warnedFull = true;
            results.push(toolResult(call, { error: managed()
              ? 'Not run: your context for this step is almost full. Call done with what you found, or checkpoint (summary, needs, next) to carry on fresh.'
              : 'Not run: your context for this step is almost full. Call done now with what you found (the next step starts fresh).' }));
            continue;
          }
          const out = await this.exec(call, { room: Math.floor(room() / r.toolCalls.length), task, step });
          if (out.ask) return 'ask';
          let response = out.response;
          if (step.calls === tasks.STEP_SOFT_CAP) response = { ...response, note: `This step has used ${step.calls} tool calls. Finish it now with done (what you have), or call need.` };
          used += estTokens(JSON.stringify(response)) + 10;
          if (managed()) response = { ...response, context_left: `about ${Math.max(0, Math.round((settings.contextSize - used) / 100) * 100)} of ${settings.contextSize} tokens`, ...(settings.contextSize - used - reserve < tasks.LOW_ROOM ? { low_room: tasks.lowRoomNote() } : {}) };
          results.push(toolResult(call, response));
        }
        if (!await this.checkIn()) return 'stop';
        if (ended) return ended;
        pending = results;
      }
    } finally {
      await this.close();
    }
  }

  // Ends the turn on a question; the person's next message is the answer.
  ask(question, task) {
    this.prefix += `${this.prefix && !/\n\n$/.test(this.prefix) ? '\n\n' : ''}${question}`;
    if (task) { tasks.blockStep(task, question); task.waiting = true; sessions.saveTask(this.session, task); this.ui.onPlan && this.ui.onPlan(task); }
    this.ui.onText && this.ui.onText(this.prefix);
    return 'ask';
  }

  // Every CHECK_IN_EVERY tool calls the person is asked whether to keep going.
  async checkIn() {
    if (this.aborted) return false;
    if (this.calls < this.nextCheckIn) return true;
    while (this.nextCheckIn <= this.calls) this.nextCheckIn += tasks.CHECK_IN_EVERY;
    const go = await askCheckIn(this.task, this.ui, this.signal, this.calls);
    if (!go) {
      this.paused = true;
      this.prefix += `${this.prefix ? '\n\n' : ''}_(Paused after ${this.calls} tool calls.${this.task ? ' Say "continue" to pick up where it left off.' : ''})_`;
    }
    return go;
  }

  // ── Final reply from the step results ───────────────────────────────────
  async final(task) {
    task.status = 'done';
    tasks.touch(task);
    sessions.saveTask(this.session, task);
    this.finishedNow = true;
    this.ui.onPlan && this.ui.onPlan(task);
    const maxTokens = Math.max(600, settings.contextSize - Math.min(MAX_OUTPUT, 1024) - 300);
    this.conv = await engine.conversation({ system: tasks.finalSystem(systemPrompt(this.threadId, this.session), task, { maxTokens }), messages: [], tools: [], maxOutputTokens: MAX_OUTPUT });
    if (this.prefix && !/\n\n$/.test(this.prefix)) this.prefix += '\n\n';
    const r = await this.respond(tasks.finalUser(task));
    this.prefix += r.text || '';
    await this.close();
  }

  // Every call is kept on the reply with its arguments (long values trimmed) and,
  // when it failed, the error the model got, so failures can be studied later.
  toolEvent(t) {
    const rec = { name: t.name, label: t.label, ok: t.ok };
    if (t.args && typeof t.args === 'object' && Object.keys(t.args).length) rec.args = tasks.trimArgs(t.args);
    if (t.ok === false && t.error) rec.error = truncate(String(t.error), 600);
    this.reply.tools.push(rec);
    this.ui.onTool && this.ui.onTool({ ...t, running: false });
  }

  // Runs one tool call (harness tools here, agent tools in tools.js).
  // Returns { response } or { ask: true } when the turn ends on a question.
  async exec(call, { room, task = null, step = null }) {
    const name = call.function && call.function.name;
    const args = (call.function && call.function.arguments) || {};
    this.calls++;
    this.ui.onTool && this.ui.onTool({ name, running: true });
    if (name === 'find' || name === 'need') {
      const query = String(args.query || args.what || args.q || '').trim();
      const { text, tools, empty, answers } = await this.find(query, task);
      if (task && tools.length) task.tools = [...new Set([...(task.tools || []), ...tools])];
      if (task) tasks.logCall(task, step, { name, args, ok: true, label: `${name} "${truncate(query, 60)}"`, text });
      if (name === 'need' && !answers) {
        // Nothing outside this task answers it: ask the person. Their reply comes back as the answer.
        this.toolEvent({ name, label: `asked you: ${truncate(query, 60)}`, ok: true });
        const q = query || 'What should I do next?';
        this.ask(/\?\s*$/.test(q) ? q : `I need to know: ${q}`, task);
        return { ask: true };
      }
      this.toolEvent({ name, label: `${name === 'need' ? 'looked for what was missing' : 'searched'}: "${truncate(query, 60)}"${empty ? ' (nothing)' : ''}`, ok: true });
      return { response: { found: text, ...(tools.length ? { tools } : {}) } };
    }
    if (name === 'done') return { response: { error: 'There is no step to finish yet. Call plan first, or just answer.' } };
    const res = await runTool(call, { session: this.session, threadId: this.threadId, room, pageCards: lite() && !plain(), approve: (req) => askApproval(req, this.ui, this.signal) });
    this.toolEvent({ name: res.name, label: res.label, ok: res.ok, args: res.args, error: res.model && res.model.error });
    if (res.observation) sessions.addObservation(this.session, { ...res.observation, thread: this.threadId });
    let response = res.model && typeof res.model === 'object' ? res.model : { value: res.model };
    const json = JSON.stringify(response);
    if (json.length > room) response = { truncated: 'Result cut to fit your context; ask for less (e.g. grep, or a line range).', partial: json.slice(0, Math.max(0, room - 200)) };
    if (task) tasks.logCall(task, step, { name: res.name, args: res.args, ok: res.ok, label: res.label, text: json.replace(STRIP_UNTRUSTED, '') });
    if (task) sessions.saveTask(this.session, task);
    return { response };
  }

  // `find`: tools, recipes, memory, past chats and this task, in one search.
  async find(query, task) {
    const r = await findAll(query, {
      tools: toolSpecs(settings.tools),
      recipes,
      recall: (q, k) => memory.recall(q, k),
      // Small models read past-chat snippets as part of this conversation ("the past chats
      // mention 'search the web'"), so they get them only when the query asks about one.
      searchHistory: lite() && !PAST_CHAT.test(String(query).toLowerCase()) ? null : async (q, k) => searchChats(q, k, this.userMsg.id),
      taskItems: tasks.taskItems(task),
    }, { k: 3 });
    // A recipe the model looked up goes with the plan it makes this turn.
    if (!this.recipe && r.recipes.length && !task) this.recipe = r.recipes[0].recipe;
    const outside = r.task.filter(t => t.source === 'tool output');
    const inside = { ...r, task: r.task.filter(t => t.source !== 'tool output') };
    const empty = !['tools', 'recipes', 'facts', 'chats', 'task'].some(k => r[k] && r[k].length);
    // Does anything answer a `need`? Memory, a recipe, or another chat that
    // shares at least two words with the question. Tools, this task's own
    // results and this chat don't: the model already had those.
    const words = new Set(tokenize(query)).size;
    const answers = r.facts.length > 0 || r.recipes.length > 0
      || r.chats.some(c => c.session !== this.session.id && (c.hits || 0) >= Math.min(2, words));
    let text = renderFind(inside);
    if (outside.length) {
      const block = wrapUntrusted('earlier tool output', outside.map(t => t.text.replace(STRIP_UNTRUSTED, '')).join('\n\n'));
      text = (text === renderFind({}) ? '' : text + '\n\n') + 'Earlier tool output in this task:\n' + block;
    }
    return { text, tools: r.tools.map(t => t.name), empty, answers };
  }
}

const LOOPED = /\n*_\(stopped: the model was repeating itself\)_/;
const toolResult = (call, response) => ({ role: 'tool', content: [{ name: (call.function && call.function.name) || 'unknown', response }] });

// Past chats for `find`: every session's messages, ranked by BM25.
function searchChats(query, k, skip = null) {
  const docs = [];
  for (const s of sessions.list()) for (const m of s.messages) if (m.content && m.id !== skip && (m.role === 'user' || m.role === 'assistant')) docs.push({ id: `${s.id}|${m.id}`, text: m.content, s, m });
  if (!docs.length) return [];
  const scores = bm25(docs)(query);
  return docs.filter(d => scores.has(d.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id)).slice(0, k)
    .map(d => ({ session: d.s.id, title: d.s.title, text: d.m.content, ts: d.m.ts, score: scores.get(d.id) }));
}

// "Keep going?" every CHECK_IN_EVERY tool calls. No UI means stop.
function askCheckIn(task, ui, signal, calls) {
  if (!ui.onCheckIn || (signal && signal.aborted)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (d) => { if (!done) { done = true; resolve(Boolean(d)); } };
    if (signal) signal.addEventListener('abort', () => finish(false), { once: true });
    ui.onCheckIn({ task, calls }, finish);
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

function afterTurn(session, threadId, finishedTask = null) {
  // Small delay so the person can type again before the GPU gets busy.
  setTimeout(async () => {
    if (finishedTask) await engine.background(() => learnRecipe(session, finishedTask)).catch(e => console.warn('recipe', e));
    else await engine.background(() => refineDrafts()).catch(e => console.warn('recipe', e));
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
  if (lite()) return;   // small models write junk titles ("Answer: \"Yo\"..."); the first message is the title
  engine.background(async () => {
    const t = await engine.complete('You write short titles.', `Write a 2-6 word title for a conversation that starts with:\n\n${truncate(first.content, 800)}\n\nReply with only the title.`, { maxOutputTokens: 24 });
    const clean = t.replace(/^["'#*\s]+|["'.*\s]+$/g, '').slice(0, 60);
    if (clean) { session.title = clean; sessions.touch(session); }
  }).catch(() => {});
}

// Fold messages that left the recent window into the line's summary.
async function rollingSummary(session, threadId) {
  if (lite()) return;   // small models aren't trained for this
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
  if (lite()) return;   // small models aren't trained for this
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
  if (lite()) return;   // small models aren't trained for this
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

// Save how a finished task was solved, so the next similar request is fast
// (docs/harness.md, "Recipes"). Built from the task deterministically; a big
// model then generalises the wording. The small model can't do that well, so
// its recipes are saved as drafts and refined by the next big-model session.
export async function learnRecipe(session, task) {
  if (!task || task.status !== 'done') return null;
  const draft = recipes.fromTask(task, task.log, { request: task.request, sessionId: session.id });
  if (!draft.steps.length) return null;
  const recipe = lite() ? { ...draft, draft: true } : await refineRecipe(draft, task.request);
  const saved = recipes.save(recipe);
  if (saved && !task.recipe) { task.recipe = saved.id; tasks.touch(task); sessions.saveTask(session, task); }
  return saved;
}

async function refineRecipe(draft, request) {
  const out = await engine.complete(
    'You turn a finished task into a reusable recipe. Reply with one JSON object only.',
    `Request: ${truncate(request || draft.when, 600)}\n\nDraft recipe:\n${JSON.stringify({ title: draft.title, when: draft.when, steps: draft.steps, specifics: draft.specifics })}\n\n` +
    'Rewrite it so it fits similar requests: {"title": short imperative title, "when": what requests it fits, with example phrasings, "steps": the steps that worked, generalised}. Keep <placeholders> as they are. Reply with only the JSON.',
    { maxOutputTokens: 500 }).catch(() => null);
  try {
    const j = out && JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    if (j && typeof j.title === 'string' && Array.isArray(j.steps) && j.steps.length) {
      return { ...draft, title: j.title.slice(0, 120), when: String(j.when || draft.when).slice(0, 400), steps: j.steps.map(String).slice(0, 10), draft: false };
    }
  } catch { /* keep the draft */ }
  return { ...draft, draft: false };
}

// A big model refines one draft recipe (from the small model) per turn.
async function refineDrafts() {
  if (lite()) return;
  const d = recipes.list().find(r => r.draft);
  if (!d) return;
  const better = await refineRecipe(d, (d.examples || [])[0]);
  recipes.update(d.id, { title: better.title, when: better.when, steps: better.steps, draft: false });
}
