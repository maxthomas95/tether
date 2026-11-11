import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

// Local mirror of the SonarQube Cloud JS/TS analysis (see docs/SONAR.md).
// Sonar only analyzes files outside sonar.exclusions, so tests, mocks and the
// renderer bootstrap stay out of scope here too.
const SONAR_EXCLUDED = [
  'src/**/*.test.ts',
  'src/**/*.test-helper.ts',
  'src/**/__mocks__/**',
  'src/renderer/index.tsx',
];

// Rules that have failed Tether's quality gate on new code (security hotspots
// and reliability bugs) are errors. Every other recommended Sonar rule is a
// warning: SonarQube Cloud grandfathers existing findings through its new-code
// period, which ESLint cannot express, and some type-aware rules report false
// positives that the server analysis does not.
const SONAR_GATE_RULES = [
  'code-eval', // S1523
  'no-alphabetical-sort', // S2871
  'no-clear-text-protocols', // S5332
  'no-hardcoded-ip', // S1313
  'no-hardcoded-passwords', // S2068
  'no-os-command-from-path', // S4036
  'os-command', // S4721
  'publicly-writable-directories', // S5443
  'slow-regex', // S5852
];
const sonarRules = Object.fromEntries(
  Object.entries(sonarjs.configs.recommended.rules)
    .map(([id, level]) => [id, level === 'off' ? 'off' : 'warn']),
);
for (const name of SONAR_GATE_RULES) {
  if (!sonarjs.rules[name]) throw new Error(`Unknown sonarjs rule: ${name}`);
  sonarRules[`sonarjs/${name}`] = 'error';
}

export default tseslint.config(
  {
    ignores: [
      '.vite/**',
      'dist/**',
      'mcp-servers/**',
      'node_modules/**',
      'out/**',
      'releases/**',
    ],
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        DOCS_WINDOW_VITE_DEV_SERVER_URL: 'readonly',
        DOCS_WINDOW_VITE_NAME: 'readonly',
        MAIN_WINDOW_VITE_DEV_SERVER_URL: 'readonly',
        MAIN_WINDOW_VITE_NAME: 'readonly',
        __APP_VERSION__: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: SONAR_EXCLUDED,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { sonarjs },
    rules: sonarRules,
  },
);
