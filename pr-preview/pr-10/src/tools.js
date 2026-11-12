// The agent's tools. The implementation lives in ./tools/ (registry.js is the
// extension point; index.js registers the built-ins); this module keeps the
// original import path working.
export * from './tools/index.js';
