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
import { find as findAll, renderFind, PAST_CHAT, PUSHBACK, checkQuery, rerankWeb, urlLedger, rankTools } from './find.js';
import * as prefetchLib from './prefetch.js';
import { buildEntities, resolve as resolveRefs, renderRefs } from './refs.js';
import { assembleContext, summaryBacklog, messageText, scrubFakeToolNotes, chunk } from './context.js';
export { scrubFakeToolNotes };
import { toolSpecs, listTools, runTool } from './tools.js';
import { UNTRUSTED_RULES, wrapUntrusted } from './untrusted.js';
import { embed, embedReady } from './embed.js';
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
  semantic: true,           // MiniLM embeddings for retrieval (its worker sleeps when idle, so phones too)
  recallChats: false,       // smart mode may recall messages from other chats too (off: old answers, right or wrong, leaked into unrelated chats)
  learn: true,              // extract memory facts after turns
  tools: null,              // Set of enabled tool names, or null for all
  debugTools: false,        // save each tool's full result on the reply (Settings → Debug), synced with the chat
  smallMode: {},            // model id → true/false: small-model mode for a model that can switch (smallModeSwitchable); unset = the model's default (smallMode)
  noPrompt: {},             // model id → true: no system prompt from Squiggle, just the tools in the model's own format (experimental)
};

const MAX_OUTPUT = 1536;
const CHAT_PLAN_NUDGE = 6;  // tool calls without a plan before the model is reminded it can make one
const LITE_CHAT_NUDGE = 3;  // small models: nudged to answer after this many, no more lookups after twice this

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

// The same prompt for models that call tools in their own native format (Gemma 4, Qwen, the cloud model):
// the first three lines are LITE_SYSTEM's, the fenced-block line is left out (their template declares the
// tools). It used to say "start with plan, done, need and find", which small models obeyed literally: a 0.6B
// told "use web_search" argued with the prompt until its output ran out, and a 0.8B called need for arithmetic
// and for things the user had just said (measured 2026-11-04, docs/measurements-2026-11-04.md). Now each
// harness tool says what it is for, and gated models get the names of what is ready and what needs tool_info
// first (toolNamesLine), so nothing usable is left unnamed.
export const LITE_SYSTEM_NATIVE = [
  ...LITE_SYSTEM.split('\n').slice(0, 3),
  'Look things up with web_search and fetch_url. find(query) searches your other tools, recipes, memory and',
  'past chats when you need one of them; need(what) asks the user for something only they know.',
  'Plan only when the request takes more than one step: plan(goal, steps), then done(result) after each step.',
].join('\n');

// Which prompt dialect this model gets (tasks.js DIALECT): the frozen fenced one for Squiggle Small, v3
// (harness text in a user turn marked as Squiggle's) for everyone else.
export const dialect = () => (fencedSmall() ? tasks.DIALECT.v2 : tasks.DIALECT.v3);

const lite = () => engine.isLite(settings.model);
// A small (wllama) model that speaks Gemma 4's own tool format (engine nativeTools): it gets the full prompt
// and every tool, like E2B, and is otherwise treated as small (context budgets, no background jobs).
const native = () => Boolean(engine.nativeTools && engine.nativeTools(settings.model));
// Small-model mode: the short find-first prompt above instead of the full one. Always on for small models in
// the fenced tool format (Squiggle Small: it's their training text and the only format their engine parses);
// a switch (Settings → Small-model mode, per model) for every other model with tools. Context budgets and
// background jobs still follow the runtime (lite), not this.
const fencedSmall = () => lite() && !native();
// Small native models (Qwen3.5 0.8B, tiny Gemma 4) get tools by name: GATE's tools are declared with full schemas,
// every other tool is a bare name in the system prompt, declared once tool_info (or find) turns it up. Every
// schema up front filled most of a phone's 4K window (docs/harness.md, "Tool names up front").
const gated = () => lite() && native();
const nativeId = (id) => Boolean(engine.nativeTools && engine.nativeTools(id));
const chatOnlyId = (id) => Boolean(engine.chatOnly && engine.chatOnly(id));
const fencedId = (id) => engine.isLite(id) && !nativeId(id) && !chatOnlyId(id);
export const smallModeSwitchable = (id = settings.model) => Boolean(engine.MODELS[id]) && !chatOnlyId(id) && !fencedId(id);
// The switch's default: on for every small model, off for big ones. A saved true/false for the model wins.
// (The full prompt plus every schema took half of a phone's 4K window and a 0.8B model answered the
// instructions instead of the person; measured 2026-11-04 with Qwen3.5 0.8B: 430 more tokens, about 40 s of
// prefill on a phone-class CPU, and no better.)
export const smallModeDefault = (id = settings.model) => engine.isLite(id);
// No prompt (experimental, per model): Squiggle sends no system prompt of its own (no persona, rules, tool-names
// line, date) in any phase; the model gets its tools in its own format and the conversation. For seeing how a
// model behaves on its own training (LFM2.5 1.2B over-used tools under the short prompt, 2026-11-09). Same
// models as the Small-model mode switch.
export const noPrompt = (id = settings.model) => smallModeSwitchable(id) && Boolean(settings.noPrompt && settings.noPrompt[id]);
export const smallMode = (id = settings.model) => fencedId(id)
  || (smallModeSwitchable(id) && (settings.smallMode && typeof settings.smallMode[id] === 'boolean' ? settings.smallMode[id] : smallModeDefault(id)));
// AI-managed context (Settings → Context: AI-managed): the model sees what everything costs, steps say what
// they need attached, and it can checkpoint to a fresh context (docs/harness.md, "the model manages its own
// context"). Off in plain chat. Compress and Smart are unchanged.
const managed = () => settings.contextMode === 'managed' && !plain();
// Fresh context (Settings → Context: Fresh): nothing replayed; the agent looks things up first and hands the
// model the result as a find call it already made (prefetch.js, docs/harness.md "Fresh context").
const fresh = () => settings.contextMode === 'fresh' && !plain();
const UPFRONT = 'You work over several turns and steps. Each one shows you only what it needs; anything earlier can be fetched with find or attached to a step (a plan step\'s needs). Don\'t try to fit everything into one turn. The last line of each prompt says how much room is left; when you\'re running low, call checkpoint and carry on fresh.';
const UPFRONT_SMALL = 'Each step shows only what it needs: attach earlier results to a plan step (needs), or find them.\nThe last line says how much room is left; when it runs low, call checkpoint.';


// Plain chat for small models without tool training (engine.chatOnly).
const plain = () => Boolean(engine.chatOnly && engine.chatOnly(settings.model));

