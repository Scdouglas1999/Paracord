import { defineConfig, devices } from '@playwright/test';

/**
 * Its own config for the sheets and menus shots (glass-sheets.spec.ts, WP-G18):
 * the default config's projects only name the specs they know, and this package
 * may add a new file but not edit playwright.config.ts. Ports are its own so a
 * run never lands on another checkout's dev server.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g18 npx playwright test -c e2e/glass-sheets.config.ts
 */
const APP_PORT = process.env.PARACORD_E2E_SH_PORT ?? '4383';
const RT_PORT = process.env.PARACORD_E2E_SH_RT_PORT ?? '4385';

export default defineConfig({
  testDir: '.',
  // PARACORD_E2E_SH_MATCH points the same servers at another spec, so the smoke
  // and auth-fit gates can run here without touching the default ports.
  testMatch: new RegExp(process.env.PARACORD_E2E_SH_MATCH ?? '[\\\\/]glass-sheets\\.spec\\.ts$'),
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
      name: 'glass-sheets',
      use: {
        ...devices['Desktop Chrome'],
        // Headless Linux Chromium rounds every glyph advance to a whole pixel
        // (font hinting), which closes the 3.4px word space of 13px Instrument
        // Sans to 3px and makes body copy read "panels anda clear". A real
        // window positions glyphs on subpixels; this makes the shots do the same.
        launchOptions: { args: ['--font-render-hinting=none'] },
      },
    },
  ],
  webServer: [
    {
      command: 'node ./e2e/realtime-stub.mjs',
      cwd: '..',
      url: `http://127.0.0.1:${RT_PORT}/health`,
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_SH_REUSE),
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'ignore',
      stderr: 'pipe',
      env: { PARACORD_E2E_RT_PORT: RT_PORT },
    },
    {
      // Vite through its API (e2e/glass-sheets-dev.mjs): a process that is not named
      // "vite" survives another checkout's `pkill -f vite`.
      command: `node ./e2e/glass-sheets-dev.mjs ${APP_PORT}`,
      cwd: '..',
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_SH_REUSE),
      env: { VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${RT_PORT}`, VITE_DEV_HMR: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
