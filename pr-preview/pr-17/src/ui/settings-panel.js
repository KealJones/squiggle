// The Settings drawer, in sections: Model, Context, Appearance, Voice, Account, This device.
import * as github from '../github.js';
import { relayUrl, setRelayOverride } from '../config.js';
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as grants from '../grants.js';
import * as engine from '../engine.js';
import * as agent from '../agent.js';
import * as voice from '../voice.js';
import { h, icon, toast } from './dom.js';
import { state } from './state.js';
import { saveSettings, applyTheme } from './settings.js';
import { showSetup } from './setup.js';
import * as demo from '../demo.js';
import { openDrawer } from './panels.js';
import { switchModel, loadSemantic } from './model-ui.js';

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
// The model, as a fact rather than a menu: which one, and how it runs on this device (engine.forDevice picks the
// build). Each chat picks its model when it starts (the new-chat settings) and can switch in the chat details. A
// build that crashed here was stepped down from; it can be tried again.
function modelField(S) {
  const M = engine.MODELS[S.model];
  const how = M ? `${M.label} runs ${engine.runnerLabel(S.model)} on this device, picked automatically.` : '';
  const avoided = (S.avoidBuilds || []).filter(id => engine.MODELS[id]);
  const retry = avoided.length ? h('button', { class: 'btn', onclick: async () => {
    S.avoidBuilds = []; engine.setAvoided([]); saveSettings();
    await switchModel(engine.forDevice(S.model)); renderSettingsPanel();
  } }, 'Try the GPU again') : '';
  return field('Model', h('div', {}, h('span', { class: 'value' }, how), retry ? h('div', { class: 'row' }, retry) : ''),
    [avoided.length ? 'The GPU build crashed this tab before, so it runs on the CPU.' : '',
      'Each chat picks its model when it starts (the settings button in a new chat) and can switch in the chat details.'].filter(Boolean).join(' '));
}

// ── The panel ──────────────────────────────────────────────────────────────
export function renderSettingsPanel() {
  const c = openDrawer('Settings', 'settings');
  const body = h('div', { class: 'drawer-body settings' });
  const S = agent.settings;
  const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { 'aria-pressed': String(v === value), onclick: () => { onPick(v); saveSettings(); renderSettingsPanel(); } }, label)));
  const cfg = storage.storageConfig();

  // Relay: an inline editor instead of a prompt().
  const relayInput = h('input', { type: 'text', value: relayUrl(), placeholder: 'Same site as the app', spellcheck: 'false', 'aria-label': 'Relay address' });
  const relayErr = h('span', { class: 'error', hidden: true });
  const relaySave = h('button', { class: 'btn', onclick: () => {
    try { setRelayOverride(relayInput.value); location.reload(); } catch (e) { relayErr.textContent = e.message; relayErr.hidden = false; }
  } }, 'Save and reload');

  body.append(
    section('Model', modelField(S)),

    section('Context',
      field('How context is managed', h('span', { class: 'value' }, 'Chosen per chat, before its first message: the settings button in a new chat. Compress unless you pick another.'),
        'Check "What the model saw" on any reply to see exactly what each type sends.'),
      switchRow('Bring in other chats', 'Smart and Fresh chats may also bring in a message from another chat when it clearly fits.', S.recallChats === true, (e) => { S.recallChats = e.target.checked; saveSettings(); }),
      switchRow('Search by meaning', 'Also matches by meaning, not just words. Downloads a small 23 MB search model that runs on the CPU. With its runtime it takes roughly 100 MB of tab memory while a search runs, and on phones it\'s freed 15 seconds after.', S.semantic, (e) => { S.semantic = e.target.checked; saveSettings(); if (S.semantic) loadSemantic(); }),
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

    section('Debug',
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
