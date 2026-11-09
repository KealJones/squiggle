// The Settings drawer, in sections: Model, Context, Appearance, Voice, Account, This device.
import * as github from '../github.js';
import { relayUrl, setRelayOverride } from '../config.js';
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as grants from '../grants.js';
import * as engine from '../engine.js';
import * as agent from '../agent.js';
import * as voice from '../voice.js';
import { CONTEXT_MODES } from '../context.js';
import { h, icon, toast } from './dom.js';
import { state } from './state.js';
import { saveSettings, applyTheme } from './settings.js';
import { modelPicker } from './setup.js';
import { openDrawer } from './panels.js';
import { switchModel, loadModel, setIsolation, updateComposerNote, loadSemantic, sessionModel } from './model-ui.js';

// ── Building blocks ────────────────────────────────────────────────────────
const section = (title, ...fields) => h('section', { class: 'settings-sec' }, h('h3', {}, title), ...fields.filter(Boolean));

// A labelled control with an optional hint under it.
const field = (label, control, hint, extra = {}) => h('div', { class: 'field', ...extra }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : '');

// An on/off row: title and hint on the left, a switch on the right.
function switchRow(label, hint, checked, onchange) {
  return h('div', { class: 'field' }, h('label', { class: 'toggle' },
    h('span', { class: 'toggle-text' }, h('strong', {}, label), hint ? h('span', { class: 'hint' }, hint) : ''),
    h('input', { type: 'checkbox', class: 'switch', checked: checked ? true : null, onchange })));
}

// A row of plain actions (buttons) with an optional hint above.
const actions = (hint, ...buttons) => h('div', { class: 'field' }, hint ? h('span', { class: 'hint' }, hint) : '', h('div', { class: 'row' }, ...buttons));

// ── Voice ──────────────────────────────────────────────────────────────────
// Voice for calls: an installed system voice, how fast, and whether talking over a reply
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
  // Best-sounding voices for this language first; robotic ones are left out.
  const prim = lang.toLowerCase().split('-')[0];
  const mine = (v) => String(v.lang || '').toLowerCase().startsWith(prim) ? 1 : 0;
  const voices = Array.from(synth.getVoices() || []).filter(v => voice.voiceQuality(v) > -10)
    .sort((a, b) => mine(b) - mine(a) || voice.voiceQuality(b) - voice.voiceQuality(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const tier = (v) => { const q = voice.voiceQuality(v); return q >= 9 ? ', premium' : q >= 6 ? ', enhanced' : ''; };
  const auto = voice.pickVoice(voices, lang, '');
  const select = h('select', { id: 'voice-select', 'aria-label': 'Voice', onchange: (e) => { S.voiceURI = e.target.value; saveSettings(); } },
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
  return h('div', { class: 'field' }, h('span', { class: 'label' }, 'Voice calls'),
    h('div', { class: 'voice-row' }, select, seg([[0.9, 'Slow'], [1, 'Normal'], [1.2, 'Fast'], [1.4, 'Faster']], Number(S.voiceRate) || 1, (v) => { S.voiceRate = v; })),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: testSystem }, 'Test voice'), status),
    h('label', { class: 'toggle' },
      h('span', { class: 'toggle-text' }, h('strong', {}, 'Interrupt by talking'), h('span', { class: 'hint' }, 'Keep listening while Squiggle speaks, so you can cut in. Use headphones: on speakers it can hear itself.')),
      h('input', { type: 'checkbox', class: 'switch', checked: S.voiceBargeIn ? true : null, onchange: (e) => { S.voiceBargeIn = e.target.checked; saveSettings(); } })),
    voices.some(v => mine(v) && voice.voiceQuality(v) >= 6) ? '' : h('span', { class: 'hint' }, 'For a much more natural voice, download a "Premium" or "Enhanced" voice in your device\'s settings (iPhone: Settings → Accessibility → Spoken Content → Voices), then pick it here.'));
}

// ── Model ──────────────────────────────────────────────────────────────────
// Small-model mode: a per-model switch for models with tools; always on (and shown as such) for Squiggle
// Small, whose fenced tool format only works with it; not shown for plain-chat models.
function smallModeField(S) {
  const id = S.model;
  if (engine.chatOnly && engine.chatOnly(id)) return '';
  const what = 'The short "don\'t guess, find it" prompt Squiggle Small is trained on: plan, done, need and find up front, and find to pick other tools.';
  if (!agent.smallModeSwitchable(id)) {
    return field('Small-model mode', '', `Always on for ${engine.MODELS[id].label}: it's trained on this format. ${what}`);
  }
  // Saved as true or false per model (an explicit false overrides the default); unset means the model's default.
  return switchRow('Small-model mode', `${what} Off gives ${engine.MODELS[id].label} the full prompt. ${agent.smallModeDefault(id) ? 'On by default for a small model: the full prompt and every tool took half its window.' : 'Off by default for a big model.'} Saved for this model only; applies from the next message.`, agent.smallMode(id), (e) => {
    S.smallMode = { ...(S.smallMode || {}), [id]: e.target.checked };
    saveSettings(); updateComposerNote();
  });
}

