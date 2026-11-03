// Per-device settings (localStorage). The values live on agent.settings; this
// loads them, applies one-time migrations, and saves them back.
import * as engine from '../engine.js';
import * as agent from '../agent.js';

const SETTINGS_KEY = 'squiggle-settings';

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
  const mobile = engine.isMobile();
  Object.assign(agent.settings, { model: engine.deviceModel() }, mobile ? { contextSize: 4096, fastDecode: false, semantic: false } : {}, saved);
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
  if (saved.tools) agent.settings.tools = new Set(saved.tools);
  // The saved model is the device default. In memory, settings.model is whatever is
  // loaded right now: a chat with its own model (session.model) changes it while
  // that chat is open, and saveSettings writes the default back, never that.
  agent.settings.defaultModel = agent.settings.model;
  applyTheme();
}

export function saveSettings() {
  const { defaultModel, ...rest } = agent.settings;
  const s = { ...rest, model: defaultModel || agent.settings.model, tools: agent.settings.tools ? [...agent.settings.tools] : null };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
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