// Gated models: what is declared and ready, then the tools they can ask tool_info about, by name only and
// grouped by area (tools/registry.js `group`), so the model can tell what each is for without a schema. Phase
// 'final' has no tools. Generated from the same sets the engine declares (phaseTools, GATE, known), so the
// prompt never leaves a usable tool unnamed: web_search was declared but never mentioned, and a model went
// looking for it through tool_info instead of calling it.
function toolNamesLine(phase, known = []) {
  if (!gated() || phase === 'final') return '';
  const all = phaseTools(phase === 'step').map(t => t.name);
  const ready = all.filter(n => GATE.includes(n) || known.includes(n));
  const byName = new Map(listTools().map(t => [t.spec.name, t.group || 'other']));
  const groups = new Map();
  for (const n of all.filter(n => !ready.includes(n))) { const g = byName.get(n) || 'other'; groups.set(g, [...(groups.get(g) || []), n]); }
  return [`Tools ready to call: ${ready.join(', ')}.`,
    groups.size ? `Other tools, by area: ${[...groups].map(([g, names]) => `${g}: ${names.join(', ')}`).join('; ')}. To use one, first call tool_info(names) with every one you expect to need.` : ''].filter(Boolean).join('\n');
}

function systemPrompt(threadId, session, phase = 'chat', known = []) {
  if (plain() || noPrompt()) return '';
  const names = toolNamesLine(phase, known);
  if (smallMode()) return `${fencedSmall() ? LITE_SYSTEM : LITE_SYSTEM_NATIVE}${names ? '\n' + names : ''}${managed() ? '\n' + UPFRONT_SMALL : ''}\nToday is ${new Date().toDateString()}.`;
  const thread = threadId && session.threads[threadId];
  // Kept short on purpose: with every tool schema this prompt was 99% of a 4K window (2026-11-04), and
  // a phone CPU reads it at ~13 tokens/s before the first reply token.
  return [
    `You are Squiggle, a personal AI agent running privately on the user's own device. Today is ${new Date().toDateString()}.`,
    `Workspace: /home is your own folder (synced to the user's devices); /repos/<name> holds clones of their GitHub repos. For code: git_clone, git_branch (an agent/ branch; those push freely, any other branch asks the user first, and a refused push is final), edit, git_commit, git_push, then github_open_pr if they want a review.`,
    `Don't guess. For current information or anything you're unsure of: web_search, then fetch_url the best results, and say which sites you used. Maths goes through calculate. find(query) searches your tools, recipes from past tasks, memory and past chats; need(what) asks the user for something only they know. For anything that takes more than one step, call plan(goal, steps) first and work it one step at a time: each step gets a fresh view of the goal, the plan and earlier results, and ends with done(result).`,
    `Save lasting facts about the user or their projects (preferences, decisions, names) with remember; search_history finds past conversations. Your context window is ${settings.contextSize} tokens and every tool result says how much is left: prefer grep and read_file line ranges, and keep notes with note on longer work without a plan.`,
    managed() ? UPFRONT : '',
    names,
    `Use tools when they help; answer directly when they don't. Be concise. Never invent file contents or tool results, and never say you saved, remembered, changed or pushed something unless you called the tool for it in this reply.`,
    thread ? `This is a side thread started on an earlier message ("${truncate(thread.title, 80)}"). Focus on that topic.` : '',
    UNTRUSTED_RULES(),
  ].filter(Boolean).join('\n\n');
}

// Tools for a phase: the enabled agent tools plus the harness's own.
// Tools a small model starts with already "looked up", so it doesn't spend a model
// call on find first: nearly every phone request needs the web. Only ones enabled.
const PRELOADED = ['web_search', 'fetch_url'];
// Tools for looking things up: a strong match for one of these doesn't stop find or Fresh from searching.
const LOOKUP_TOOLS = ['web_search', 'fetch_url', 'wiki_lookup'];
function preloaded(tools) {
  if (!lite() || plain() || native()) return [];
  const names = new Set(tools.map(t => t.name));
  return PRELOADED.filter(n => names.has(n));
}

// Declared with full schemas from the start on gated models (see gated); everything else waits for tool_info.
// remember and calculate are in: a 0.8B model told "save it with remember" called need instead of looking
// remember up first (2026-11-04), and nearly every phone chat wants one of the two.
// wiki_lookup is in too: names, dates and filmographies are most of what phone questions ask (2026-11-04).
const GATE = ['plan', 'done', 'need', 'find', 'checkpoint', 'tool_info', ...PRELOADED, 'wiki_lookup', 'remember', 'calculate'];

// The tools this model may have: every enabled one, minus the ones only big models can use (wikidata_query: a
// 0.6B model's SPARQL didn't run or asked about the wrong item; docs/measurements-2026-11-04.md).
const BIG_ONLY = ['wikidata_query'];
const modelTools = () => toolSpecs(settings.tools).filter(t => !(lite() && BIG_ONLY.includes(t.name)));

function phaseTools(step) {
  if (plain()) return [];
  const base = modelTools().filter(t => !(step && t.name === 'note'));
  const h = tasks.HARNESS_SPECS;
  const info = gated() ? [tasks.TOOL_INFO_SPEC] : [];
  if (managed()) return [...base, tasks.MANAGED_SPECS.plan, ...(step ? [h.done] : []), h.need, h.find, ...info, tasks.MANAGED_SPECS.checkpoint];
  return [...base, h.plan, ...(step ? [h.done] : []), h.need, h.find, ...info];
}

// Tokens the tool definitions take: fenced small models see only names and looked-up one-liners (~300);
// gated models the GATE tools plus `known`; everyone else every schema.
function toolCost(tools, known = []) {
  if (plain()) return 0;
  if (lite() && !native()) return 300;
  if (gated()) {
    const ready = tools.filter(t => GATE.includes(t.name) || known.includes(t.name));
    // Formats that list the rest by name too (engine info toolNames: LFM2 on WebLLM) pay for {"name": …} each.
    const info = engine.smallInfo && engine.smallInfo();
    const named = info && info.toolNames ? tools.filter(t => !ready.includes(t)).map(t => ({ name: t.name })) : [];
    return estTokens(JSON.stringify(ready)) + (named.length ? estTokens(JSON.stringify(named)) : 0);
  }
  return estTokens(JSON.stringify(tools));
}

