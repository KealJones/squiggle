// The tool registry: the one place that knows which tools exist and how to run one.
//
// A tool is { spec, run }:
//   spec  { name, description, parameters }   JSON-schema function spec, sent to the model
//   run   async (args, ctx) => { model, label?, observation? }
//     model        what the model sees (JSON; outside text is wrapped as untrusted)
//     label        short line for the UI and for replaying history ("cloned owner/repo")
//     observation  { source, title, text } kept on the session so smart context
//                  can retrieve it in later turns
//   ctx   { session, approve?, room?, pageCards?, ... }  given by the agent loop (agent.js);
//         approve resolves only from the UI, never from model output (guard.js invariants).
//
// Built-in tools are registered by ./index.js. Anything else (an app extension, a test)
// can add its own with registerTool(defineTool({...})) before a turn starts.

const registry = new Map();   // name → tool, in registration order

const NAME = /^[a-z][a-z0-9_]{1,63}$/;

/** Builds a tool from flat fields; the parameters default to an object with no properties.
 *  group: a short area label ("files", "git and GitHub", …) for prompts that list tools by name. */
export function defineTool({ name, description, parameters = params({}), run, group = 'other' }) {
  return { spec: { name, description, parameters }, run, group };
}

/** Adds a tool (or replaces one with the same name in place, keeping its position). */
export function registerTool(tool) {
  const name = tool && tool.spec && tool.spec.name;
  if (!NAME.test(String(name || ''))) throw new Error(`Tool name must match ${NAME}: ${JSON.stringify(name)}`);
  if (typeof tool.run !== 'function') throw new Error(`Tool ${name} has no run()`);
  if (!tool.spec.description) throw new Error(`Tool ${name} has no description`);
  registry.set(name, tool);
  return tool;
}

export function unregisterTool(name) { return registry.delete(name); }
export function getTool(name) { return registry.get(name) || null; }
export function listTools() { return [...registry.values()]; }

/** Specs for the model: all tools, or only those in `enabled` (a Set of names). */
export const toolSpecs = (enabled) => listTools().filter(t => !enabled || enabled.has(t.spec.name)).map(t => t.spec);

/** Runs one model tool call { function: { name, arguments } }; never throws. */
export async function runTool(call, ctx) {
  const fn = (call && call.function) || {};
  const tool = registry.get(fn.name);
  let args = fn.arguments || {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  if (!tool) return { name: fn.name, args, model: { error: `Unknown tool "${fn.name}".` }, label: `unknown tool ${fn.name}`, ok: false };
  try {
    const r = await tool.run(args, ctx);
    return { name: fn.name, args, ...r, ok: !(r.model && r.model.error) };
  } catch (e) {
    return { name: fn.name, args, model: { error: String((e && e.message) || e) }, label: `${fn.name} failed`, ok: false };
  }
}

// ── Schema helpers ────────────────────────────────────────────────────────
export const params = (props, required = []) => ({ type: 'object', properties: props, required });
export const str = (description) => ({ type: 'string', description });
export const num = (description) => ({ type: 'integer', description });
export const bool = (description) => ({ type: 'boolean', description });
export const oneOf = (values, description) => ({ type: 'string', enum: values, description });
