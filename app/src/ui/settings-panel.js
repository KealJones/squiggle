// The Settings drawer, in sections: Model, Context, Appearance, Voice, Account, This device.
import * as github from '../github.js';
import { relayUrl, setRelayOverride } from '../config.js';
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as grants from '../grants.js';
import * as engine from '../engine.js';
import * as agent from '../agent.js';
import * as voice from '../voice.js';
import { CONTEXT_MODES, contextMode } from '../context.js';
import { h, icon, toast } from './dom.js';
import { state } from './state.js';
import { saveSettings, applyTheme, setDefaultContextMode } from './settings.js';
import { modelPicker, showSetup } from './setup.js';
import * as demo from '../demo.js';
import { openDrawer } from './panels.js';
import { switchModel, loadModel, updateComposerNote, loadSemantic, sessionModel } from './model-ui.js';

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
  const def = engine.forDevice(engine.MODELS[S.defaultModel] ? S.defaultModel : S.model);
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
    more = h('details', { class: 'model-more' }, h('summary', {}, `${engine.labOn() ? 'Experimental and lab models' : 'Experimental models'} (${extra.length})`), list);
    more.open = extra.some(o => o.dataset.model === def);
  }
  const own = state.current && state.current.model && state.current.model !== def ? `This chat uses ${engine.MODELS[state.current.model] ? engine.MODELS[state.current.model].label : state.current.model} (set in the chat details); the default applies to other chats.` : '';
  // How it runs is picked for the device (engine.forDevice): said here, not asked. A build that crashed here was
  // stepped down from; it can be tried again.
  const M = engine.MODELS[S.model];
  const how = M ? `${M.label} runs ${engine.runnerLabel(S.model)} on this device, picked automatically.` : '';
  const avoided = (S.avoidBuilds || []).filter(id => engine.MODELS[id]);
  const retry = avoided.length ? h('button', { class: 'btn', onclick: async () => {
    S.avoidBuilds = []; engine.setAvoided([]); saveSettings();
    await switchModel(engine.forDevice(S.model)); renderSettingsPanel();
  } }, 'Try the GPU again') : '';
  return field('Model', h('div', {}, all, more, retry ? h('div', { class: 'row' }, retry) : ''), [how,
    avoided.length ? 'The GPU build crashed this tab before, so it runs on the CPU.' : '',
    M && M.runtime !== 'cloud' && state.cloudOffered ? 'The cloud model is there for bigger jobs.' : '', own].filter(Boolean).join(' '));
}

