import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Heavy jsdom integration tests (e.g. EmojiPicker mounts ~1300 emoji
    // buttons, ~1.6s even in isolation) run under ~8x CPU oversubscription in
    // the full parallel suite, which starves their async waitFor/findBy polling.
    // The 5s default per-test timeout is too tight for that contention; 20s
    // keeps genuine hangs bounded while giving real work room to finish.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Each test worker owns a Vite transform pipeline and a jsdom instance.
    // Running one per logical CPU exhausts memory and leaves worker processes
    // alive long after the last assertion on CI and developer laptops. Keep a
    // small, fixed pool so the release gate is deterministic rather than
    // depending on the host's reported CPU count.
    maxWorkers: 4,
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
