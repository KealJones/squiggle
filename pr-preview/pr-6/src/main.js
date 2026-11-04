// Squiggle's entry point: settings, config, sign-in state, then either the
// setup wizard or the app. The UI itself lives in ./ui/ (see CLAUDE.md "Layout").
import * as github from './github.js';
import { loadConfig } from './config.js';
import * as storage from './storage.js';
import { loadSettings } from './ui/settings.js';
import { showSetup } from './ui/setup.js';
import { startApp, fatal } from './ui/app.js';

async function boot() {
  loadSettings();
  await loadConfig();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  await github.loadAuth();
  await storage.loadStorageConfig();
  if (!github.isSignedIn() || !storage.storageConfig()) return showSetup();
  await startApp();
}

boot().catch(e => fatal(e));
