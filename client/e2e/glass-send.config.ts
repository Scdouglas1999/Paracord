import { defineConfig, devices } from '@playwright/test';

/**
 * Its own config for the send flight (glass-send.spec.ts): the message floating
 * out of the message box into the conversation, filmed frame by frame on the
 * mocked Glass scene. Its own ports (4491/4493), so a run never lands on another
 * checkout's dev server.
 *
 *   cd client
 *   npx playwright test -c e2e/glass-send.config.ts
 *
 * Frames land in output/design-reference/glass-build/send/ (or wherever
 * PARACORD_E2E_SEND_FRAMES points).
 */
const APP_PORT = process.env.PARACORD_E2E_SEND_PORT ?? '4491';
const RT_PORT = process.env.PARACORD_E2E_SEND_RT_PORT ?? '4493';

export default defineConfig({
  testDir: '.',
  testMatch: /[\\/]glass-send\.spec\.ts$/,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: 'off',
    // PARACORD_E2E_SEND_VIDEO=1 records every run at the window's own size, for
    // looking at a hand-off in real time (frames out with ffmpeg).
    video: process.env.PARACORD_E2E_SEND_VIDEO ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off',
    timezoneId: 'America/Chicago',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'glass-send',
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
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_SEND_REUSE),
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'ignore',
      stderr: 'pipe',
      env: { PARACORD_E2E_RT_PORT: RT_PORT },
    },
    {
      // Vite through its API (e2e/glass-send-dev.mjs): a process that is not named
      // "vite" survives another checkout's `pkill -f vite`.
      command: `node ./e2e/glass-send-dev.mjs ${APP_PORT}`,
      cwd: '..',
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: Boolean(process.env.PARACORD_E2E_SEND_REUSE),
      env: { VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${RT_PORT}`, VITE_DEV_HMR: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