// No prompt (experimental): the same models as the Small-model mode switch, saved per model.
function noPromptField(S) {
  const id = S.model;
  if (!agent.smallModeSwitchable(id)) return '';
  return switchRow('No prompt (experimental)', `Squiggle sends ${engine.MODELS[id].label} no instructions of its own: no persona, rules or tool-names line, only its tools in its own format and the conversation. For seeing how the model does on its own training. Saved for this model only; applies from the next message.`, agent.noPrompt(id), (e) => {
    S.noPrompt = { ...(S.noPrompt || {}), [id]: e.target.checked };
    saveSettings(); updateComposerNote();
  });
}

// The device's default model. The main models are listed; test and experimental
// ones fold away unless one of them is the current choice.
function modelField(S) {
  const def = engine.MODELS[S.defaultModel] ? S.defaultModel : S.model;
  const onPick = async (v) => {
    if (v === def) return;
    S.defaultModel = v; saveSettings();   // the saved model is the default
    // The open chat follows the default unless it has its own model.
    await switchModel(sessionModel(state.current));
    renderSettingsPanel();
  };
  const all = modelPicker(def, onPick);
  const options = [...all.querySelectorAll('.model-option')];
  const extra = options.filter(o => engine.MODELS[o.dataset.model] && engine.MODELS[o.dataset.model].experimental);
  let more = '';
  if (extra.length) {
    const list = h('div', { class: 'model-list' }, ...extra);
    more = h('details', { class: 'model-more' }, h('summary', {}, `Experimental and test models (${extra.length})`), list);
    more.open = extra.some(o => o.dataset.model === def);
  }
  const own = state.current && state.current.model && state.current.model !== def ? `This chat uses ${engine.MODELS[state.current.model] ? engine.MODELS[state.current.model].label : state.current.model} (set in the chat details); the default applies to other chats.` : '';
  return field('Default model', h('div', {}, all, more), [engine.isMobile()
    ? 'Phones run the small CPU models: Gemma 4 doesn\'t fit in a phone browser tab. The cloud model is the stronger option when your relay offers it.'
    : 'Gemma 4 E4B is the smartest and best with tools. Each model downloads once per device.', own].filter(Boolean).join(' '));
}

