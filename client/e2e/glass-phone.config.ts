import { defineConfig, devices } from '@playwright/test';

/**
 * Its own config for the phone shots and checks (glass-phone.spec.ts, WP-G20),
 * on its own ports (4443/4445) so a run never lands on another package's dev
 * server. The dev server is glass-stage-dev.mjs (WP-G14's, which takes its port
 * as an argument).
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g20 npx playwright test -c e2e/glass-phone.config.ts
 */
const APP_PORT = process.env.PARACORD_E2E_PHONE_PORT ?? '4443';
const RT_PORT = process.env.PARACORD_E2E_PHONE_RT_PORT ?? '4445';

export default defineConfig({
  testDir: '.',
  testMatch: /[\\/]glass-phone\.spec\.ts$/,
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
      name: 'glass-phone',
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
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_PHONE_REUSE),
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'ignore',
      stderr: 'pipe',
      env: { PARACORD_E2E_RT_PORT: RT_PORT },
    },
    {
      command: `node ./e2e/glass-stage-dev.mjs ${APP_PORT}`,
      cwd: '..',
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_PHONE_REUSE),
      env: { VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${RT_PORT}`, VITE_DEV_HMR: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
