// Stands in for @mlc-ai/web-llm in tests/eval/run.mjs --llm: Squiggle's own prompt rendering and call parsing
// (toolformats/: LFM2, LFM3, Gemma 4) run exactly as on a phone; only the raw completion goes to native llama.cpp
// (tests/eval/llm_server.py, through window.__llm, which the runner exposes) instead of WebGPU. Raw formats only:
// the chat-API formats (Qwen) render inside WebLLM, so they aren't faked.
export const prebuiltAppConfig = { model_list: [] };
export const hasModelInCache = async () => true;
export const deleteModelAllInfoInCache = async () => {};
export async function CreateMLCEngine() {
  return {
    resetChat: async () => {}, interruptGenerate: () => {}, unload: async () => {},
    completions: { create: async (o) => {
      const r = JSON.parse(await window.__llm(JSON.stringify({ prompt: o.prompt, max_tokens: o.max_tokens, temperature: o.temperature, top_p: o.top_p, repetition_penalty: o.repetition_penalty, stop: o.stop })));
      (window.__llmLog = window.__llmLog || []).push({ prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, seconds: r.seconds });
      return (async function* () { yield { choices: [{ text: r.text }] }; })();
    } },
    chat: { completions: { create: async () => { throw new Error('chat API not faked'); } } },
  };
}
