// The Settings drawer: model, context, voice, storage, relay, push grants, this device.
import * as github from '../github.js';
import { relayUrl, setRelayOverride } from '../config.js';
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as grants from '../grants.js';
import * as engine from '../engine.js';
import * as agent from '../agent.js';
import * as voice from '../voice.js';
import * as tts from '../tts.js';
import { CONTEXT_MODES } from '../context.js';
import { h, toast, pct } from './dom.js';
import { state } from './state.js';
import { saveSettings, applyTheme } from './settings.js';
import { modelPicker } from './setup.js';
import { openDrawer } from './panels.js';
import { initModel, loadModel, setIsolation, updateComposerNote, loadSemantic } from './model-ui.js';
import { voiceEngine, voiceModel, naturalVoiceId, createNaturalVoice, freeNaturalVoice } from './voice-ui.js';

// Voice for calls: the natural voice (a small neural model on this device) or
// an installed system voice, how fast, and whether talking over a reply
// interrupts it (off by default: speakers make the mic hear itself).
let voicesWatched = false;
const TEST_LINE = 'Hi, this is how I sound on a call.';
function voiceSettingsField(S, seg) {
  const synth = window.speechSynthesis;
  if (!voicesWatched) {
    voicesWatched = true;
    synth.addEventListener?.('voiceschanged', () => { if (state.drawerPanel === 'settings') renderSettingsPanel(); });
  }
  const lang = navigator.language || 'en-US';
  const neural = tts.neuralSupported(window);
  const engineNow = voiceEngine();
  const natural = engineNow === 'natural';
  const model = voiceModel(), m = tts.TTS_MODELS[model];
  // Best-sounding voices for this language first; robotic ones are left out.
  const prim = lang.toLowerCase().split('-')[0];
  const mine = (v) => String(v.lang || '').toLowerCase().startsWith(prim) ? 1 : 0;
  const voices = Array.from(synth.getVoices() || []).filter(v => voice.voiceQuality(v) > -10)
    .sort((a, b) => mine(b) - mine(a) || voice.voiceQuality(b) - voice.voiceQuality(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const tier = (v) => { const q = voice.voiceQuality(v); return q >= 9 ? ', premium' : q >= 6 ? ', enhanced' : ''; };
  const auto = voice.pickVoice(voices, lang, '');
  const select = natural
    ? h('select', { id: 'voice-select', 'aria-label': 'Voice', onchange: (e) => { S.ttsVoices = { ...(S.ttsVoices || {}), [model]: e.target.value }; saveSettings(); } },
        Object.entries(m.voices).map(([id, name]) => h('option', { value: id, selected: id === naturalVoiceId(model) ? true : null }, name)))
    : h('select', { id: 'voice-select', 'aria-label': 'Voice', onchange: (e) => { S.voiceURI = e.target.value; saveSettings(); } },
        h('option', { value: '' }, auto ? `Automatic (${auto.name})` : 'Automatic'),
        voices.map(v => h('option', { value: v.voiceURI, selected: v.voiceURI === S.voiceURI ? true : null }, `${v.name} (${v.lang}${tier(v)})`)));
  const status = h('span', { class: 'voice-status', 'aria-live': 'polite' });
  const testSystem = () => {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(TEST_LINE);
    const v = voice.pickVoice(synth.getVoices(), lang, S.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = Number(S.voiceRate) || 1;
    synth.speak(u);
  };
  // Loads the model just for this (inside the tap, so audio unlocks), says the
  // line, and frees it again. During a call, the call's voice is used.
  const testNatural = async (e) => {
    const btn = e.currentTarget;
    const call = state.call;
    if (call && call.nv) {
      if (call.nv.tts.state !== 'ready') { status.textContent = 'The natural voice is still loading for the call.'; return; }
      status.textContent = 'End the call to test another voice; the call uses the voice it started with.';
      return;
    }
    btn.disabled = true;
    const nv = createNaturalVoice({
      model,
      onStage: (st) => { status.textContent = `${st[0].toUpperCase()}${st.slice(1)}…`; },
      onProgress: (got, total) => { status.textContent = `Downloading ${m.label} (${m.size})${pct(got, total)}…`; },
    });
    try {
      const r = await nv.loaded;
      status.textContent = r.cached ? 'Speaking…' : `Loaded in ${(r.ms / 1000).toFixed(1)} s. Speaking…`;
      const a = await nv.tts.synth(TEST_LINE, { speed: Number(S.voiceRate) || 1 });
      await nv.player.play(a.samples, a.sampleRate);
      status.textContent = `${m.label} took ${(a.ms / 1000).toFixed(1)} s for ${(a.samples.length / a.sampleRate).toFixed(1)} s of speech${a.ms > 1000 * a.samples.length / a.sampleRate ? ': slower than speech on this device, so calls may pause between sentences' : ''}.`;
    } catch (err) {
      status.textContent = `Couldn't play the natural voice: ${err.message}.`;
    } finally {
      freeNaturalVoice(nv);
      btn.disabled = false;
    }
  };
  return h('div', { class: 'field' }, h('span', { class: 'label' }, 'Voice calls'),
    neural ? seg([['natural', 'Natural'], ['system', 'System voices']], natural ? 'natural' : 'system', (v) => { S.voiceEngine = v; }) : '',
    neural ? h('span', { class: 'hint' }, natural
      ? `A neural voice that runs on this device. It downloads once (${m.size}) and loads only during calls.`
      : engineNow === 'ask' ? 'Your first call asks whether to use the natural voice.' : 'Your browser\'s built-in voices.') : '',
    natural ? seg([['kokoro', `Best (${tts.TTS_MODELS.kokoro.size})`], ['kitten', `Light (${tts.TTS_MODELS.kitten.size})`]], model, (v) => { S.voiceModel = v; }) : '',
    natural ? h('span', { class: 'hint' }, model === 'kokoro'
      ? 'Kokoro: the most natural. Needs a fast computer to keep up, and about 400 MB of memory during calls.'
      : 'KittenTTS: lighter and faster, about 250 MB of memory during calls. The safer choice on phones.') : '',
    select,
    seg([[0.9, 'Slow'], [1, 'Normal'], [1.2, 'Fast'], [1.4, 'Faster']], Number(S.voiceRate) || 1, (v) => { S.voiceRate = v; }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: natural ? testNatural : testSystem }, 'Test voice'), status),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.voiceBargeIn ? true : null, onchange: (e) => { S.voiceBargeIn = e.target.checked; saveSettings(); } }),
      h('span', {}, h('strong', {}, 'Interrupt by talking'), h('span', { class: 'hint', style: 'display:block' }, 'Keep listening while Squiggle speaks, so you can cut in. Use headphones: on speakers it can hear itself.'))),
    h('span', { class: 'hint' }, 'Tap the headset button next to the message box to start a hands-free call. Replies are spoken as they arrive; code is skipped and links are read as their site name.'),
    natural || voices.some(v => mine(v) && voice.voiceQuality(v) >= 6) ? '' : h('span', { class: 'hint' }, 'For a much more natural voice, choose Natural above, or download a "Premium" or "Enhanced" voice in your device\'s settings (iPhone: Settings → Accessibility → Spoken Content → Voices), then pick it here.'));
}