// ── The panel ──────────────────────────────────────────────────────────────
export function renderSettingsPanel() {
  const c = openDrawer('Settings', 'settings');
  const body = h('div', { class: 'drawer-body settings' });
  const S = agent.settings;
  const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { 'aria-pressed': String(v === value), onclick: () => { onPick(v); saveSettings(); renderSettingsPanel(); } }, label)));
  const cfg = storage.storageConfig();
  const M = engine.MODELS[S.model];
  const plainWllama = M.runtime === 'wllama' && !M.backend;
  const mode = S.contextMode || 'smart';
  const modes = Object.entries(CONTEXT_MODES).filter(([k, d]) => d.offered || k === mode);
  const reloadIfReady = async () => { if (engine.engineReady()) await loadModel(); };

  // Relay: an inline editor instead of a prompt().
  const relayInput = h('input', { type: 'text', value: relayUrl(), placeholder: 'Same site as the app', spellcheck: 'false', 'aria-label': 'Relay address' });
  const relayErr = h('span', { class: 'error', hidden: true });
  const relaySave = h('button', { class: 'btn', onclick: () => {
    try { setRelayOverride(relayInput.value); location.reload(); } catch (e) { relayErr.textContent = e.message; relayErr.hidden = false; }
  } }, 'Save and reload');

  body.append(
    section('Model',
      modelField(S),
      smallModeField(S),
      noPromptField(S),
      field('Context window', seg([[4096, '4K'], [8192, '8K'], [16384, '16K']].filter(([v]) => !M.maxContext || v <= M.maxContext), S.contextSize, async (v) => { S.contextSize = v; await reloadIfReady(); }),
        M.maxContext ? `This build was compiled for ${M.maxContext / 1024}K at most.` : 'Bigger remembers more per turn but uses more memory and is slower to start. Phones are safest at 4K.'),
      M.runtime === 'litert' ? switchRow('Speed boost', 'Replies come noticeably faster, but it loads an extra helper model and needs more memory. Off by default on phones.', S.fastDecode, async (e) => { S.fastDecode = e.target.checked; saveSettings(); await reloadIfReady(); }) : '',
      plainWllama ? switchRow('Use the GPU (experimental)', 'Runs this model on WebGPU instead of the CPU: could be much faster, or could crash the tab. If it crashes, Squiggle offers to turn it off.', S.smallGpu, async (e) => { S.smallGpu = e.target.checked; saveSettings(); await reloadIfReady(); }) : '',
      plainWllama ? switchRow('Use all CPU cores (experimental)', 'Splits the work across several cores, mostly speeding up the wait before a reply starts. Reloads the page.', S.smallThreads, async (e) => {
        S.smallThreads = e.target.checked; saveSettings();
        const ok = await setIsolation(S.smallThreads);
        if (!ok && S.smallThreads) { toast('Not available here: it needs the app\'s offline helper (service worker), which only runs over https.'); return; }
        toast('Reloading to apply…', 2000); setTimeout(() => location.reload(), 600);
      }) : '',
    ),

    section('Context',
      h('div', { class: 'field' },
        h('label', { for: 'context-mode', class: 'label' }, 'How context is managed'),
        h('select', { id: 'context-mode', onchange: (e) => { S.contextMode = e.target.value; saveSettings(); if (['smart', 'fresh'].includes(S.contextMode) && S.semantic) loadSemantic(); updateComposerNote(); renderSettingsPanel(); } },
          ...modes.map(([v, d]) => h('option', { value: v, selected: mode === v ? true : null }, d.label))),
        h('span', { class: 'hint' }, `${CONTEXT_MODES[mode] ? CONTEXT_MODES[mode].hint : ''} Check "What the model saw" on any reply.`)),
      ['smart', 'fresh'].includes(S.contextMode) ? switchRow('Bring in other chats', S.contextMode === 'fresh' ? 'The lookup before each message also searches your other chats.' : 'Smart context may also quote a message from another chat when it clearly fits.', S.recallChats === true, (e) => { S.recallChats = e.target.checked; saveSettings(); }) : '',
      ['smart', 'fresh'].includes(S.contextMode) ? switchRow('Search by meaning', 'Also matches by meaning, not just words. Downloads a small 23 MB search model that runs on the CPU. With its runtime it takes roughly 100 MB of tab memory while a search runs, and on phones it\'s freed 15 seconds after.', S.semantic, (e) => { S.semantic = e.target.checked; saveSettings(); if (S.semantic) loadSemantic(); }) : '',
      switchRow('Learn from conversations', 'After each reply, Squiggle saves lasting facts to Memory. Review them in the Memory panel.', S.learn, (e) => { S.learn = e.target.checked; saveSettings(); }),
    ),

    section('Appearance',
      field('Theme', seg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], S.theme || 'auto', (v) => { S.theme = v; applyTheme(); })),
    ),

    voice.support(window).synthesis ? section('Voice', voiceSettingsField(S, seg)) : '',

    section('Account',
      field('Storage repo',
        h('span', { class: 'value' }, cfg ? h('a', { href: `https://github.com/${cfg.owner}/${cfg.name}${cfg.root ? '/tree/' + cfg.branch + '/' + cfg.root : ''}`, target: '_blank', rel: 'noopener' }, `${cfg.owner}/${cfg.name}${cfg.root ? '/' + cfg.root.replace(/\/$/, '') : ''}`) : 'None'),
        'Your chats, memory and files live here and sync to every device you sign in on.'),
      actions('',
        h('button', { class: 'btn', onclick: () => storage.sync() }, 'Sync now'),
        h('button', { class: 'btn', onclick: async () => { await sessions.flush({ sync: false }); await storage.forgetStorage(); location.reload(); } }, 'Change repo')),
      actions('The agent can work on repos you\'ve given Squiggle access to, and read any public repo.',
        h('button', { class: 'btn', onclick: async () => window.open(await github.installUrl(), '_blank', 'noopener') }, 'Manage repo access')),
      field('Relay', h('div', { class: 'row relay-row' }, relayInput, relaySave), 'The small Cloudflare Worker that signs you in and syncs. Leave empty to use the deployed setting.'),
      relayErr,
      field('Push permissions',
        grants.list().length
          ? h('ul', { class: 'fact-list' }, grants.list().map(g => h('li', {},
              h('div', { class: 'fact' }, 'Always allow ', h('span', { class: 's' }, g.branch), ' in ', h('span', { class: 'o' }, g.repo)),
              h('button', { class: 'btn ghost small', onclick: async () => { await grants.revoke(g.id); renderSettingsPanel(); } }, 'Revoke'))))
          : h('span', { class: 'value muted' }, 'None yet.'),
        'The agent pushes its own agent/ branches freely. Pushing any other branch asks first, unless you chose "Always allow" for it.'),
    ),

    section('Debug',
      switchRow('Save tool results', 'Keeps what each tool returned (search results, pages, find) with the reply, under "Result" in its tool list. Saved in your storage repo with the chat; long results are cut at 12,000 characters. Applies from the next message.', S.debugTools, (e) => { S.debugTools = e.target.checked; saveSettings(); }),
    ),

    section('This device',
      actions('Downloaded models and your sign-in live only in this browser.',
        h('button', { class: 'btn', onclick: async () => { await engine.unload(); await engine.deleteModel(S.model); location.reload(); } }, icon('i-trash'), 'Delete downloaded model'),
        h('button', { class: 'btn danger', onclick: async () => { await sessions.flush(); await github.signOut(); location.reload(); } }, 'Sign out')),
    ),
  );
  c.append(body);
}
