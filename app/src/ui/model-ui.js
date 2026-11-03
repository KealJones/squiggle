// The chat model in the UI: picking what to load, downloading with progress,
// loading with a crash-loop guard, and the banners that explain each state.
import * as github from '../github.js';
import * as engine from '../engine.js';
import * as agent from '../agent.js';
import * as recipes from '../recipes.js';
import { loadEmbedder, embed } from '../embed.js';
import { contextMode } from '../context.js';
import { $, h, squiggleWait, gb, eta } from './dom.js';
import { state } from './state.js';
import { saveSettings, setDefaultModel } from './settings.js';
import { renderSide } from './side.js';

export async function initModel() {
  // Free space taken by models Squiggle no longer offers, and on phones by
  // on-device models a phone can't run.
  engine.cleanupStorage({ keep: (id) => engine.modelFitsDevice(id) })
    .then((n) => n && console.info(`Freed ${(n / 1e9).toFixed(1)} GB of old model downloads.`)).catch(() => {});
  if (engine.MODELS[agent.settings.model].runtime === 'cloud') {
    if (!state.cloudOffered) {
      setDefaultModel(engine.deviceModel());
      return initModel();
    }
    return loadModel();
  }
  if (engine.needsGpu(agent.settings.model)) {
    const gpu = await engine.webgpuStatus();
    if (!gpu.ok) {
      // No WebGPU: Squiggle Small runs on the CPU instead.
      setDefaultModel('SQ');
      return initModel();
    }
  }
  const info = await engine.downloadInfo(agent.settings.model);
  if (!info.complete) { state.modelState = 'missing'; showDownloadBanner(info); return; }
  let crashed = loadCrashMarker();
  // A crash with a different model (say Gemma 4 on a phone) says nothing about this one.
  if (crashed && crashed.model !== agent.settings.model && !engine.needsGpu(agent.settings.model)) { setCrashMarker(null); crashed = null; }
  if (crashed) { state.modelState = 'idle'; showCrashBanner(crashed); return; }
  if (engine.isMobile() && engine.needsGpu(agent.settings.model)) { state.modelState = 'idle'; showLoadBanner(); return; }
  await loadModel();
}

// Whether the relay offers the cloud model (checked once at startup).
export async function checkCloud() {
  try { state.cloudOffered = Boolean((await github.relayConfig()).aiEnabled); } catch { state.cloudOffered = false; }
  return state.cloudOffered;
}

// Crash-loop guard. A note is written just before the model loads and
// removed once it's loaded (or fails normally). If the browser killed the
// tab mid-load (out of memory), the note is still there next time, and
// Squiggle asks instead of loading again.
const LOADING_KEY = 'squiggle-model-loading';
export function loadCrashMarker() {
  try { return JSON.parse(localStorage.getItem(LOADING_KEY) || 'null'); } catch { return null; }
}
function setCrashMarker(v) {
  try { v ? localStorage.setItem(LOADING_KEY, JSON.stringify(v)) : localStorage.removeItem(LOADING_KEY); } catch {}
}

function showLoadBanner() {
  const m = engine.MODELS[agent.settings.model];
  banner(h('span', {}, `${m.label} is downloaded.`),
    h('button', { class: 'btn primary', onclick: (e) => { e.currentTarget.disabled = true; loadModel(); } }, 'Load model'));
}

// Models from most to least memory needed; a crash offers the next one down.
const BY_MEMORY = ['E4B', 'E2B', 'LL1', 'TG4', 'TG4A', 'LF12', 'Q35', 'Q06', 'SQ', 'G3'];
function lighterModel(id) {
  const i = BY_MEMORY.indexOf(id);
  return BY_MEMORY.slice(i + 1).find(m => engine.MODELS[m] && engine.modelFitsDevice(m)) || null;
}
function lightest() {
  const S = agent.settings;
  return !lighterModel(S.model) && S.contextSize <= 4096 && !S.fastDecode;
}

