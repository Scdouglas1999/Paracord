import { defineConfig, devices } from '@playwright/test';

/**
 * Its own config for the pages that render inside the conversation pane
 * (glass-pages.spec.ts, WP-G19): Home, a direct message, Friends, a server's
 * Overview and a forum. The default config's projects only name the specs they
 * know, and this package may add a file but not edit playwright.config.ts.
 * Ports are its own so a run never lands on another checkout's dev server.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g19 npx playwright test -c e2e/glass-pages.config.ts
 */
const APP_PORT = process.env.PARACORD_E2E_PG_PORT ?? '4383';
const RT_PORT = process.env.PARACORD_E2E_PG_RT_PORT ?? '4385';

export default defineConfig({
  testDir: '.',
  testMatch: new RegExp(process.env.PARACORD_E2E_PG_MATCH ?? '[\\\\/]glass-pages\\.spec\\.ts$'),
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: 'off',
    timezoneId: 'America/Chicago',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'glass-pages',
      use: {
        ...devices['Desktop Chrome'],
        // Whole-pixel glyph advances close a 13px word space in headless
        // Chromium; a real window positions glyphs on subpixels.
        launchOptions: { args: ['--font-render-hinting=none'] },
      },
    },
  ],
  webServer: [
    {
      command: 'node ./e2e/realtime-stub.mjs',
      cwd: '..',
      url: `http://127.0.0.1:${RT_PORT}/health`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'ignore',
      stderr: 'pipe',
      env: { PARACORD_E2E_RT_PORT: RT_PORT },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
      cwd: '..',
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: false,
      env: { VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${RT_PORT}`, VITE_DEV_HMR: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
