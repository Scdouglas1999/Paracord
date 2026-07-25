import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/**
 * The lint config exists primarily for `react-hooks/exhaustive-deps`. This repo
 * shipped without ESLint for its whole life, and every class of bug that rule
 * catches — stale closures in effects, effects that tear down on unrelated
 * renders, callbacks re-created every frame — was present in the voice and
 * message-feed code. Keep the rule on as an error in `src/`; it is the reason
 * this file exists.
 *
 * Type-aware linting is deliberately NOT enabled: `tsc --noEmit` already runs in
 * CI and covers everything the typed rules would, at a fraction of the runtime.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      // Plain browser script copied verbatim into the bundle, not part of `src`.
      'public/**',
      'node_modules/**',
      'src-tauri/**',
      'test-results/**',
      'playwright-report/**',
      '.probe-*.mjs',
      'scripts/**',
      '*.config.js',
      '*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // The whole point of adding ESLint here. Do not downgrade to "warn".
      'react-hooks/exhaustive-deps': 'error',

      // eslint-plugin-react-hooks v7 also ships the React Compiler diagnostics
      // (set-state-in-effect, purity, static-components, refs, use-memo, …).
      // Those describe a separate migration — ~120 pre-existing hits across the
      // app — and are unrelated to the stale-closure defects this config was
      // added to catch. Left as warnings so `npm run lint` stays actionable;
      // turning them into errors is its own piece of work.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/refs': 'warn',

      // TypeScript resolves every identifier already; core `no-undef` only
      // produces false positives on type-only and DOM lib globals here.
      'no-undef': 'off',

      // `_`-prefixed bindings are the established convention in this codebase
      // for intentionally-unused parameters (see messageStore reaction handlers).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],

      // `any` is caught by tsc's strict mode where it matters; the remaining
      // uses are deliberate gateway-payload escape hatches.
      '@typescript-eslint/no-explicit-any': 'off',
      // Interfaces that alias another type are used as extension points here.
      '@typescript-eslint/no-empty-object-type': 'off',

      // The static a11y audit (`npm run test:a11y:static`) is the enforcing gate
      // for these; jsx-a11y's versions duplicate it with different heuristics and
      // would double-report. Keep the ones it does NOT cover.
      'jsx-a11y/no-autofocus': 'off',
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
    },
  },
  {
    // Vitest/jsdom test files run in Node and use test globals.
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  {
    // Playwright harness scripts run under Node.
    files: ['e2e/**/*.{ts,mjs,js}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    // Web Workers have their own global scope.
    files: ['src/workers/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.worker,
      },
    },
  },
);