function showCrashBanner(c) {
  const m = engine.MODELS[c.model] || engine.MODELS[agent.settings.model];
  const S = agent.settings;
  const next = lighterModel(S.model) || S.model;
  const nm = engine.MODELS[next];
  const lighter = h('button', { class: 'btn primary', onclick: async () => {
    Object.assign(agent.settings, { contextSize: 4096, fastDecode: false });
    setDefaultModel(next); setCrashMarker(null);
    state.modelPromise = null; ensureModel(); // downloads the lighter model first if needed, then loads
  } }, next === S.model ? 'Use lighter settings' : `Use lighter settings (${nm.label}, ${nm.size})`);
  // Settings may have become lighter since the crash (e.g. phones moved to a phone model).
  const changed = c.model !== S.model || c.contextSize !== S.contextSize || Boolean(c.fast) !== Boolean(S.fastDecode)
    || Boolean(c.small && c.small.gpu) !== Boolean(S.smallGpu && engine.MODELS[S.model].runtime === 'wllama' && !engine.MODELS[S.model].backend)
    || Boolean(c.small && c.small.threads) !== Boolean(S.smallThreads && engine.MODELS[S.model].runtime === 'wllama' && !engine.MODELS[S.model].backend);
  // The experimental GPU / all-cores settings are the first suspects: offer to turn them off.
  const risky = c.model === S.model && c.small && (c.small.gpu || c.small.threads) && (S.smallGpu || S.smallThreads);
  const plain = risky ? h('button', { class: 'btn primary', onclick: async () => {
    // The GPU is the likelier culprit: turn off only that when it was on (all cores keeps working).
    setCrashMarker(null);
    if (c.small.gpu) { S.smallGpu = false; saveSettings(); loadModel(); return; }
    S.smallThreads = false; saveSettings(); await setIsolation(false); location.reload();
  } }, c.small.gpu ? 'Turn off the GPU and try again' : 'Turn off all cores and try again') : '';
  const again = h('button', { class: changed ? 'btn primary' : 'btn', onclick: () => { setCrashMarker(null); loadModel(); } }, changed ? 'Load model' : 'Try again');
  const settingsText = `${engine.MODELS[S.model].label}, ${S.contextSize / 1024}K context, speed boost ${S.fastDecode ? 'on' : 'off'}`;
  banner(h('div', { class: 'dl' },
    h('span', {}, `${c.phase === 'reply' ? m.label + ' crashed this tab while answering' : 'Loading ' + m.label + ' crashed this tab last time'}${c.stage ? `, while ${c.stage}` : ''}.`),
    c.gpu ? h('span', { class: 'muted' }, `GPU: ${c.gpu}`) : '',
    h('span', { class: 'muted' }, changed
      ? `This device now uses lighter settings (${settingsText}), which need much less memory.`
      : lightest()
        ? 'This is already the lightest setup. Close other tabs and apps, then try again; some devices can\'t run the model.'
        : `Lighter settings use ${nm.label} (needs less memory), a 4K context and no speed boost.`),
    risky ? h('span', { class: 'muted' }, `It was using the experimental ${c.small.gpu ? 'GPU' : 'all-cores'} setting.`) : '',
    h('div', { class: 'row' }, plain, changed || lightest() || risky ? '' : lighter, again)));
}

export function banner(...content) {
  const b = $('#model-banner');
  if (!content.length) { b.hidden = true; b.replaceChildren(); return; }
  b.hidden = false;
  b.replaceChildren(...content);
}

function showDownloadBanner(info) {
  const m = engine.MODELS[agent.settings.model];
  const resumed = info && info.stored ? ` (${Math.round(100 * info.stored / (info.total || 1))}% done)` : '';
  banner(h('span', {}, `Download ${m.label} (${m.size}) to start chatting${resumed}.`),
    h('button', { class: 'btn primary', onclick: (e) => { e.currentTarget.disabled = true; ensureModel(); } }, info && info.stored ? 'Resume download' : 'Download'));
}

