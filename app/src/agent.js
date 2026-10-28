// The agent loop (docs/harness.md): resolve references and look up recipes,
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
import { find as findAll, renderFind } from './find.js';
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
  contextMode: 'smart',     // 'smart' (default) | 'compact' | 'full'
  semantic: true,           // MiniLM embeddings for retrieval (off on phones; BM25 alone works)
  learn: true,              // extract memory facts after turns
  tools: null,              // Set of enabled tool names, or null for all
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

const lite = () => engine.isLite(settings.model);
// Plain chat for small models without tool training (engine.chatOnly).
const plain = () => Boolean(engine.chatOnly && engine.chatOnly(settings.model));

function systemPrompt(threadId, session) {
  if (plain()) return '';
  if (lite()) return `${LITE_SYSTEM}\nToday is ${new Date().toDateString()}.`;
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
    `Use tools when they help; answer directly when they don't. Be concise. Never invent file contents or tool results, and never say you saved, remembered, changed or pushed something unless you called the tool for it in this reply.`,
    thread ? `This is a side thread started on an earlier message ("${truncate(thread.title, 80)}"). Focus on that topic.` : '',
    UNTRUSTED_RULES(),
  ].filter(Boolean).join('\n\n');
}

// Tools for a phase: the enabled agent tools plus the harness's own.
function phaseTools(step) {
  if (plain()) return [];
  const base = toolSpecs(settings.tools).filter(t => !(step && t.name === 'note'));
  const h = tasks.HARNESS_SPECS;
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
    this.recipe = null;      // a strong recipe match offered in the prompt
    this.finishedNow = false;
    this.paused = false;     // the person chose "Stop here" at a check-in
    this.nextCheckIn = tasks.CHECK_IN_EVERY;
    this.attNote = '';       // paths of files sent with this message
  }

  get aborted() { return Boolean(this.signal && this.signal.aborted); }

  async close() { if (this.conv) { try { await this.conv.delete(); } catch {} this.conv = null; } }

  addThinking(t) {
    if (!t || !t.trim()) return;
    this.thinking += (this.thinking ? '\n\n' : '') + t.trim();
    this.ui.onThinking && this.ui.onThinking(this.thinking);
  }

  async respond(input, { show = true } = {}) {
    const base = this.thinking;
    const r = await engine.respond(this.conv, input, {
      signal: this.signal,
      onText: (t) => { if (show) this.ui.onText && this.ui.onText(this.prefix + t); },
      onThinking: (t) => this.ui.onThinking && this.ui.onThinking((base ? base + '\n\n' : '') + t),
    });
    if (r.thinking && r.thinking.trim()) this.thinking = (base ? base + '\n\n' : '') + r.thinking.trim();
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
    // A recipe from a similar task: a strong match is offered as the starting plan.
    try {
      const [best] = await recipes.match(shown, 1);
      if (best && best.score >= recipes.STRONG) {
        this.recipe = best.recipe;
        extra.push({ kind: 'recipe', title: 'Recipe from a similar task (if it fits, start with plan using these steps; skip what is already answered)', text: recipeText(best.recipe), label: `Recipe: ${best.recipe.title}` });
      }
    } catch (e) { console.warn('recipes', e); }
    return { line, extra, focus };
  }

  async context({ line, extra, focus }, budget) {
    const { session, threadId, shown } = this;
    return assembleContext({
      line, session, threadId, query: shown, budget, mode: settings.contextMode,
      system: systemPrompt(threadId, session), extra, focus,
      others: settings.contextMode === 'smart' ? sessions.list() : [],
      recall: (q, k) => memory.recall(q, k), factText: memory.factText,
      embed: settings.contextMode === 'smart' && settings.semantic ? embed : null,
    });
  }

  // ── Chat phase: answer directly, or make a plan ─────────────────────────
  async chat() {
    const tools = phaseTools(false);
    const toolTokens = lite() ? 300 : estTokens(JSON.stringify(tools));
    // History gets about half the window; the rest stays free for this turn's
    // tool results and the reply (a full window made turns fail at the start).
    const budget = Math.max(1000, Math.min(settings.contextSize - MAX_OUTPUT - toolTokens - 200, Math.floor(settings.contextSize * 0.5) - toolTokens));
    const ctx = await this.context(await this.prepare(), budget);
    this.reply.context = ctx.report;
    // Plain chat: only the recent messages; extra sections would be read as instructions.
    if (plain()) ctx.system = '';
    this.conv = await engine.conversation({ system: ctx.system, messages: ctx.messages, tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT });
    let used = estTokens(ctx.system) + estTokens(JSON.stringify(ctx.messages)) + toolTokens + estTokens(this.shown);
    const room = () => Math.max(0, (settings.contextSize - used - Math.min(MAX_OUTPUT, 700)) * 3);
    // Attachments: a note, then the start of each extract using up to half
    // the free room (the model reads the rest with read_file / grep).
    const att = attachmentPrompt(this.attachments, Math.floor(room() / 2));
    let pending = att.text ? `${this.shown}\n\n${att.text}` : this.shown;
    this.attNote = att.note || '';
    used += estTokens(att.text);
    let chatCalls = 0, full = false;
    for (;;) {
      const r = await this.respond(pending);
      if (r.text) this.prefix += r.text + (r.toolCalls.length ? '\n\n' : '');
      used += estTokens((r.text || '') + (r.thinking || '') + JSON.stringify(r.toolCalls || []));
      if (!r.toolCalls.length || this.aborted) return null;
      // A plan switches to step mode (anything else in the same reply waits for its step).
      const planCall = r.toolCalls.find(c => c.function && c.function.name === 'plan');
      if (planCall) return this.startPlan(planCall.function.arguments);
      if (full) { this.prefix += '\n\n_(Stopped: the context filled up. Ask again and I\'ll make a plan for what\'s left.)_'; return null; }
      const results = [];
      for (const call of r.toolCalls) {
        if (room() < 2500) {
          results.push(toolResult(call, { error: 'Not run: your context is almost full. Call plan with the work that is left (you get a fresh context for each step), or answer now with what you have.' }));
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
    const toolTokens = lite() ? 300 : estTokens(JSON.stringify(tools));
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
    this.conv = await engine.conversation({ system, messages: [], tools, thinking: tools.length > 0, maxOutputTokens: MAX_OUTPUT, known: task.tools || [] });
    let pending = tasks.stepUser(task);
    let used = estTokens(system) + estTokens(pending) + toolTokens;
    const room = () => Math.max(0, (settings.contextSize - used - Math.min(MAX_OUTPUT, 700)) * 3);
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
            results.push(toolResult(call, { error: 'Not run: your context for this step is almost full. Call done now with what you found (the next step starts fresh).' }));
            continue;
          }
          const out = await this.exec(call, { room: Math.floor(room() / r.toolCalls.length), task, step });
          if (out.ask) return 'ask';
          let response = out.response;
          if (step.calls === tasks.STEP_SOFT_CAP) response = { ...response, note: `This step has used ${step.calls} tool calls. Finish it now with done (what you have), or call need.` };
          used += estTokens(JSON.stringify(response)) + 10;
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

  toolEvent(t) {
    this.reply.tools.push({ name: t.name, label: t.label, ok: t.ok });
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
    const res = await runTool(call, { session: this.session, threadId: this.threadId, room, approve: (req) => askApproval(req, this.ui, this.signal) });
    this.toolEvent({ name: res.name, label: res.label, ok: res.ok });
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
      searchHistory: async (q, k) => searchChats(q, k, this.userMsg.id),
      taskItems: tasks.taskItems(task),
    }, { k: 3 });
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
  if (plain()) return;   // the small model can't write titles; the first message is the title
  engine.background(async () => {
    const t = await engine.complete('You write short titles.', `Write a 2-6 word title for a conversation that starts with:\n\n${truncate(first.content, 800)}\n\nReply with only the title.`, { maxOutputTokens: 24 });
    const clean = t.replace(/^["'#*\s]+|["'.*\s]+$/g, '').slice(0, 60);
    if (clean) { session.title = clean; sessions.touch(session); }
  }).catch(() => {});
}

// Fold messages that left the recent window into the line's summary.
async function rollingSummary(session, threadId) {
  if (plain()) return;
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
  if (plain()) return;
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
  if (plain()) return;
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
