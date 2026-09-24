import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '.claude/**',
      'scripts/**',
      '**/scripts/**',
      // 打包垫片：这些文件是**打进 asar 之后由别的模块 require 的**（CommonJS、
      // 内容要跟上游 v2 的原文逐字一致），不是本仓的源码模块。内容由
      // `packages/desktop/test/readable-stream-shim-packaging-gate.test.ts` 钉住。
      'packages/desktop/packaging-shims/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['packages/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Renderer code must go through preload and window.clawwork instead of importing Electron directly.',
            },
            {
              name: 'ws',
              message: 'Renderer code must not open raw Gateway sockets.',
            },
            {
              name: 'fs',
              message: 'Renderer code must not access the filesystem directly.',
            },
            {
              name: 'fs/promises',
              message: 'Renderer code must not access the filesystem directly.',
            },
            {
              name: 'path',
              message: 'Renderer code must not resolve filesystem paths directly.',
            },
            {
              name: 'child_process',
              message: 'Renderer code must not spawn system processes directly.',
            },
          ],
          patterns: [
            {
              group: ['node:*'],
              message: 'Renderer code must not import Node builtins. Use main/preload boundaries.',
            },
            {
              group: ['../main/**', '../../main/**', '../../../main/**', '../../../../main/**'],
              message: 'Renderer code must not import main-process modules directly.',
            },
          ],
        },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['website/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'packages/desktop/src/main/**/*.{ts,tsx}',
      'packages/desktop/src/preload/**/*.{ts,tsx}',
      'packages/shared/src/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  eslintConfigPrettier,
);