// ── The panel ──────────────────────────────────────────────────────────────
export function renderSettingsPanel() {
  const c = openDrawer('Settings', 'settings');
  const body = h('div', { class: 'drawer-body settings' });
  const S = agent.settings;
  const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { 'aria-pressed': String(v === value), onclick: () => { onPick(v); saveSettings(); renderSettingsPanel(); } }, label)));
  const cfg = storage.storageConfig();
  const M = engine.MODELS[S.model];
  const mode = S.defaultContextMode || S.contextMode || 'smart';
  const modes = Object.entries(CONTEXT_MODES).filter(([k, d]) => d.offered || (d.lab && engine.labOn()) || k === mode);
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
      // The tuning knobs are lab-only: the device picks the build, its context and its cores.
      engine.labOn() ? smallModeField(S) : '',
      engine.labOn() ? noPromptField(S) : '',
      !engine.labOn() ? '' : field('Context window', seg([[4096, '4K'], [8192, '8K'], [16384, '16K']].filter(([v]) => !M.maxContext || v <= M.maxContext), S.contextSize, async (v) => { S.contextSize = v; await reloadIfReady(); }),
        M.maxContext ? `This build was compiled for ${M.maxContext / 1024}K at most.` : 'Bigger remembers more per turn but uses more memory and is slower to start. Phones are safest at 4K.'),
      M.runtime === 'litert' ? switchRow('Speed boost', 'Replies come noticeably faster, but it loads an extra helper model and needs more memory. Off by default on phones.', S.fastDecode, async (e) => { S.fastDecode = e.target.checked; saveSettings(); await reloadIfReady(); }) : '',
    ),

    section('Context',
      h('div', { class: 'field' },
        h('label', { for: 'context-mode', class: 'label' }, 'How context is managed'),
        h('select', { id: 'context-mode', onchange: (e) => { setDefaultContextMode(e.target.value, state.current); if (['smart', 'fresh'].includes(S.contextMode) && S.semantic) loadSemantic(); updateComposerNote(); renderSettingsPanel(); } },
          ...modes.map(([v, d]) => h('option', { value: v, selected: mode === v ? true : null }, d.label))),
        h('span', { class: 'hint' }, `${CONTEXT_MODES[mode] ? CONTEXT_MODES[mode].hint : ''} Check "What the model saw" on any reply.${state.current && state.current.contextMode ? ` This chat uses ${contextMode(state.current.contextMode).short} (set in the chat details); the default applies to other chats.` : ''}`)),
      ['smart', 'fresh'].includes(S.contextMode) ? switchRow('Bring in other chats', S.contextMode === 'fresh' ? 'The lookup before each message also searches your other chats.' : 'Smart context may also quote a message from another chat when it clearly fits.', S.recallChats === true, (e) => { S.recallChats = e.target.checked; saveSettings(); }) : '',
      ['smart', 'fresh'].includes(S.contextMode) ? switchRow('Search by meaning', 'Also matches by meaning, not just words. Downloads a small 23 MB search model that runs on the CPU. With its runtime it takes roughly 100 MB of tab memory while a search runs, and on phones it\'s freed 15 seconds after.', S.semantic, (e) => { S.semantic = e.target.checked; saveSettings(); if (S.semantic) loadSemantic(); }) : '',
      switchRow('Learn from conversations', 'After each reply, Squiggle saves lasting facts to Memory. Review them in the Memory panel.', S.learn, (e) => { S.learn = e.target.checked; saveSettings(); }),
    ),

    section('Appearance',
      field('Theme', seg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], S.theme || 'auto', (v) => { S.theme = v; applyTheme(); })),
    ),

    voice.support(window).synthesis ? section('Voice', voiceSettingsField(S, seg)) : '',

    storage.isLocal() ? section('Account',
      field('Demo mode', h('span', { class: 'value' }, 'Chats, memory and files stay in this browser. Nothing syncs; the git and GitHub tools are off.'),
        'Sign in with GitHub to sync through a private repo of yours and work on your repos. What you made in the demo comes along.'),
      actions('',
        h('button', { class: 'btn primary', onclick: () => showSetup('signin') }, 'Sign in with GitHub'),
        h('button', { class: 'btn', onclick: async () => { await demo.clearSamples(); toast('Sample chat, facts and file removed.'); renderSettingsPanel(); } }, 'Remove the sample data')),
    ) : section('Account',
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

    section('Lab',
      switchRow('Lab mode', 'Shows the research models (size tests, stock small models, older builds) and the experimental switches: the bare-prompt test, GPU and all cores for CPU models, AI-managed context. Also ?lab=1 in the address. See docs/lab.md for what each one was for.', Boolean(S.lab), (e) => { S.lab = e.target.checked; engine.setLab(S.lab); saveSettings(); renderSettingsPanel(); }),
      engine.labOn() ? switchRow('One bash tool (experimental)', 'Instead of separate tools for files, the web, git and maths, the model gets a shell on the same files: cat, grep, sed, pipes, plus git, gh, curl, search, wiki, node and bc (`man` lists them). Far fewer tool definitions in the context. Applies from the next message.', S.toolSurface === 'bash', (e) => { S.toolSurface = e.target.checked ? 'bash' : 'tools'; saveSettings(); updateComposerNote(); }) : '',
      switchRow('Save tool results and prompts', 'Keeps what each tool returned (under "Result" in a reply\'s tool list) and everything the model was sent: system prompt, tool schemas, messages and each round, in "What the model saw". On by default: it\'s the evidence the failure casebook is written from. Saved in your storage repo (the full context in its own file per reply, prompts/); long results are cut. Applies from the next message.', S.debugTools, (e) => { S.debugTools = e.target.checked; saveSettings(); }),
    ),

    section('This device',
      actions('Downloaded models and your sign-in live only in this browser.',
        h('button', { class: 'btn', onclick: async () => { await engine.unload(); await engine.deleteModel(S.model); location.reload(); } }, icon('i-trash'), 'Delete downloaded model'),
        storage.isLocal()
          ? h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Leave the demo? The chats, memory and files made here are deleted from this browser.')) return; await sessions.flush({ sync: false }); await storage.forgetStorage(); location.reload(); } }, 'Leave the demo')
          : h('button', { class: 'btn danger', onclick: async () => { await sessions.flush(); await github.signOut(); location.reload(); } }, 'Sign out')),
    ),
  );
  c.append(body);
}