// Small-model mode: a per-model switch for models with tools; always on (and shown as such) for Squiggle
// Small, whose fenced tool format only works with it; not shown for plain-chat models.
function smallModeField(S) {
  const id = S.model;
  if (engine.chatOnly && engine.chatOnly(id)) return '';
  const what = 'The short "don\'t guess, find it" prompt Squiggle Small is trained on: plan, done, need and find up front, and find to pick other tools.';
  if (!agent.smallModeSwitchable(id)) {
    return h('div', { class: 'field' }, h('span', { class: 'label' }, 'Small-model mode'),
      h('span', { class: 'hint' }, `Always on for ${engine.MODELS[id].label}: it's trained on this format. ${what}`));
  }
  return h('div', { class: 'field' }, h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: agent.smallMode(id) ? true : null, onchange: (e) => {
      S.smallMode = { ...(S.smallMode || {}), [id]: e.target.checked };
      if (!e.target.checked) delete S.smallMode[id];
      saveSettings(); updateComposerNote();
    } }),
    h('span', {}, h('strong', {}, 'Small-model mode'), h('span', { class: 'hint', style: 'display:block' },
      `${what} Off gives ${engine.MODELS[id].label} the full prompt. Saved for this model only; applies from the next message.`))));
}

export function renderSettingsPanel() {
  const c = openDrawer('Settings', 'settings');
  const body = h('div', { class: 'drawer-body' });
  const S = agent.settings;
  const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { 'aria-pressed': String(v === value), onclick: () => { onPick(v); saveSettings(); renderSettingsPanel(); } }, label)));
  const cfg = storage.storageConfig();
  const M = engine.MODELS[S.model];
  const plainWllama = M.runtime === 'wllama' && !M.backend;
  const mode = S.contextMode || 'smart';
  const modes = Object.entries(CONTEXT_MODES).filter(([k, d]) => d.offered || k === mode);

  body.append(
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Model'),
      modelPicker(S.model, async (v) => { if (v === S.model) return; S.model = v; saveSettings(); state.modelState = 'unknown'; await engine.unload(); initModel(); }),
      h('span', { class: 'hint' }, engine.isMobile()
        ? 'Phones run Gemma 3 270M on the CPU by default: Gemma 4 doesn\'t fit in a phone browser tab. It\'s much less capable, especially with tools; the cloud model is the stronger option when your relay offers it.'
        : 'Gemma 4 E4B is the default on computers: the smartest and best with tools. Each model downloads once per device.')),

    smallModeField(S),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Context window'),
      seg([[4096, '4K'], [8192, '8K'], [16384, '16K']], S.contextSize, async (v) => { S.contextSize = v; if (engine.engineReady()) await loadModel(); }),
      h('span', { class: 'hint' }, 'Bigger remembers more per turn but uses more memory and is slower to start. Phones are safest at 4K.')),

    M.runtime !== 'litert' ? '' : h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.fastDecode ? true : null, onchange: async (e) => { S.fastDecode = e.target.checked; saveSettings(); if (engine.engineReady()) await loadModel(); } }),
      h('span', {}, h('strong', {}, 'Speed boost'), h('span', { class: 'hint', style: 'display:block' }, 'Replies come noticeably faster, but it loads an extra helper model and needs more memory. Off by default on phones.')))),

    !plainWllama ? '' : h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.smallGpu ? true : null, onchange: async (e) => { S.smallGpu = e.target.checked; saveSettings(); if (engine.engineReady()) await loadModel(); } }),
      h('span', {}, h('strong', {}, 'Use the GPU (experimental)'), h('span', { class: 'hint', style: 'display:block' }, 'Runs this model on WebGPU instead of the CPU: could be much faster, or could crash the tab. If it crashes, Squiggle offers to turn it off.')))),
    !plainWllama ? '' : h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.smallThreads ? true : null, onchange: async (e) => {
        S.smallThreads = e.target.checked; saveSettings();
        const ok = await setIsolation(S.smallThreads);
        if (!ok && S.smallThreads) { toast('Not available here: it needs the app\'s offline helper (service worker), which only runs over https.'); return; }
        toast('Reloading to apply…', 2000); setTimeout(() => location.reload(), 600);
      } }),
      h('span', {}, h('strong', {}, 'Use all CPU cores (experimental)'), h('span', { class: 'hint', style: 'display:block' }, 'Splits the work across several cores, mostly speeding up the wait before a reply starts. Reloads the page. The note under the message box shows what\'s in use and how fast the last reply was.')))),

    h('div', { class: 'field' },
      h('label', { for: 'context-mode' }, h('strong', {}, 'Context')),
      h('select', { id: 'context-mode', onchange: (e) => { S.contextMode = e.target.value; saveSettings(); if (S.contextMode === 'smart' && S.semantic) loadSemantic(); updateComposerNote(); renderSettingsPanel(); } },
        ...modes.map(([v, d]) => h('option', { value: v, selected: mode === v ? true : null }, d.label))),
      h('span', { class: 'hint', style: 'display:block' }, `${CONTEXT_MODES[mode] ? CONTEXT_MODES[mode].hint : ''} Check "What the model saw" on any reply.`)),
    S.contextMode !== 'smart' ? '' : h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.recallChats !== false ? true : null, onchange: (e) => { S.recallChats = e.target.checked; saveSettings(); } }),
      h('span', {}, h('strong', {}, 'Bring in other chats'), h('span', { class: 'hint', style: 'display:block' }, 'Smart context may also quote a message from another chat when it clearly fits. Off keeps it to this chat.')))),
    S.contextMode !== 'smart' ? '' : h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.semantic ? true : null, onchange: (e) => { S.semantic = e.target.checked; saveSettings(); if (S.semantic) loadSemantic(); } }),
      h('span', {}, h('strong', {}, 'Search by meaning'), h('span', { class: 'hint', style: 'display:block' }, 'Also matches by meaning, not just words. Downloads a small 23 MB search model that runs on the CPU. Off by default on phones.')))),

    h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.learn ? true : null, onchange: (e) => { S.learn = e.target.checked; saveSettings(); } }),
      h('span', {}, h('strong', {}, 'Learn from conversations'), h('span', { class: 'hint', style: 'display:block' }, 'After each reply, Squiggle saves lasting facts to Memory. Review them in the Memory panel.')))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Theme'),
      seg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], S.theme || 'auto', (v) => { S.theme = v; applyTheme(); })),

    voice.support(window).synthesis ? voiceSettingsField(S, seg) : '',

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Storage'),
      h('span', {}, cfg ? h('a', { href: `https://github.com/${cfg.owner}/${cfg.name}${cfg.root ? '/tree/' + cfg.branch + '/' + cfg.root : ''}`, target: '_blank', rel: 'noopener' }, `${cfg.owner}/${cfg.name}${cfg.root ? '/' + cfg.root.replace(/\/$/, '') : ''}`) : 'None'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => storage.sync() }, 'Sync now'),
        h('button', { class: 'btn', onclick: async () => { await sessions.flush({ sync: false }); await storage.forgetStorage(); location.reload(); } }, 'Change repo'))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Repo access'),
      h('span', { class: 'hint' }, 'The agent can work on repos you\'ve given Squiggle access to, and read any public repo.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => window.open(await github.installUrl(), '_blank', 'noopener') }, 'Manage repo access'))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Relay'),
      h('span', {}, relayUrl() || 'Same site as the app'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => {
        const v = prompt('Relay address (leave empty to use the deployed setting):', relayUrl());
        if (v === null) return;
        try { setRelayOverride(v); location.reload(); } catch (e) { alert(e.message); }
      } }, 'Change'))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Push permissions'),
      h('span', { class: 'hint' }, 'The agent pushes its own agent/ branches freely. Pushing any other branch asks first, unless you chose "Always allow" for it.'),
      grants.list().length
        ? h('ul', { class: 'fact-list' }, grants.list().map(g => h('li', {},
            h('div', { class: 'fact' }, 'Always allow ', h('span', { class: 's' }, g.branch), ' in ', h('span', { class: 'o' }, g.repo)),
            h('button', { class: 'btn ghost', onclick: async () => { await grants.revoke(g.id); renderSettingsPanel(); } }, 'Revoke'))))
        : h('span', { class: 'muted' }, 'None yet.')),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'This device'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { await engine.unload(); await engine.deleteModel(S.model); location.reload(); } }, 'Delete downloaded model'),
        h('button', { class: 'btn danger', onclick: async () => { await sessions.flush(); await github.signOut(); location.reload(); } }, 'Sign out'))),
  );
  c.append(body);
}
