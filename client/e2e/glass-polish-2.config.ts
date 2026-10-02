import { defineConfig, devices } from '@playwright/test';

/**
 * Its own config for the glass-polish-2 shots and checks (glass-polish-2.spec.ts: the
 * call pill over sheets, the camera crop anchor, the call with no cameras, reactions for
 * screen readers, resizing across the phone breakpoint), on its own ports (4483/4485) so
 * a run never lands on another package's dev server.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=polish-2 npx playwright test -c e2e/glass-polish-2.config.ts
 */
const APP_PORT = process.env.PARACORD_E2E_P2_PORT ?? '4483';
const RT_PORT = process.env.PARACORD_E2E_P2_RT_PORT ?? '4485';

export default defineConfig({
  testDir: '.',
  testMatch: /[\\/]glass-polish-2\.spec\.ts$/,
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
      name: 'glass-polish-2',
      use: {
        ...devices['Desktop Chrome'],
        // Headless Linux Chromium rounds every glyph advance to a whole pixel; a real
        // window positions glyphs on subpixels, so the shots do too.
        launchOptions: { args: ['--font-render-hinting=none'] },
      },
    },
  ],
  webServer: [
    {
      command: 'node ./e2e/realtime-stub.mjs',
      cwd: '..',
      url: `http://127.0.0.1:${RT_PORT}/health`,
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_P2_REUSE),
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
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_P2_REUSE),
      env: { VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${RT_PORT}`, VITE_DEV_HMR: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
