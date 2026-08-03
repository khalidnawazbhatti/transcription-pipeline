import js from '@eslint/js';
import n from 'eslint-plugin-n';
import prettierConfig from 'eslint-config-prettier';

// typescript-eslint does not support TS 7 yet — use `npm run typecheck` for .ts files.
// ESLint here covers root-level JS config files only.
export default [
  { ignores: ['dist/**', 'generated/**', 'src/**'] },
  js.configs.recommended,
  n.configs['flat/recommended-module'],
  prettierConfig,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      // Config files import devDependencies by design
      'n/no-unpublished-import': 'off',
    },
  },
];
