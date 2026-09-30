import { defineConfig, devices } from '@playwright/test';

/**
 * Its own config for the call pill shots (glass-pill.spec.ts, WP-G12): the
 * default config's projects only name the specs they know, and this package may
 * add a new file but not edit playwright.config.ts. Ports are its own so a run
 * never lands on another checkout's dev server.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g12 npx playwright test -c e2e/glass-pill.config.ts
 */
const APP_PORT = process.env.PARACORD_E2E_PILL_PORT ?? '4413';
const RT_PORT = process.env.PARACORD_E2E_PILL_RT_PORT ?? '4415';

export default defineConfig({
  testDir: '.',
  testMatch: /[\\/]glass-pill\.spec\.ts$/,
  fullyParallel: false,
  timeout: 90_000,
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
      name: 'glass-pill',
      use: {
        ...devices['Desktop Chrome'],
        // Headless Linux Chromium rounds every glyph advance to a whole pixel;
        // a real window positions glyphs on subpixels, so the shots do too.
        launchOptions: { args: ['--font-render-hinting=none'] },
      },
    },
  ],
  webServer: [
    {
      command: 'node ./e2e/realtime-stub.mjs',
      cwd: '..',
      url: `http://127.0.0.1:${RT_PORT}/health`,
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_PILL_REUSE),
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'ignore',
      stderr: 'pipe',
      env: { PARACORD_E2E_RT_PORT: RT_PORT },
    },
    {
      command: `node ./e2e/glass-pill-dev.mjs ${APP_PORT}`,
      cwd: '..',
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_PILL_REUSE),
      env: { VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${RT_PORT}`, VITE_DEV_HMR: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
