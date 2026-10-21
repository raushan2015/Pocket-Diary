import expo from 'eslint-config-expo/flat.js';

export default [
  ...expo,
  {
    ignores: ['dist/**', 'node_modules/**', '.expo/**', 'coverage/**', 'scripts/**'],
  },
];