/** Downloads the model if needed, then loads it. Resolves true when it's ready. */
export function ensureModel() {
  if (state.modelState === 'ready') return Promise.resolve(true);
  if (state.modelState === 'unsupported') return Promise.resolve(false);
  state.modelPromise = state.modelPromise || (async () => {
    try {
      const id = agent.settings.model;
      const info = await engine.downloadInfo(id);
      if (!info.complete) {
        state.modelState = 'downloading';
        const m = engine.MODELS[id];
        const bar = h('div');
        const progress = h('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': 'Model download' }, bar);
        const label = h('span', {}, `Starting download of ${m.label}…`);
        const detail = h('span', { class: 'muted' }, 'Keep this tab open. If it gets interrupted, it picks up where it stopped.');
        banner(h('div', { class: 'dl' }, h('div', { class: 'dl-head' }, squiggleWait(), label), progress, detail));
        // Keep the screen on while downloading (best effort; never blocks).
        let wake = null;
        navigator.wakeLock?.request('screen').then(w => { wake = w; }).catch(() => {});
        // Smoothed speed for the time estimate.
        let lastT = performance.now(), lastGot = null, speed = 0;
        try {
          await engine.download(id, (got, total) => {
            const now = performance.now();
            if (lastGot != null && now - lastT > 700) {
              const inst = (got - lastGot) / ((now - lastT) / 1000);
              speed = speed ? speed * 0.7 + inst * 0.3 : inst;
              lastT = now; lastGot = got;
            } else if (lastGot == null) { lastGot = got; lastT = now; }
            if (!total) return;
            const pct = Math.min(100, 100 * got / total);
            progress.classList.remove('indeterminate');
            progress.setAttribute('aria-valuenow', pct.toFixed(0));
            bar.style.width = pct.toFixed(1) + '%';
            label.textContent = `Downloading ${m.label}: ${gb(got)} of ${gb(total)} GB (${pct.toFixed(0)}%)`;
            if (speed > 0) detail.textContent = `${(speed / 1e6).toFixed(1)} MB/s · ${eta((total - got) / speed)}`;
          }, undefined, {
            onWaiting: () => {
              label.textContent = `${m.label} is downloading in another tab or window.`;
              detail.textContent = 'This tab will continue as soon as it finishes.';
            },
          });
        } finally { try { await wake?.release(); } catch {} }
      }
      await loadModel();
      return state.modelState === 'ready';
    } catch (e) {
      state.modelState = 'error';
      banner(h('span', { class: 'error' }, e.message), h('button', { class: 'btn', onclick: () => { state.modelPromise = null; ensureModel(); } }, 'Resume'));
      return false;
    } finally {
      state.modelPromise = null;
    }
  })();
  return state.modelPromise;
}

/** Loads a different model (the Settings picker, or a chat with its own model). */
export async function switchModel(id) {
  if (!engine.MODELS[id] || id === agent.settings.model) return;
  agent.settings.model = id;
  state.modelState = 'unknown';
  await engine.unload();
  await initModel();
}

// A chat can have its own model (session.model); otherwise the device default
// applies. Called when a chat opens and before each turn. Never mid-reply.
export function sessionModel(session) {
  const own = session && session.model;
  const fits = (id) => engine.MODELS[id] && engine.modelFitsDevice(id) && (!engine.MODELS[id].needsRelay || state.cloudOffered);
  return fits(own) ? own : (fits(agent.settings.defaultModel) ? agent.settings.defaultModel : agent.settings.model);
}
export async function useSessionModel(session) {
  if (state.busy) return;
  const want = sessionModel(session);
  if (want !== agent.settings.model) await switchModel(want);
}

