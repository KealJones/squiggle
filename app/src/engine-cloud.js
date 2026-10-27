// Cloud model: Gemma 4 26B on Workers AI through the Squiggle relay. Same
// conversation interface as the on-device engines. The relay enforces a hard
// daily cap under Cloudflare's free tier; when it's reached, replies stop with
// a clear "today's limit" message instead of anything being billed.
import { relayAi } from './github.js';

const when = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export function limitMessage(resetsAt) {
  return `You've hit today's free cloud limit, so the cloud model is paused. It resets at ${resetsAt ? when(resetsAt) : 'midnight UTC'}. Pick an on-device model in Settings to keep going.`;
}

let callId = 0;
class Conversation {
  constructor({ preface, sessionConfig }) {
    this.messages = preface.messages.map(m => ({ role: m.role, content: m.content }));
    this.tools = preface.tools || [];
    this.max = sessionConfig.maxOutputTokens || 1024;
    this.temperature = sessionConfig.samplerParams && sessionConfig.samplerParams.type === 3 ? 0 : 0.7;
    this.lastCalls = [];
    this.cancelled = false;
  }
  cancel() { this.cancelled = true; }
  async delete() {}

  async *sendMessageStreaming(input) {
    this.cancelled = false;
    if (typeof input === 'string') this.messages.push({ role: 'user', content: input });
    else {
      input.flatMap(m => m.content).forEach((c, i) => {
        const call = this.lastCalls[i] || this.lastCalls.find(t => t.function.name === c.name) || { id: 'call' + (++callId) };
        this.messages.push({ role: 'tool', tool_call_id: call.id, name: c.name, content: JSON.stringify(c.response) });
      });
    }
    let d;
    try {
      d = await relayAi({ messages: this.messages, tools: this.tools.length ? this.tools : undefined, max_tokens: this.max, temperature: this.temperature });
    } catch (e) {
      if (e.code === 'limit') throw new Error(limitMessage(e.resetsAt));
      throw e;
    }
    if (this.cancelled) return;
    const calls = (d.tool_calls || []).map(t => ({ id: t.id || 'call' + (++callId), type: 'function', function: { name: t.function.name, arguments: parseArgs(t.function.arguments) } }));
    this.lastCalls = calls;
    this.messages.push({ role: 'assistant', content: d.content || '', ...(calls.length ? { tool_calls: calls.map(c => ({ ...c, function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) } })) } : {}) });
    if (d.reasoning) yield { thinking: d.reasoning };
    if (d.content) yield { content: d.content };
    if (calls.length) yield { tool_calls: calls };
  }
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  try { return JSON.parse(a || '{}'); } catch { return {}; }
}

export function createEngine() {
  return {
    createConversation: async (cfg) => new Conversation(cfg),
    delete: async () => {},
  };
}
