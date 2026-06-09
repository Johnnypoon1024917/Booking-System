// ESLint config for the backend (AUD-024). The lint script existed but eslint
// and its config were never installed, so `npm run lint` failed. This restores a
// working code-quality gate that CI runs.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: false, // type-aware linting off for speed; flip on with tsconfig if desired
    sourceType: 'module',
    ecmaVersion: 2022,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'eslint-config-prettier',
  ],
  env: { node: true, jest: true, es2022: true },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.js', '*.cjs'],
  rules: {
    // The codebase intentionally uses `any` in a few integration/DTO seams;
    // keep these as warnings so the gate is useful without a noisy failing wall.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
  },
};