export function updateComposerNote() {
  renderSide();
  const note = $('#composer-note');
  if (!note || state.modelState !== 'ready') return;
  const cloud = engine.MODELS[agent.settings.model].runtime === 'cloud';
  const mode = agent.settings.contextMode;
  const modeNote = mode === 'compact' ? '' : `${contextMode(mode).short} context is on.`;
  note.textContent = `${engine.MODELS[agent.settings.model].label}, ${cloud ? 'running on your Cloudflare relay (free daily limit)' : `running on this device${smallHow()}`}. ${modeNote}${agent.smallModeSwitchable() && agent.smallMode() ? ' Small-model mode is on.' : ''}`;
  // Small models: how fast the last reply was (for comparing GPU / cores / models).
  if (!cloud && engine.isLite()) engine.smallSpeed().then((sp) => {
    if (!sp || state.modelState !== 'ready') return;
    note.textContent += ` Last reply: started after ${(sp.waitMs / 1000).toFixed(1)} s${sp.perSec ? `, then ${sp.perSec} tokens/s` : ''}.`;
  }).catch(() => {});
}
// "(GPU)", "(4 CPU cores)", "(1 CPU core, Safari compatibility build)" for small models.
export function smallHow() {
  const i = engine.isLite() ? engine.smallInfo() : null;
  if (!i) return '';
  const parts = [i.webllm ? 'GPU, WebLLM' : i.gpu ? 'GPU' : `${i.threads} CPU core${i.threads === 1 ? '' : 's'}`];
  if (i.compat) parts.push('Safari compatibility build');
  if (i.asked && i.asked.gpu && !i.gpu) parts.push('no WebGPU here');
  if (i.asked && i.asked.threads && i.threads === 1) parts.push(i.asked.isolated ? 'threads unavailable' : 'cores need a reload');
  return ` (${parts.join(', ')})`;
}

// "Use all CPU cores": the page must be cross-origin isolated, which sw.js
// does with headers when this flag is in Cache Storage. Takes a reload.
export async function setIsolation(on) {
  try {
    const c = await caches.open('squiggle-flags');
    if (on) await c.put('/__flags/isolate', new Response('1')); else await c.delete('/__flags/isolate');
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (sw) sw.postMessage({ type: 'isolate', on });
    return Boolean(sw);
  } catch { return false; }
}

export async function loadModel() {
  state.modelState = 'loading';
  const S = agent.settings;
  const cloud = engine.MODELS[S.model].runtime === 'cloud';
  const step = h('span', { class: 'muted' });
  banner(h('div', { class: 'dl' }, h('div', { class: 'dl-head' }, squiggleWait(), h('span', {}, cloud ? 'Connecting to the cloud model…' : `Loading ${engine.MODELS[S.model].label}…`)), step));
  // The marker is rewritten at every step (localStorage writes are synchronous,
  // so it survives the tab being killed) and says where a crash happened.
  const small = engine.MODELS[S.model].runtime === 'wllama' && !engine.MODELS[S.model].backend ? { gpu: Boolean(S.smallGpu), threads: Boolean(S.smallThreads) } : null;
  const marker = { model: S.model, contextSize: S.contextSize, fast: S.fastDecode, small, at: Date.now(), stage: 'starting', gpu: cloud ? '' : await engine.gpuSummary(), ua: navigator.userAgent };
  setCrashMarker(marker);
  try {
    await engine.load(S.model, S.contextSize, { fast: S.fastDecode, small: small || {}, onStage: (st) => { marker.stage = st; setCrashMarker(marker); step.textContent = st[0].toUpperCase() + st.slice(1) + '…'; } });
    setCrashMarker(null);
    // While a reply is generated, keep a marker too: a crash mid-reply then
    // says so on the next open.
    engine.setProgress((st) => {
      if (!st) { setCrashMarker(null); return; }
      setCrashMarker({ ...marker, phase: 'reply', stage: st, at: Date.now() });
    });
    state.modelState = 'ready';
    banner();
    updateComposerNote();
    if (agent.settings.contextMode === 'smart' && agent.settings.semantic) loadSemantic();
  } catch (e) {
    setCrashMarker(null);
    state.modelState = 'error';
    banner(h('span', { class: 'error' }, 'Could not start the model: ' + e.message), h('button', { class: 'btn', onclick: () => loadModel() }, 'Try again'));
  }
}

// Semantic search (MiniLM on the CPU) for smart context, memory and recipes.
export function loadSemantic() {
  loadEmbedder().then((ok) => { if (ok) recipes.setEmbedder(embed); });
}
