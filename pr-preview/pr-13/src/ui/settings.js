// Per-device settings (localStorage). The values live on agent.settings; this
// loads them, applies one-time migrations, and saves them back.
import * as engine from '../engine.js';
import * as agent from '../agent.js';

const SETTINGS_KEY = 'squiggle-settings';

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
  const mobile = engine.isMobile();
  // Lab mode (research models and experimental switches): ?lab=1 / ?lab=0 in the address sets it for this
  // device; otherwise the saved setting. Decided before the model, since it changes which ones are listed.
  engine.setAvoided(saved.avoidBuilds);
  Object.assign(agent.settings, { model: engine.deviceModel() }, mobile ? { contextSize: 4096, fastDecode: false } : {}, saved);
  // Phones only run models that fit a phone; anything else moves to the default.
  if (!engine.MODELS[agent.settings.model] || !engine.modelFitsDevice(agent.settings.model)) {
    agent.settings.model = engine.deviceModel();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...saved, model: agent.settings.model })); } catch {}
  }
  // Phones set up before the lighter defaults existed saved the desktop ones
  // (and could crash loading the model); move them over once.
  // Phones used to default to the cloud model; Gemma 3 270M on the CPU is the
  // phone default now. Move them over once (the cloud model stays in Settings).
  if (mobile && !saved.phoneG3) {
    if (agent.settings.model === 'cloud') agent.settings.model = 'G3';
    saved = { ...saved, model: agent.settings.model, phoneG3: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // Stock Gemma 3 270M can't use tools (it runs as plain chat); phones move
  // to Squiggle Small, the fine-tuned model that can. Once; G3 stays in Settings.
  if (mobile && !saved.phoneSQ) {
    if (agent.settings.model === 'G3') agent.settings.model = 'SQ';
    saved = { ...saved, model: agent.settings.model, phoneSQ: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // Qwen3 0.6B on WebLLM is the phone default where WebGPU exists. Phones on Squiggle Small or Gemma 3
  // move over once (both stay in Settings).
  if (mobile && !saved.phoneWQ06) {
    if (engine.MODELS.WQ06 && engine.hasWebGpu && engine.hasWebGpu() && ['SQ', 'G3'].includes(agent.settings.model)) agent.settings.model = 'WQ06';
    saved = { ...saved, model: agent.settings.model, phoneWQ06: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // LFM2.5 1.2B on WebLLM is the phone default now (Keal, 2026-11-09): phones on Qwen3 0.6B move over once.
  if (mobile && !saved.phoneLFM) {
    if (engine.hasWebGpu && engine.hasWebGpu() && ['WQ06', 'SQ', 'G3'].includes(agent.settings.model)) agent.settings.model = engine.DEFAULTS.phoneGpu;
    saved = { ...saved, model: agent.settings.model, phoneLFM: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // Several CPU cores is automatic now (there's no setting): the old default saved "off" on every device, so it
  // flips once; a crash with it on turns it off again (the crash banner).
  if (!saved.autoThreads) {
    agent.settings.smallThreads = true;
    saved = { ...saved, smallThreads: true, autoThreads: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // LFM3 1.7B is the model everywhere now (Keal, 2026-11-10): a device on one of the earlier defaults moves over once.
  // A model picked on purpose (the cloud model, a lab model) stays; the old ones are still in lab mode.
  if (!saved.lfm3Default) {
    if (['E4B', 'E2B', 'WLF12', 'WQ06', 'SQ', 'G3', 'WLF3'].includes(agent.settings.model)) agent.settings.model = engine.deviceModel();
    saved = { ...saved, model: agent.settings.model, lfm3Default: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // Squiggle got simpler (Keal, 2026-11-10): no lab mode, no small-model / no-prompt / tool-surface / GPU switches and no
  // context-size setting (each model gets its own maximum, engine.contextFor). Context is chosen per chat, before its
  // first message, and Compress is the default. Whatever an older version saved for those goes, once; a model that
  // no longer exists becomes this device's default.
  if (!saved.simplified) {
    for (const k of ['lab', 'smallMode', 'noPrompt', 'toolSurface', 'smallGpu', 'contextSize']) delete saved[k];
    Object.assign(agent.settings, { smallMode: {}, noPrompt: {}, toolSurface: 'bash', smallGpu: false, contextMode: 'compact' });
    saved = { ...saved, contextMode: 'compact', simplified: true, harnessV2: true };   // harnessV2's Smart default is older; it mustn't run after this
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  if (!engine.MODELS[agent.settings.model]) agent.settings.model = engine.deviceModel();
  agent.settings.contextSize = engine.contextFor(agent.settings.model);
  // Search by meaning on phones too: its worker sleeps (and frees its memory) 15 s after a search (embed.js).
  if (mobile && !saved.phoneSemantic) {
    agent.settings.semantic = true;
    saved = { ...saved, semantic: true, phoneSemantic: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  if (mobile && !saved.mobileTuned) {
    Object.assign(agent.settings, { contextSize: 4096, fastDecode: false, mobileTuned: true });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...saved, model: agent.settings.model, contextSize: 4096, fastDecode: false, mobileTuned: true })); } catch {}
  }
  // Harness v2: smart context is the default (BM25 alone is enough on a phone;
  // embeddings stay optional). Move existing devices over once.
  if (!saved.harnessV2) {
    agent.settings.contextMode = 'smart';
    saved = { ...saved, contextMode: 'smart', harnessV2: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // Compress really is the default (2026-11-11): until now a new browser ran the "simplified" step above and then the
  // older harnessV2 one, which put it back on Smart (Greg's phone, every demo visitor). Devices left on Smart move to
  // Compress once; chats keep the type they were started with (session.contextMode).
  if (!saved.compactDefault) {
    if (agent.settings.contextMode === 'smart') agent.settings.contextMode = 'compact';
    saved = { ...saved, contextMode: agent.settings.contextMode, compactDefault: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // The natural voice (Kokoro/KittenTTS) was removed; calls use system speech.
  // Drop its settings and crash marker.
  if ('voiceEngine' in saved || 'voiceModel' in saved || 'ttsVoices' in saved) {
    const { voiceEngine, voiceModel, ttsVoices, ...rest } = saved; // eslint-disable-line no-unused-vars
    for (const k of ['voiceEngine', 'voiceModel', 'ttsVoices']) delete agent.settings[k];
    saved = rest;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  try { localStorage.removeItem('squiggle-voice-loading'); } catch {}
  // Other chats out of smart context by default (a 5 × 5 / 129 question got two old Emma Stone answers
  // quoted in, one of them wrong). Once; the switch stays in Settings → Context.
  if (!saved.noChatRecall) {
    agent.settings.recallChats = false;
    saved = { ...saved, recallChats: false, noChatRecall: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // Saved tool results are on by default now (Keal, 2026-11-09): they're what the casebook and "What the model
  // saw" are read from. Devices that saved the old default move over once; the switch stays in Settings → Lab.
  if (!saved.debugToolsOn) {
    agent.settings.debugTools = true;
    saved = { ...saved, debugTools: true, debugToolsOn: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  if (saved.tools) agent.settings.tools = new Set(saved.tools);
  // The saved model is the device default. In memory, settings.model is whatever is
  // loaded right now: a chat with its own model (session.model) changes it while
  // that chat is open, and saveSettings writes the default back, never that.
  agent.settings.defaultModel = agent.settings.model;
  // The context mode works the same way: settings.contextMode is the mode in effect (a chat can have its own,
  // session.contextMode; ui/model-ui.js useSessionContext), defaultContextMode the saved device default.
  agent.settings.defaultContextMode = agent.settings.contextMode;
  applyTheme();
}

export function saveSettings() {
  const { defaultModel, defaultContextMode, ...rest } = agent.settings;
  const s = { ...rest, model: defaultModel || agent.settings.model, contextMode: defaultContextMode || agent.settings.contextMode, tools: agent.settings.tools ? [...agent.settings.tools] : null };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/** Changes the device's default context mode (and the mode in effect, unless the open chat has its own). */
export function setDefaultContextMode(mode, session = null) {
  agent.settings.defaultContextMode = mode;
  if (!(session && session.contextMode)) agent.settings.contextMode = mode;
  saveSettings();
}

/** Changes the device default (and the loaded model, since the default is what loads next). */
export function setDefaultModel(id) {
  agent.settings.model = id;
  agent.settings.defaultModel = id;
  saveSettings();
}

export function applyTheme() {
  const t = agent.settings.theme || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
