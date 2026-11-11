// First-run setup wizard: sign in, install the GitHub App, choose storage, pick a model.
import * as github from '../github.js';
import { relayUrl, setRelayOverride } from '../config.js';
import * as storage from '../storage.js';
import * as engine from '../engine.js';
import * as agent from '../agent.js';
import { $, h, squiggleWait } from './dom.js';
import { state } from './state.js';
import { setDefaultModel } from './settings.js';
import { startApp } from './app.js';
import { checkCloud, ensureModel } from './model-ui.js';
import * as demo from '../demo.js';

export async function showSetup(step) {
  $('#app').hidden = true;
  $('#setup').hidden = false;
  if (!step) step = !github.isSignedIn() ? 'signin' : 'storage';
  const order = ['signin', 'install', 'storage', 'model'];
  $('#setup-steps').hidden = demo.isDemo();   // the demo has one step
  $('#setup-steps').querySelectorAll('li').forEach((li, i) => {
    li.className = i < order.indexOf(step) ? 'done' : i === order.indexOf(step) ? 'now' : '';
  });
  const body = $('#setup-body');
  body.replaceChildren();
  try {
    if (step === 'signin') await setupSignIn(body);
    else if (step === 'install') await setupInstall(body);
    else if (step === 'storage') await setupStorage(body);
    else if (step === 'model') await setupModel(body);
  } catch (e) {
    body.append(h('p', { class: 'error' }, String(e.message || e)), h('button', { class: 'btn', onclick: () => showSetup(step) }, 'Try again'));
  }
}

async function setupSignIn(body) {
  let cfg;
  try { cfg = await github.relayConfig(); }
  catch (e) { if (e.code === 'relay') return setupRelay(body, e.message); throw e; }
  body.append(
    h('h2', {}, 'Your agent, on your devices'),
    h('p', {}, 'Squiggle runs an AI model on this device. Conversations, memory and files are saved to a private GitHub repo of yours, so you can pick up on any device.'),
  );
  if (!cfg.clientConfigured) {
    body.append(h('p', { class: 'error' }, 'The relay has no GitHub App configured yet. Set GITHUB_CLIENT_ID in wrangler.toml and redeploy (see the README).'));
    return;
  }
  const go = h('button', { class: 'btn primary' }, 'Sign in with GitHub');
  // Demo mode: the same app with storage in this browser, no account needed (demo.js).
  const tryIt = h('button', { class: 'btn', onclick: () => startDemo(body) }, demo.isDemo() ? 'Back to the demo' : 'Try it without signing in');
  body.append(h('div', { class: 'row' }, go, tryIt),
    demo.isDemo()
      ? h('p', { class: 'muted', style: 'margin-top:14px' }, 'Signing in keeps the chats, memory and files from the demo: they move into your storage repo.')
      : h('p', { class: 'muted', style: 'margin-top:14px' }, 'The demo keeps everything in this browser and skips the git and GitHub tools. You can sign in later and keep what you made.'));
  go.onclick = async () => {
    go.disabled = true;
    const flow = await github.startDeviceFlow();
    body.replaceChildren(
      h('h2', {}, 'Enter this code on GitHub'),
      h('div', { class: 'code-box' }, flow.user_code),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => { navigator.clipboard?.writeText(flow.user_code).catch(() => {}); window.open(flow.verification_uri, '_blank', 'noopener'); } }, 'Copy code and open GitHub'),
      ),
      h('p', { class: 'muted', style: 'margin-top:14px' }, 'Waiting for you to approve… this page continues on its own.'),
    );
    try {
      await github.pollDeviceFlow(flow);
      const insts = await github.installations();
      showSetup(insts.length ? 'storage' : 'install');
    } catch (e) {
      body.append(h('p', { class: 'error' }, e.message), h('button', { class: 'btn', onclick: () => showSetup('signin') }, 'Start over'));
    }
  };
}