// When the instructions and tool definitions alone leave no room for a reply, say that plainly instead of
// failing later with the generic "conversation got too long" (which compressing history can't fix).
function checkOverhead(system, toolTokens) {
  const sys = estTokens(system);
  if (sys + toolTokens + Math.min(MAX_OUTPUT, 700) <= settings.contextSize) return;
  const fixes = ['raise the context window in Settings', ...(smallModeSwitchable() && !smallMode() ? ['turn on Small-model mode for this model'] : []), 'turn off some tools'];
  const e = new Error(`The instructions (about ${sys} tokens) and tool definitions (about ${toolTokens}) leave no room for a reply in this model's ${settings.contextSize}-token window, so shortening the conversation won't help. To fix it, ${fixes.join(', or ')}.`);
  e.overhead = true;
  throw e;
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
      const msg = e && e.overhead ? e.message : /too many tokens|context|kv.?cache|exceed/i.test(String(e && e.message || e))
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
    // Which model wrote it (and how it ran), so a saved chat can be read against the right model.
    reply.model = replyModel();
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

// The model behind a reply, saved on the message: its id, label and how it ran (on this device, on the GPU or
// CPU, or on the relay). Labels are kept because MODELS entries come and go.
function replyModel() {
  const id = settings.model;
  const m = engine.MODELS[id] || {};
  const info = engine.smallInfo && engine.smallInfo();
  const how = m.runtime === 'cloud' ? 'relay' : m.runtime === 'litert' ? 'webgpu' : info ? (info.webllm ? 'webllm' : info.gpu ? 'wllama-gpu' : `wllama-cpu${info.threads > 1 ? `-${info.threads}` : ''}`) : m.runtime || '';
  return { id, label: m.label || id, how, ...(smallModeSwitchable(id) ? { smallMode: smallMode(id) } : {}), ...(noPrompt(id) ? { noPrompt: true } : {}), contextSize: settings.contextSize, contextMode: settings.contextMode };
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
    this.urls = null;        // URLs the model was given (urlLedger), for small models' fetch_url
  }

  // Small models only open URLs they were given: by the user, a search result or a page they read
  // (they made up bugonia.com/confirmation and example.com/movies/…). Seeded from this chat's
  // user messages and saved tool output, then grown by each search and page this turn.
  allowUrl(url) {
    if (!this.urls) {
      this.urls = urlLedger();
      for (const m of this.session.messages || []) if (m.role === 'user' && !m.deleted) this.urls.add(m.content);
      for (const o of this.session.observations || []) this.urls.add(o.text);
      this.urls.add(this.shown);
    }
    return this.urls.allows(url);
  }
  noteUrls(res) {
    if (!this.urls) return;
    for (const x of (res && res.items) || []) this.urls.add(x.url);
    if (res && res.observation) this.urls.add(res.observation.text);
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
      others: settings.recallChats === true ? sessions.list() : [],
      small: lite(),
      // No prompt means nothing from Squiggle in the system turn, memory notes included.
      recall: noPrompt() ? null : (q, k) => memory.recall(q, k), factText: memory.factText, factsTitle: dialect().memoryTitle,
      actions: !lite(),   // "Tool calls you made" read to small models as things the user said
      embed: settings.contextMode === 'smart' && settings.semantic ? embed : null,
    });
  }

  // ── Chat phase: answer directly, or make a plan ─────────────────────────
  async chat() {
    const tools = phaseTools(false);
    const toolTokens = toolCost(tools);
    checkOverhead(systemPrompt(this.threadId, this.session), toolTokens);
    this.declaredNames = new Set(tools.map(t => t.name).filter(n => !gated() || GATE.includes(n)));
    // History gets about half the window; the rest stays free for this turn's
    // tool results and the reply (a full window made turns fail at the start).
    // Small models get less: on a 4K phone window half left too little room for a lookup. (A quarter was
    // too little the other way: with ~650 tokens of tool schemas the history got ~300 tokens, so the replayed
    // window changed every turn and llama.cpp re-read the whole prompt each time; measured 2026-11-04.)
    const share = lite() ? 0.4 : 0.5;
    const budget = Math.max(lite() ? 800 : 1000, Math.min(settings.contextSize - MAX_OUTPUT - toolTokens - 200, Math.floor(settings.contextSize * share) - toolTokens));
    const prep = await this.prepare();
    const ctx = await this.context(prep, budget);
    this.reply.context = ctx.report;
    // Plain chat: only the recent messages; extra sections would be read as instructions.
    if (plain()) ctx.system = '';
    // Fresh: the lookup goes in as a find call the model already made, where the engine can take one; else it's
    // a labelled system section.
    let seed = null;
    if (fresh()) {
      const pf = await this.prefetch(prep.line);
      if (pf) {
        for (const it of pf.items) ctx.report.items.push({ ...it, placed: 'lookup before the model' });
        if (engine.seedsToolHistory && engine.seedsToolHistory()) seed = pf;
        else ctx.system += `\n\n## Looked up before this message (search results, not the user's words)\n${pf.text}`;
      }
    }
    let used = estTokens(ctx.system) + estTokens(JSON.stringify(ctx.messages)) + toolTokens + estTokens(this.shown) + (seed ? estTokens(seed.text) : 0);
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
    if (managed()) pending += `\n\n${tasks.budgetLine(used, settings.contextSize, reserve, dialect())}`;
    this.setWindow(windowOf(ctx.report, { system: plain() ? 0 : estTokens(ctx.system), tools: toolTokens, message: estTokens(this.shown) + estTokens(att.text) }), used);
    let chatCalls = 0, full = false, askedForAnswer = false;
    this.seenCalls = new Map();
    let messages = ctx.messages;
    if (seed) {
      // The question is the only user turn; the lookup is the model's own find call and its result.
      const call = { id: 'lookup1', type: 'function', function: { name: 'find', arguments: { query: seed.query } } };
      messages = [{ role: 'user', content: pending }, { role: 'model', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: 'find', arguments: JSON.stringify({ query: seed.query }) } }] }];
      pending = [toolResult(call, { found: seed.text })];
      this.seenCalls.set(`find:${JSON.stringify({ query: seed.query })}`, 1);
    }
    if (fresh()) {
      for (const q of (this.prefetched || [])) this.seenCalls.set(`web_search:${JSON.stringify({ query: q })}`, 1);
      for (const k of (this.prefetchedCalls || [])) this.seenCalls.set(k, 1);
    }
    if (seed) chatCalls = 1;   // the lookup counts as a call (an empty reply after it gets the nudge)
    this.conv = await engine.conversation({ system: ctx.system, messages, tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT, known: preloaded(tools), gate: gated() ? GATE : null });
    // "No, it's X" / "can you confirm that?": small models just agree. Search first and hand them the results.
    // (Fresh does this in its lookup.)
    const checked = fresh() ? '' : await this.checkClaim();
    if (checked) { pending += `\n\n${dialect().note(checked)}`; used += estTokens(checked); this.grow(used); }
    const maxChatCalls = lite() ? 2 * LITE_CHAT_NUDGE : Infinity;
    for (;;) {
      const r = await this.respond(pending);
      if (r.text) this.prefix += r.text + (r.toolCalls.length ? '\n\n' : '');
      used += estTokens((r.text || '') + (r.thinking || '') + JSON.stringify(r.toolCalls || [])) - (r.saved || 0);
      this.grow(used);
      if (this.aborted) return null;
      if (!r.toolCalls.length) {
        // Looked things up, then said nothing (Qwen3 0.6B, 2026-11-04): ask once for the answer. An empty
        // reply also made the next turn redo the question, since it looked unanswered.
        if (!this.prefix.trim() && chatCalls && !askedForAnswer) {
          askedForAnswer = true;
          pending = dialect().note('You didn\'t write a reply. Answer the user now from the results above, in plain words.');
          continue;
        }
        if (!this.prefix.trim() && chatCalls) this.prefix = 'I looked this up but couldn\'t put an answer together. Try asking again, or ask me to make a plan for it.';
        return null;
      }
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
        const again = this.repeated(call);
        if (again) { results.push(toolResult(call, again)); continue; }
        if (chatCalls >= maxChatCalls) {
          // A small model that keeps looking things up never answers; bound the turn.
          results.push(toolResult(call, { error: `Not run: you have made ${chatCalls} tool calls this turn. Answer now with what you have, or call plan if there is more to do.` }));
          continue;
        }
        const out = await this.exec(call, { room: Math.floor(room() / r.toolCalls.length) });
        chatCalls++;
        if (out.ask) return null;  // `need` with nothing found: the question is the reply
        let response = out.response;
        if (chatCalls === (lite() ? LITE_CHAT_NUDGE : CHAT_PLAN_NUDGE)) response = { ...response, tip: lite() ? `You have made ${chatCalls} tool calls. If the answer is in the results above, answer now; if there is more to do, call plan.` : 'This is taking several steps. If there is more to do, call plan so you can work through it one step at a time.' };
        used += this.declare(tools, call, response);
        used += estTokens(JSON.stringify(response)) + 10;
        this.grow(used);
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
    // Gated models: tools looked up before planning stay declared in the steps.
    if (gated() && this.declaredNames) { const extra = [...this.declaredNames].filter(n => !GATE.includes(n)); if (extra.length) task.tools = extra; }
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
      // The bar is absolute (memory.js rankFacts): about one shared rare word between a short fact and the request.
      const facts = (await memory.recall(`${this.shown}\n${focus}`, 8)).filter(r => r.score >= 0.2);
      if (facts.length) sections.push({ title: dialect().memoryTitle, text: facts.map(f => '- ' + memory.factText(f.fact)).join('\n') });
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

  // The context window for the sidebar: what the prompt is made of (fixed when the
  // call starts) plus "this turn" (thinking, tool calls and results, the reply so far).
  setWindow(w, used) {
    if (!this.reply.context) return;
    this.reply.context.window = w;
    this.windowBase = used - windowTotal(w);
    this.grow(used);
  }

  // Gated models: a call to an undeclared tool, or a find/tool_info result naming tools, declares them from the
  // next request on (NativeConversation does the same). Returns their schema tokens, which also go on the
  // window's tool definitions.
  // The same tool with the same arguments twice in one phase: small models do this instead of reading the
  // result they already have (Qwen3.5 ran web_search five times for one question). Not run again.
  // The same call in an earlier step of this task (a 0.6B model fetched the same made-up URL in two
  // steps): not run again; the earlier result comes back instead, since a new step doesn't show it.
  ranInTask(task, step, call) {
    const fn = (call && call.function) || {};
    if (!task || ['plan', 'done', 'checkpoint', 'need', 'tool_info'].includes(fn.name)) return null;
    const args = JSON.stringify(fn.arguments || {});
    const prev = [...(task.log || [])].reverse().find(l => l.step !== (step && step.id) && l.name === fn.name && JSON.stringify(l.args || {}) === args);
    if (!prev) return null;
    this.toolEvent({ name: fn.name, label: `${fn.name} already ran in an earlier step (not run again)`, ok: false });
    return { error: `You already called ${fn.name} with exactly these arguments in an earlier step${prev.ok === false ? ', and it failed' : ''}. Its result: ${prev.text || prev.label}. Use that, change the arguments, or call done.` };
  }

  repeated(call) {
    const fn = (call && call.function) || {};
    if (['plan', 'done', 'checkpoint', 'need'].includes(fn.name)) return null;
    const key = `${fn.name}:${JSON.stringify(fn.arguments || {})}`;
    const n = (this.seenCalls.get(key) || 0) + 1;
    this.seenCalls.set(key, n);
    if (n === 1) return null;
    this.toolEvent({ name: fn.name, label: `${fn.name} repeated with the same arguments (not run again)`, ok: false });
    return { error: `You already called ${fn.name} with exactly these arguments in this turn; its result is above. Use that result, change the arguments, or answer now.` };
  }

  declare(tools, call, response) {
    if (!gated() || !this.declaredNames) return 0;
    const names = [call && call.function && call.function.name, ...(response && Array.isArray(response.tools) ? response.tools : [])];
    const add = tools.filter(t => names.includes(t.name) && !this.declaredNames.has(t.name));
    if (!add.length) return 0;
    for (const t of add) this.declaredNames.add(t.name);
    const n = estTokens(JSON.stringify(add));
    const w = this.reply.context && this.reply.context.window;
    if (w) w.parts.tools += n;
    return n;
  }

  grow(used) {
    const w = this.reply.context && this.reply.context.window;
    if (!w) return;
    w.parts.turn = Math.max(0, used - windowTotal({ parts: { ...w.parts, turn: 0 } }) - this.windowBase);
    w.used = windowTotal(w);
    this.ui.onContext && this.ui.onContext(this.reply.context);
  }

  async runStep(task, step) {
    this.seenCalls = new Map();
    const tools = phaseTools(true);
    const known = [...new Set([...preloaded(tools), ...(task.tools || [])])];
    const toolTokens = toolCost(tools, known);
    checkOverhead(systemPrompt(this.threadId, this.session, 'step', known), toolTokens);
    this.declaredNames = new Set(tools.map(t => t.name).filter(n => !gated() || GATE.includes(n) || known.includes(n)));
    // The step prompt gets under half the window; the rest is for the step's
    // own tool calls and output (a phone has 4096 tokens in all).
    const maxTokens = Math.max(600, Math.floor(settings.contextSize * 0.45) - toolTokens);
    const sections = await this.stepSections(task, step);
    const prompt = tasks.stepPrompt(systemPrompt(this.threadId, this.session, 'step', known), task, sections, { maxTokens });
    const system = prompt.text;
    const n = tasks.stepIndex(task, step) + 1;
    this.reply.context = { mode: 'step', budget: settings.contextSize, used: estTokens(system),
      items: [{ kind: 'plan', label: `Step ${n}: ${truncate(step.text, 80)} (goal, plan and results)`, tokens: estTokens(tasks.stepSystem('', task)) },
        ...sections.filter(x => prompt.shown.includes(x.title)).map(x => ({ kind: 'section', label: x.title, tokens: estTokens(x.text) }))] };
    this.conv = await engine.conversation({ system, messages: [], tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT, known, gate: gated() ? GATE : null });
    const reserve = Math.min(MAX_OUTPUT, 700);
    const d = dialect();
    let pending = tasks.stepUser(task, { dialect: d });
    let used = estTokens(system) + estTokens(pending) + toolTokens;
    if (managed()) { pending = tasks.stepUser(task, { budget: tasks.budgetLine(used + 30, settings.contextSize, reserve, d), dialect: d }); used += 30; }
    const room = () => Math.max(0, (settings.contextSize - used - reserve) * 3);
    this.setWindow(windowOf(this.reply.context, { system: estTokens(system), tools: toolTokens, message: estTokens(pending) }), used);
    const label = `Step ${n}: ${step.text}`;
    let said = '', blank = 0, idle = 0, warnedFull = false;
    try {
      for (;;) {
        const r = await this.respond(pending, { show: false });
        used += estTokens((r.text || '') + (r.thinking || '') + JSON.stringify(r.toolCalls || []));
        this.grow(used);
        const looped = LOOPED.test(r.text || '');
        const text = (r.text || '').replace(LOOPED, '').trim();
        const asText = tasks.toolCallText(text);   // a tool call typed out, not made: never a result
        if (text && !asText) { said = text; this.addThinking(`${label}\n${text}`); }
        if (this.aborted) return 'stop';
        if (!r.toolCalls.length) {
          // Answered without calling done: what it said is the step's result.
          if (text && !looped && !asText) { tasks.finishStep(task, text); return 'next'; }
          // Only thinking, nothing at all, a loop or a typed-out call: nudge it, then ask the person.
          if (++blank <= 2) {
            pending = d.note(asText ? 'You wrote a tool call as text, so it did not run. Call the tool itself, or say what you found and call done.'
              : looped ? 'You were repeating yourself. Say in one or two lines what you found, then call done, or call a tool.' : 'Finish your thought, then call a tool, or call done with what you found.');
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
            tasks.finishStep(task, (args.result && !tasks.toolCallText(args.result) ? args.result : '') || said);
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
          const again = this.repeated(call) || this.ranInTask(task, step, call);
          if (again) { results.push(toolResult(call, again)); continue; }
          const out = await this.exec(call, { room: Math.floor(room() / r.toolCalls.length), task, step });
          if (out.ask) return 'ask';
          let response = out.response;
          if (step.calls === tasks.STEP_SOFT_CAP) response = { ...response, note: `This step has used ${step.calls} tool calls. Finish it now with done (what you have), or call need.` };
          used += this.declare(tools, call, response);
          used += estTokens(JSON.stringify(response)) + 10;
          this.grow(used);
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
    this.conv = await engine.conversation({ system: tasks.finalSystem(systemPrompt(this.threadId, this.session, 'final'), task, { maxTokens }), messages: [], tools: [], maxOutputTokens: MAX_OUTPUT });
    if (this.prefix && !/\n\n$/.test(this.prefix)) this.prefix += '\n\n';
    const r = await this.respond(tasks.finalUser(task, { dialect: dialect() }));
    this.prefix += r.text || '';
    await this.close();
  }

  // Every call is kept on the reply with its arguments (long values trimmed) and,
  // when it failed, the error the model got, so failures can be studied later.
  // With Settings → Debug → "Save tool results", what the tool returned is kept too.
  toolEvent(t, result) {
    const rec = { name: t.name, label: t.label, ok: t.ok };
    if (t.args && typeof t.args === 'object' && Object.keys(t.args).length) rec.args = tasks.trimArgs(t.args);
    if (t.ok === false && t.error) rec.error = truncate(String(t.error), 600);
    if (settings.debugTools && result !== undefined) rec.result = debugText(result);
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
      // Small models call need/find with nothing (or echo the request) when they mean something else;
      // an empty question must not reach the user.
      if (!query) {
        this.toolEvent({ name, label: `${name} without a ${name === 'need' ? 'what' : 'query'}`, ok: false });
        return { response: { error: name === 'need' ? 'need takes what: say in words what you are missing and only the user can tell you. For a calculation use calculate; to save a fact use remember.' : 'find takes query: what you are looking for (a tool, a recipe, a memory, a past chat).' } };
      }
      // need("your dog is named Pip") right after the user said so: the model is restating, not asking.
      if (name === 'need' && restates(query, this.shown)) {
        this.toolEvent({ name, label: `need restated the request (not asked)`, ok: false });
        return { response: { error: 'The user just told you that; it is not missing. Use it: answer, or save it with remember if it is a lasting fact.' } };
      }
      const { text, tools, empty, answers, web } = await this.find(query, task, { web: name === 'find' });
      if (task && tools.length) task.tools = [...new Set([...(task.tools || []), ...tools])];
      if (task) tasks.logCall(task, step, { name, args, ok: true, label: `${name} "${truncate(query, 60)}"`, text });
      if (name === 'need' && !answers) {
        // Nothing outside this task answers it: ask the person. Their reply comes back as the answer.
        this.toolEvent({ name, label: `asked you: ${truncate(query, 60)}`, ok: true });
        const q = query || 'What should I do next?';
        this.ask(/\?\s*$/.test(q) ? q : `I need to know: ${q}`, task);
        return { ask: true };
      }
      this.toolEvent({ name, label: `${name === 'need' ? 'looked for what was missing' : 'searched'}: "${truncate(query, 60)}"${web ? ' (nothing saved; searched the web)' : empty ? ' (nothing)' : ''}`, ok: true }, text);
      return { response: { found: text, ...(tools.length ? { tools } : {}) } };
    }
    if (name === 'tool_info') return { response: this.toolInfo(args, task, step) };
    if (name === 'done') return { response: { error: 'There is no step to finish yet. Call plan first, or just answer.' } };
    const res = await runTool(call, { session: this.session, threadId: this.threadId, room, pageCards: lite() && !plain(), approve: (req) => askApproval(req, this.ui, this.signal),
      ...(lite() ? { allowUrl: (u) => this.allowUrl(u) } : {}) });
    this.noteUrls(res);
    this.toolEvent({ name: res.name, label: res.label, ok: res.ok, args: res.args, error: res.model && res.model.error }, res.model);
    if (res.observation) sessions.addObservation(this.session, { ...res.observation, thread: this.threadId });
    let response = res.model && typeof res.model === 'object' ? res.model : { value: res.model };
    const json = JSON.stringify(response);
    if (json.length > room) response = { truncated: 'Result cut to fit your context; ask for less (e.g. grep, or a line range).', partial: json.slice(0, Math.max(0, room - 200)) };
    if (task) tasks.logCall(task, step, { name: res.name, args: res.args, ok: res.ok, label: res.label, text: json.replace(STRIP_UNTRUSTED, '') });
    if (task) sessions.saveTask(this.session, task);
    return { response };
  }

  // `tool_info`: declares the named tools (their schemas reach the model through the tool list, so the
  // result only confirms). Unknown names get the list back.
  toolInfo(args, task, step) {
    let want = args.names !== undefined ? args.names : (args.name !== undefined ? args.name : args.tools);
    if (typeof want === 'string') want = want.split(/[\s,]+/);
    want = [...new Set((Array.isArray(want) ? want : []).map(s => String(s).trim()).filter(Boolean))];
    const avail = modelTools().map(t => t.name).filter(n => !(step && n === 'note'));
    const found = want.filter(n => avail.includes(n));
    const missing = want.filter(n => !avail.includes(n) && !GATE.includes(n));
    if (task && found.length) task.tools = [...new Set([...(task.tools || []), ...found])];
    const response = found.length ? { tools: found, ready: `${found.join(', ')} ${found.length === 1 ? 'is' : 'are'} ready to call now.` } : {};
    if (missing.length || !want.length) response.error = `${want.length ? `No tool named ${missing.join(', ')}.` : 'Give the names of the tools you want.'} Tools you can ask about: ${avail.filter(n => !GATE.includes(n)).join(', ')}.`;
    if (task) tasks.logCall(task, step, { name: 'tool_info', args, ok: found.length > 0, label: `tool_info ${found.join(', ') || '(nothing)'}` });
    this.toolEvent({ name: 'tool_info', label: found.length ? `looked up how to call ${found.join(', ')}` : 'looked up tools (none matched)', ok: found.length > 0, args, error: response.error });
    return response;
  }

  // `find`: tools, recipes, memory, past chats and this task, in one search. With `web`, a find that
  // turns up nothing of the user's own falls through to web_search (docs/harness.md, "find falls
  // through to the web"): small models reach for find to look up facts, and then kept calling it.
  async find(query, task, { web = true } = {}) {
    const r = await findAll(query, {
      tools: modelTools(),
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
    // Nothing of theirs: search the web with the same words, unless a tool clearly matched (named, or an intent
    // phrase; above the description-only cap). A word like "recent" alone matched git_log ("Recent commits…")
    // and "most recent released movie" got that instead of the web (2026-11-04).
    const own = ['recipes', 'facts', 'chats', 'task'].some(k => r[k] && r[k].length);
    const toolAsked = r.tools.some(t => !LOOKUP_TOOLS.includes(t.name) && (t.score || 0) > 4);
    if (web && !own && !toolAsked && !PAST_CHAT.test(String(query).toLowerCase()) && this.webOn()) {
      // A question naming someone or something gets Wikipedia and Wikidata too, alongside the web.
      const wikiOn = prefetchLib.namesIn(query).length && modelTools().some(t => t.name === 'wiki_lookup');
      const [w, wiki] = await Promise.all([this.webFallback(query), wikiOn ? this.wikiTop(query, 'for find') : null]);
      if (w) return { text: wiki ? `Wikipedia and Wikidata:\n${wiki}\n\n${w}` : w, tools: [], empty: false, answers, web: true };
    }
    return { text, tools: r.tools.map(t => t.name), empty, answers };
  }

  // The user disputed the last answer or asked to confirm it: one web search on the question and the
  // claim, given to the model with the request (small models only; big ones look things up themselves).
  async checkClaim() {
    if (!lite() || plain() || !this.webOn()) return '';
    const said = String(this.shown || '').replace(/[‘’]/g, "'");
    if (!PUSHBACK.test(said)) return '';
    const line = sessions.lineMessages(this.session, this.threadId).filter(m => m.id !== (this.userMsg && this.userMsg.id) && m.content);
    const answer = [...line].reverse().find(m => m.role === 'assistant');
    if (!answer) return '';
    const question = [...line].reverse().find(m => m.role === 'user' && m.ts < answer.ts && !PUSHBACK.test(String(m.content).replace(/[‘’]/g, "'")));
    const query = checkQuery(said, { question: question && question.content, answer: answer.content });
    if (!query) return '';
    const found = await this.webFallback(query);
    return `The user is questioning or checking an earlier answer, so the web was searched first. Answer only from these results; if they don't settle it, say so plainly and don't agree just because the user said it.\n${found.replace(/^Nothing in your memory, recipes or past chats, so this /, 'This ')}`;
  }

  webOn() {
    return !plain() && modelTools().some(t => t.name === 'web_search');
  }

  // find's fall-through: one web_search, reranked against the query (by meaning when the search model is
  // loaded, else by words), best few kept. A later web_search with the same query counts as a repeat.
  // One web_search, reranked against the query (by meaning when the search model is loaded, else by words),
  // best few kept: { query, items, answer } or { query, error, items: [] }. `why` goes on the tool list label.
  async webTop(query, why = 'for find') {
    const call = { function: { name: 'web_search', arguments: { query } } };
    const res = await runTool(call, { session: this.session, threadId: this.threadId });
    this.seenCalls && this.seenCalls.set(`web_search:${JSON.stringify({ query })}`, 1);
    this.noteUrls(res);
    this.toolEvent({ name: 'web_search', label: `${res.label} (${why})`, ok: res.ok, args: res.args, error: res.model && res.model.error }, res.model);
    if (!res.ok) return { query, error: res.model.error, items: [] };
    if (res.observation) sessions.addObservation(this.session, { ...res.observation, thread: this.threadId });
    const items = res.items || [];
    let vecs = null;
    if (embedReady() && items.length) vecs = await embed([query, ...items.map(x => `${x.title}. ${x.snippet}`)]).catch(() => null);
    return { query: (res.args && res.args.query) || query, items: rerankWeb(query, items, { vecs, k: lite() ? 3 : 5 }), answer: res.answer || null };
  }

  // wiki_lookup for Fresh's lookup: the text it found (already marked as outside content), or null.
  async wikiTop(query, why = 'looked up first') {
    const call = { function: { name: 'wiki_lookup', arguments: { query } } };
    const res = await runTool(call, { session: this.session, threadId: this.threadId, pageCards: lite() });
    this.seenCalls && this.seenCalls.set(`wiki_lookup:${JSON.stringify({ query })}`, 1);
    (this.prefetchedCalls = this.prefetchedCalls || []).push(`wiki_lookup:${JSON.stringify({ query })}`);
    this.noteUrls(res);
    this.toolEvent({ name: 'wiki_lookup', label: `${res.label} (${why})`, ok: res.ok, args: res.args, error: res.model && res.model.error }, res.model);
    if (!res.ok || !res.model || !res.model.found) return null;
    if (res.observation) sessions.addObservation(this.session, { ...res.observation, thread: this.threadId });
    return res.model.found;
  }

  // Fresh context: before the model sees the message, look things up for it (prefetch.js). Returns
  // { query, text, items } (items for "What the model saw"), or null when there's nothing to look up or nothing
  // was found (small talk, bare arithmetic, no match anywhere).
  async prefetch(line) {
    const said = String(this.shown || '').replace(/[‘’]/g, "'");
    if (!said.trim() || prefetchLib.smallTalk(said)) return null;
    // The question before this one: skips "thanks!" and the like, which name nothing to borrow.
    const asks = line.filter(m => m.role === 'user' && m.content && !prefetchLib.smallTalk(m.content));
    const pushback = PUSHBACK.test(said);
    // On pushback the question is the one before it, and the claim is searched (agent.js checkClaim's rule).
    const prevQ = pushback ? [...asks].reverse().find(m => !PUSHBACK.test(String(m.content).replace(/[‘’]/g, "'"))) : asks[asks.length - 1];
    const { query } = prefetchLib.standalone(said, { prevUser: (prevQ && prevQ.content) || '' });
    const small = lite();
    // Saved things: this chat's earlier exchanges and pages, other chats when that setting is on.
    const lineThread = (o) => !o.thread || o.thread === this.threadId;
    const pages = (this.session.observations || []).filter(lineThread).flatMap(o => chunk(o.text).slice(0, 6).map((c, i) => ({
      id: `p:${o.id}:${i}`, kind: 'page', ts: o.ts, text: `${o.title || ''}\n${c}`, title: o.title, source: o.source, label: `${o.source}: ${o.title}` })));
    const exchanges = prefetchLib.exchangeCandidates(line, { textOf: (m) => messageText(m) });
    const others = settings.recallChats === true ? sessions.list().filter(x => x.id !== this.session.id).flatMap(x =>
      prefetchLib.exchangeCandidates(x.messages, { textOf: (m) => messageText(m), max: 20 }).map(c => ({ ...c, id: `c:${x.id}:${c.ref}`, kind: 'chat', title: x.title, boost: 0 }))) : [];
    const cands = [...exchanges, ...pages, ...others];
    const vecs = settings.semantic && embedReady() && cands.length ? await embed([query, ...cands.map(c => truncate(c.text, 1500))]).catch(() => null) : null;
    let found = prefetchLib.rank(query, cands, { vecs, k: small ? 4 : 8 });
    // "Run that script", "what about it?": the exchange it points at comes along whatever the ranking says, with
    // the reply in full (Fresh replays nothing else, and "it" was lost, 2026-11-09).
    // The exchange is the question before this one (prevQ: past "thanks!" and the like), not just the latest.
    const last = (prevQ && exchanges.find(x => x.ref === prevQ.id)) || null;
    if (last && prefetchLib.pointsBack(said)) found = [{ ...last, full: true, score: 1 }, ...found.filter(x => x.id !== last.id)];
    // A named question only takes memory that names them too (find's rule: "Emma Stone's real name" ≠ "the user's name").
    const asked = prefetchLib.namesIn(query).map(n => n.toLowerCase());
    const facts = (await memory.recall(query, 6).catch(() => [])).filter(r => r.score >= 0.3)
      .filter(r => !asked.length || asked.some(n => memory.factText(r.fact).toLowerCase().includes(n))).slice(0, small ? 3 : 6);
    // The web, unless the message is about the user's own things or clearly a job for another tool.
    let web = null, check = '', wiki = null;
    const own = PAST_CHAT.test(said.toLowerCase());
    // Only a question about something is looked up: a request to do or make something ("help me write a
    // generator", "run that with run_js") or a job for another tool goes to the model as is (2026-11-09: Fresh
    // threw whole requests at Wikipedia and the web and the junk sent LFM2.5 1.2B planning).
    const toolJob = rankTools(said, modelTools()).some(t => !LOOKUP_TOOLS.includes(t.name) && t.score > 4);
    const lookup = pushback || (!toolJob && !prefetchLib.doRequest(said));
    // Wikipedia and Wikidata when the question names someone or something, alongside the web search.
    const wikiP = lookup && !own && prefetchLib.namesIn(query).length && modelTools().some(t => t.name === 'wiki_lookup') ? this.wikiTop(query) : null;
    if (this.webOn() && !own && lookup) {
      const answer = pushback ? [...line].reverse().find(m => m.role === 'assistant' && m.content) : null;
      const q = pushback ? checkQuery(said, { question: prevQ && prevQ.content, answer: answer && answer.content }) || query : query;
      web = await this.webTop(q, 'looked up first');
      this.prefetched = [q];
      if (pushback) check = 'The user is questioning or checking an earlier answer, so the web was searched first. Answer only from these results; if they don\'t settle it, say so plainly, and don\'t agree just because the user said it.';
    }
    if (wikiP) wiki = await wikiP;
    const pick = (k) => found.filter(x => x.kind === k);
    const text = prefetchLib.render({
      query, exchanges: pick('exchange'), chats: pick('chat'), pages: pick('page'),
      facts: facts.map(r => memory.factText(r.fact)), web, check, wiki,
    }, { wrap: wrapUntrusted, small });
    const counts = [found.length && `${found.length} saved`, facts.length && `${facts.length} from memory`, wiki && 'Wikipedia', web && web.items.length && `${web.items.length} from the web`].filter(Boolean);
    this.toolEvent({ name: 'find', label: `looked up before answering: "${truncate(query, 60)}"${counts.length ? ` (${counts.join(', ')})` : ' (nothing)'}`, ok: true, args: { query } }, text || '(nothing found)');
    if (!text) return null;
    const items = [
      ...found.map(x => ({ kind: x.kind === 'page' ? 'observation' : x.kind === 'chat' ? 'chat' : 'message', id: x.id, ref: x.ref, label: truncate(x.kind === 'page' ? x.label : x.question, 90), score: x.score, tokens: estTokens(x.text) })),
      ...facts.map(r => ({ kind: 'fact', id: r.fact.id, label: truncate(memory.factText(r.fact), 90), score: Math.round(r.score * 100) / 100 })),
      ...(wiki ? [{ kind: 'web', label: 'Wikipedia and Wikidata' }] : []),
      ...(web && web.items.length ? [{ kind: 'web', label: `web search: ${truncate(web.query, 60)} (${web.items.length})` }] : []),
    ];
    return { query, text, items };
  }

  async webFallback(query) {
    const w = await this.webTop(query, 'for find');
    if (w.error) return `Nothing in your memory, recipes or past chats, and the web search failed: ${w.error}`;
    const top = w.items;
    const a = w.answer;
    const body = [
      a && a.text ? `Summary (${a.source}${a.url ? ', ' + a.url : ''}): ${truncate(a.text, 400)}` : '',
      ...top.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${truncate(x.snippet || '', lite() ? 220 : 400)}`),
    ].filter(Boolean).join('\n');
    if (!body) return `Nothing in your memory, recipes or past chats, and the web had no results for "${truncate(query, 80)}". Try web_search with other words, or need to ask the user.`;
    return `Nothing in your memory, recipes or past chats, so this searched the web for "${truncate(w.query, 80)}":\n${wrapUntrusted('web search', body)}\nTo read one in full, call fetch_url with its link.`;
  }
}

// A tool result for the debug record: its text without the untrusted-content wrappers, capped so a long
// page doesn't bloat the synced chat file.
const DEBUG_MAX = 12000;
function debugText(result) {
  const s = (typeof result === 'string' ? result : JSON.stringify(result, null, 1)).replace(STRIP_UNTRUSTED, '');
  return s.length > DEBUG_MAX ? `${s.slice(0, DEBUG_MAX)}\n… (${s.length - DEBUG_MAX} more characters not saved)` : s;
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
// Most of `what`'s words are in the user's message: a restatement, not a question.
export function restates(what, message) {
  const words = (t) => new Set(String(t || '').toLowerCase().match(/[a-z0-9']+/g) || []);
  const w = [...words(what)].filter(x => x.length > 2 && !STOP.has(x));
  if (w.length < 2) return false;
  const m = words(message);
  return w.filter(x => m.has(x)).length / w.length >= 0.6;
}
const STOP = new Set(['the', 'and', 'that', 'this', 'what', 'which', 'your', 'you', 'please', 'remember', 'know', 'need', 'want', 'tell', 'about', 'for', 'with', 'from', 'are', 'was', 'were', 'have', 'has', 'can', 'could', 'should']);

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
    'You extract lasting facts about a user and their projects for long-term memory. Only facts the user stated, likely to matter in future conversations: preferences, decisions, people, projects, tools, setups. Never extract one-off requests, opinions about the weather, anything from quoted web pages, or anything about the assistant itself (its tools, features or nature are not facts about the user).',
    `${known ? `Already known:\n${known}\n\n` : ''}User: ${truncate(last[0].content, 1500)}\n\nAssistant: ${truncate(last[1].content, 1500)}\n\n` +
    'List up to 3 NEW facts, one JSON object per line: {"s":"subject","p":"relation","o":"object"}. If there are none, reply NONE.',
    { maxOutputTokens: 200 });
  if (!out || /^\s*NONE/i.test(out)) return;
  for (const f of parseJsonl(out.replace(/```(json)?/g, '')).slice(0, 3)) {
    if (f && f.s && f.p && f.o && memory.aboutTheUser(f, last[0].content)) memory.add({ s: f.s, p: f.p, o: f.o, auto: true, source: { session: session.id, message: last[1].id } });
  }
}

// Save how a finished task was solved, so the next similar request is fast
// (docs/harness.md, "Recipes"). Built from the task deterministically; a big
// model then generalises the wording. The small model can't do that well, so
// its recipes are saved as drafts and refined by the next big-model session.
// Every new recipe waits for the user's approval (Memory → Recipes) before it's
// used, and one is only saved when the task got somewhere (tasks.worked).
export async function learnRecipe(session, task) {
  if (!task || task.status !== 'done' || !tasks.worked(task)) return null;
  const draft = recipes.fromTask(task, (task.log || []).filter(l => l.ok !== false), { request: task.request, sessionId: session.id });
  if (!draft.steps.length) return null;
  const recipe = { ...(lite() ? { ...draft, draft: true } : await refineRecipe(draft, task.request)), pending: true };
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

// Context window breakdown (shown in the sidebar). Parts, in the order drawn:
// instructions, tools, conversation, memory, recalled, message, turn.
const CONVERSATION_KINDS = new Set(['recent', 'pinned', 'summary', 'message', 'actions', 'thread', 'chat', 'section']);
const MEMORY_KINDS = new Set(['fact', 'note', 'recipe', 'refs', 'observation']);
export function windowOf(report, { system = 0, tools = 0, message = 0 } = {}) {
  const parts = { instructions: 0, tools, conversation: 0, memory: 0, recalled: 0, message, turn: 0 };
  let inSystem = 0;
  for (const it of (report && report.items) || []) {
    const t = it.tokens || 0;
    if (it.placed) { parts.recalled += t; continue; }
    if (CONVERSATION_KINDS.has(it.kind)) parts.conversation += t;
    else if (MEMORY_KINDS.has(it.kind)) parts.memory += t;
    else continue;
    // Recent messages are sent as messages; everything else is part of the system text.
    if (it.kind !== 'recent') inSystem += t;
  }
  // Instructions: the rest of the system text (the base prompt and harness sections).
  parts.instructions = Math.max(0, system - inSystem);
  return { size: settings.contextSize, parts, used: 0 };
}

export const windowTotal = (w) => Object.values((w && w.parts) || {}).reduce((a, b) => a + (b || 0), 0);
