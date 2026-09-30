import { defineConfig, devices } from '@playwright/test';

/**
 * Its own config for WP-G22's call shots (glass-calls.spec.ts: a voice
 * channel's chat and pill, the call itself on the stage, a DM call), on its own
 * ports (4463/4465) so a run never lands on another package's dev server.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g22 npx playwright test -c e2e/glass-calls.config.ts
 */
const APP_PORT = process.env.PARACORD_E2E_CALLS_PORT ?? '4463';
const RT_PORT = process.env.PARACORD_E2E_CALLS_RT_PORT ?? '4465';

export default defineConfig({
  testDir: '.',
  testMatch: /[\\/]glass-calls\.spec\.ts$/,
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
      name: 'glass-calls',
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
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_CALLS_REUSE),
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'ignore',
      stderr: 'pipe',
      env: { PARACORD_E2E_RT_PORT: RT_PORT },
    },
    {
      command: `node ./e2e/glass-stage-dev.mjs ${APP_PORT}`,
      cwd: '..',
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_CALLS_REUSE),
      env: { VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${RT_PORT}`, VITE_DEV_HMR: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