// Demo mode: local storage, sample data, then the model step (no sign-in, no install, no repo).
async function startDemo(body) {
  if (!demo.isDemo()) {
    body.replaceChildren(h('h2', {}, 'Setting up the demo'), h('p', { class: 'muted' }, 'Making a space in this browser…'), squiggleWait());
    await storage.useLocalStorage();
    const sessions = await import('../sessions.js');
    const memory = await import('../memory.js');
    await Promise.all([sessions.loadAll(), memory.load()]);
    await demo.seed();
  }
  showSetup('model');
}

// Shown when the relay can't be reached (e.g. a GitHub Pages copy whose
// config.json is missing or points somewhere wrong).
function setupRelay(body, problem) {
  const input = h('input', { type: 'text', value: relayUrl(), placeholder: 'https://squiggle-relay.you.workers.dev', spellcheck: 'false', 'aria-label': 'Relay address' });
  const err = h('p', { class: 'error' }, problem);
  const save = h('button', { class: 'btn primary' }, 'Connect');
  save.onclick = async () => {
    try { setRelayOverride(input.value); github.resetRelayConfig(); showSetup('signin'); }
    catch (e) { err.textContent = e.message; }
  };
  body.append(
    h('h2', {}, 'Connect to your relay'),
    h('p', {}, 'Squiggle needs its relay (the small Cloudflare Worker from the README) to sign in to GitHub and sync. Enter its address.'),
    h('div', { class: 'field' }, h('label', {}, 'Relay address'), input),
    h('div', { class: 'row' }, save),
    err,
  );
}

async function setupInstall(body) {
  const url = await github.installUrl();
  body.append(
    h('h2', {}, 'Give Squiggle access to your repos'),
    h('p', {}, 'Install the Squiggle app on your GitHub account and choose which repos it can use. Include any repo you want the agent to work on. You can change this any time.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, 'Install on GitHub'),
      h('button', { class: 'btn', onclick: async () => { if ((await github.installations()).length) showSetup('storage'); else msg.textContent = 'Squiggle isn\'t installed yet. Finish the install on GitHub, then try again.'; } }, 'I installed it'),
    ),
  );
  const msg = h('p', { class: 'error' });
  body.append(msg);
  const check = async () => { if ((await github.installations()).length) { removeEventListener('focus', check); showSetup('storage'); } };
  addEventListener('focus', check);
}

async function setupStorage(body) {
  if ((await github.installations()).length === 0) return showSetup('install');
  body.append(h('h2', {}, 'Where should Squiggle keep your stuff?'), h('p', { class: 'muted' }, 'Looking for an existing Squiggle repo…'));
  const found = await storage.findExistingStorage();
  body.replaceChildren(h('h2', {}, 'Where should Squiggle keep your stuff?'));
  if (found) {
    body.append(
      h('p', {}, `Found your Squiggle storage in ${found.owner}/${found.name}.`),
      h('button', { class: 'btn primary', onclick: () => chooseStorage(found, body) }, 'Continue with this repo'),
      h('p', { class: 'muted', style: 'margin-top:16px' }, 'Or pick a different one:'),
    );
  } else {
    body.append(h('p', {}, 'Squiggle saves sessions, memory and files to a private GitHub repo you own.'));
  }
  body.append(
    h('button', { class: 'choice', onclick: () => storageCreate(body) }, h('strong', {}, 'Create a new private repo'), h('span', {}, 'Recommended. Named squiggle-state unless you change it.')),
    h('button', { class: 'choice', onclick: () => storagePick(body) }, h('strong', {}, 'Use an existing repo'), h('span', {}, 'Any private repo you gave Squiggle access to. Its other files stay untouched.')),
  );
}

