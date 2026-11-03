// ESLint flat config. Correctness rules only: the code style here is deliberate
// (dense one-liners, no semicolon debates), so there is no formatter.
import globals from 'globals';

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-fallthrough': 'error',
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: true }],
  'eqeqeq': ['error', 'smart'],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-async-promise-executor': 'error',
  'no-prototype-builtins': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

export default [
  { ignores: ['app/vendor/**', 'node_modules/**', '.wrangler/**'] },
  {
    files: ['app/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.worker, ...globals.serviceworker } },
    rules,
  },
  {
    files: ['worker/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.serviceworker, Response: 'readonly', Request: 'readonly', Headers: 'readonly', URL: 'readonly', fetch: 'readonly', crypto: 'readonly', caches: 'readonly', WebSocketPair: 'readonly', DurableObject: 'readonly' } },
    rules,
  },
  {
    files: ['tests/**/*.{js,mjs}', 'scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules,
  },
  {
    // Playwright page.evaluate callbacks run in the browser against the test page's globals.
    files: ['tests/e2e/run.mjs'],
    languageOptions: { globals: { T: 'readonly' } },
  },
];
