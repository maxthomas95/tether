import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'html'],
      // Include untested application code so the baseline is representative.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-helper.ts', 'src/**/__mocks__/**', 'src/**/*.d.ts'],
    },
    alias: {
      '@shared': '/src/shared',
    },
  },
});