function storageCreate(body) {
  const input = h('input', { type: 'text', value: 'squiggle-state', 'aria-label': 'Repo name', spellcheck: 'false' });
  const err = h('p', { class: 'error' });
  const create = h('button', { class: 'btn primary' }, 'Create private repo');
  body.replaceChildren(
    h('h2', {}, 'Create your storage repo'),
    h('div', { class: 'field' }, h('label', {}, 'Repo name'), input, h('span', { class: 'hint' }, 'It will be private. Only you and Squiggle can see it.')),
    h('div', { class: 'row' }, create, h('button', { class: 'btn ghost', onclick: () => showSetup('storage') }, 'Back')),
    err,
  );
  create.onclick = async () => {
    const name = input.value.trim().replace(/[^A-Za-z0-9_.-]/g, '-');
    if (!name) return;
    create.disabled = true; err.textContent = '';
    try {
      const info = await storage.createStorageRepo(name);
      await chooseStorage(info, body);
    } catch (e) {
      create.disabled = false;
      if (e.code !== 'cannot-create') { err.textContent = e.message; return; }
      // Fallback: the person creates it on GitHub, then we pick it up.
      const app = await github.installUrl();
      body.replaceChildren(
        h('h2', {}, 'Create it on GitHub'),
        h('p', {}, 'GitHub didn\'t let Squiggle create the repo directly. Two quick steps:'),
        h('p', {}, '1. Create the private repo (the form is pre-filled):'),
        h('a', { class: 'btn primary', href: storage.newRepoUrl(name), target: '_blank', rel: 'noopener' }, 'Create on GitHub'),
        h('p', { style: 'margin-top:16px' }, '2. Give Squiggle access to it:'),
        h('a', { class: 'btn', href: app, target: '_blank', rel: 'noopener' }, 'Update app access'),
        h('div', { class: 'row', style: 'margin-top:18px' }, h('button', { class: 'btn primary', onclick: () => storagePick(body, name) }, 'Done, continue')),
      );
    }
  };
}

