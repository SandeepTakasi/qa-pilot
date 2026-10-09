// QA-Pilot spec lint. Commit this at the ROOT of your repo (ESLint resolves `files` against
// the config file's directory, so it cannot live in the plugin checkout). Dev dependencies:
// eslint@9, eslint-plugin-playwright, typescript-eslint and typescript.
//
// It catches what a reviewer skims past: a test with no assertion, a fixed sleep, a skipped
// or focused test. Keep assertions in the test body: a helper that holds the only expect()
// hides it from `expect-expect`.
import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';

const recommended = playwright.configs['flat/recommended'];

export default [{
  ...recommended,
  // EDIT: one `<spec_dir>/**/*.spec.ts` glob per app, from your profile's spec_dir. A glob
  // that matches nothing makes ESLint exit 2, so list only directories that exist.
  files: ['e2e/**/*.spec.ts'],
  // Keep the parser after the spread of languageOptions: reversed, TypeScript specs fail to parse.
  languageOptions: { ...recommended.languageOptions, parser: tseslint.parser },
  rules: {
    ...recommended.rules,
    'playwright/expect-expect': 'error',
    'playwright/no-wait-for-timeout': 'error',
    'playwright/no-skipped-test': 'error',
    'playwright/no-focused-test': 'error',
    'playwright/consistent-spacing-between-blocks': 'off',
  },
}];
