// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Guardrails enforced here (see docs/ARCHITECTURE.md):
 *
 *  §3  purity boundary  — care-engine and routine-learning may not read the
 *                         clock, use randomness, or perform I/O.
 *  §5  MV3 lifecycle    — extension background code may not use setTimeout /
 *                         setInterval; all scheduling goes through chrome.alarms.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // --- Purity boundary: care-engine + routine-learning -----------------------
  {
    files: ['packages/care-engine/**/*.ts', 'packages/routine-learning/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            'Pure package: the current time is an input on CareContext, never read here. See docs/ARCHITECTURE.md §3.',
        },
        {
          name: 'fetch',
          message: 'Pure package: no I/O. See docs/ARCHITECTURE.md §3.',
        },
        {
          name: 'process',
          message: 'Pure package: no environment access. See docs/ARCHITECTURE.md §3.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'Pure package: no randomness. Inject a selector instead. See docs/ARCHITECTURE.md §3.',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'Pure package: the current time is an input, never constructed here. See docs/ARCHITECTURE.md §3.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'http', 'https', 'pg', 'postgres', '@supabase/*'],
              message: 'Pure package: no I/O imports. See docs/ARCHITECTURE.md §3.',
            },
          ],
        },
      ],
    },
  },

  // --- MV3 lifecycle: extension background code ------------------------------
  {
    files: [
      'apps/extension/**/background/**/*.ts',
      'apps/extension/**/background/**/*.tsx',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'setTimeout',
          message:
            'MV3 terminates idle service workers; pending timers die with them. Use chrome.alarms. See docs/ARCHITECTURE.md §5.3.',
        },
        {
          name: 'setInterval',
          message:
            'MV3 terminates idle service workers; pending timers die with them. Use chrome.alarms. See docs/ARCHITECTURE.md §5.3.',
        },
      ],
    },
  },

  // --- Build / CI scripts ----------------------------------------------------
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    rules: {
      // These scripts report their result on stdout; that is their job.
      'no-console': 'off',
    },
  },

  // --- Tests -----------------------------------------------------------------
  {
    files: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  prettier,
);