async function storagePick(body, prefer) {
  body.replaceChildren(h('h2', {}, 'Pick a repo'), h('p', { class: 'muted' }, 'Loading your repos…'));
  const repos = await github.accessibleRepos();
  const list = h('div', { class: 'repo-list' });
  repos.sort((a, b) => (b.name === prefer) - (a.name === prefer) || (b.private - a.private) || a.full_name.localeCompare(b.full_name));
  for (const r of repos) {
    list.append(h('button', { onclick: () => checkAndChoose(r) }, h('span', {}, r.full_name), r.private ? h('span', { class: 'muted' }, 'private') : h('span', { class: 'pub' }, 'public')));
  }
  const err = h('div');
  const app = await github.installUrl();
  body.replaceChildren(
    h('h2', {}, 'Pick a repo'),
    repos.length ? list : h('p', {}, 'Squiggle can\'t see any repos yet.'),
    h('p', { class: 'muted' }, 'Not listed? ', h('a', { href: app, target: '_blank', rel: 'noopener' }, 'Give Squiggle access to it'), ', then ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); storagePick(body, prefer); } }, 'refresh'), '.'),
    err,
    h('button', { class: 'btn ghost', onclick: () => showSetup('storage') }, 'Back'),
  );
  async function checkAndChoose(r) {
    err.replaceChildren(h('p', { class: 'muted' }, 'Checking…'));
    const info = await storage.inspectRepo(r.owner.login, r.name);
    if (!info.ok) { err.replaceChildren(h('p', { class: 'error' }, info.problem)); return; }
    const note = info.root ? `This repo already has other files, so Squiggle will keep everything in a "${info.root.replace(/\/$/, '')}" folder.` : null;
    err.replaceChildren(
      note ? h('p', {}, note) : '',
      h('button', { class: 'btn primary', onclick: () => chooseStorage(info, body) }, `Use ${info.owner}/${info.name}`),
    );
  }
}

async function chooseStorage(info, body) {
  body.replaceChildren(h('h2', {}, 'Setting up storage'), h('p', { class: 'muted' }, `Connecting to ${info.owner}/${info.name}…`), squiggleWait());
  await storage.useStorage(info);
  showSetup('model');
}

async function setupModel(body) {
  await checkCloud();
  const gpu = await engine.webgpuStatus();
  const done = h('button', { class: 'btn primary', onclick: async () => { await startApp(); if (gpu.ok) ensureModel(); } }, gpu.ok ? 'Download and start' : 'Continue');
  if (engine.isMobile()) {
    // Gemma 4 doesn't fit a phone browser tab; phones run Gemma 3 270M on the
    // CPU (no WebGPU needed), or the cloud model when the relay offers it.
    if (!engine.modelFitsDevice(agent.settings.model) || (agent.settings.model === 'cloud' && !state.cloudOffered)) setDefaultModel(engine.deviceModel());
    const picker = modelPicker(agent.settings.model, (id) => setDefaultModel(id));
    const pm = engine.MODELS[engine.deviceModel()];
    body.append(h('h2', {}, 'On your phone'),
      h('p', {}, `Phones run ${pm.label} right here: a ${pm.size} download, then it works offline. It's small, so it's quick but much less capable than Gemma 4, especially with tools.` +
        (state.cloudOffered ? ' For harder tasks, pick the cloud model (Gemma 4 26B on your relay, free daily limit).' : '') + ' Your computer keeps running Gemma 4 locally.'),
      picker,
      h('button', { class: 'btn primary', onclick: async () => { await startApp(); if (agent.settings.model !== 'cloud') ensureModel(); } }, 'Start'));
    return;
  }
  if (!gpu.ok && state.cloudOffered) {
    setDefaultModel('cloud');
    body.append(h('h2', {}, 'This device can\'t run a model itself'), h('p', {}, gpu.reason),
      h('p', {}, 'Squiggle will use the cloud model on your Cloudflare relay instead (free daily limit, then it pauses until midnight UTC).'),
      h('button', { class: 'btn primary', onclick: async () => { await startApp(); } }, 'Start'));
    return;
  }
  if (!gpu.ok) {
    // No WebGPU: the small CPU model still runs.
    setDefaultModel(engine.DEFAULTS.phoneCpu);
    const cm = engine.MODELS[engine.DEFAULTS.phoneCpu];
    body.append(h('h2', {}, 'No WebGPU on this browser'), h('p', {}, gpu.reason),
      h('p', {}, `Squiggle will run ${cm.label} on the CPU instead: a ${cm.size} download, much slower than on the GPU.`),
      h('button', { class: 'btn primary', onclick: async () => { await startApp(); ensureModel(); } }, 'Download and start'));
    return;
  }
  if (!engine.modelFitsDevice(agent.settings.model)) setDefaultModel(engine.deviceModel());
  const where = engine.isMobile() ? 'phone' : 'computer';
  const picker = modelPicker(agent.settings.model, (id) => setDefaultModel(id));
  body.append(
    h('h2', {}, 'Pick a model'),
    h('p', {}, `Squiggle runs the model right here on your ${where}. It's a one-time download, then it works offline. You can switch later in Settings.`),
    picker,
    h('p', { class: 'muted' }, 'Wi-Fi is best. If the download gets interrupted, it picks up where it stopped.'),
    h('div', { class: 'row' }, done),
  );
}

// Models this device can run, as a list of choices with size and a note.
export function modelPicker(value, onPick) {
  const ids = engine.listedModels({ cloudOffered: state.cloudOffered, current: value });
  const list = h('div', { class: 'model-list', role: 'radiogroup', 'aria-label': 'Model' });
  const render = (v) => list.replaceChildren(...ids.map((id) => {
    const m = engine.MODELS[id];
    return h('button', { class: 'model-option', role: 'radio', 'aria-checked': String(id === v), 'data-model': id, onclick: () => { render(id); onPick(id); } },
      h('span', { class: 'model-name' }, m.label, id === engine.deviceModel() ? h('span', { class: 'tag' }, 'recommended') : ''),
      h('span', { class: 'model-size' }, m.size),
      h('span', { class: 'model-note' }, m.note));
  }));
  render(value);
  return list;
}
