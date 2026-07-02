import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    coverage: {
      // Uses the already-installed @vitest/coverage-v8 provider.
      provider: 'v8',
      // Ratchet floors: set a few points BELOW the coverage measured at the time
      // this gate was added (stmts 42.66 / branch 34.94 / funcs 41.35 / lines 43.65).
      // These are a regression backstop, NOT a target — raise them over time as
      // coverage improves; never lower them to make a red build pass.
      thresholds: {
        statements: 38,
        branches: 30,
        functions: 37,
        lines: 40,
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
