import js from '@eslint/js';
import n from 'eslint-plugin-n';
import prettierConfig from 'eslint-config-prettier';

export default [
  { ignores: ['dist/**', 'generated/**'] },
  {
    files: ['src/**/*.ts'],
    ...js.configs.recommended,
  },
  {
    files: ['src/**/*.ts'],
    ...n.configs['flat/recommended-module'],
  },
  prettierConfig,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      // TypeScript compiler handles import resolution for .ts-as-.js imports
      'n/no-missing-import': 'off',
    },
  },
];
