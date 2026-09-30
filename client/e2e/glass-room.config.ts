import { defineConfig, devices } from '@playwright/test';

/**
 * The room light's own review run (glass-room.spec.ts, WP-G8): shots of the
 * stream-lit and banner-lit rooms and the server-switch crossfade, plus the
 * write-rate and paint-rate budget measured in a real Chromium. Its own ports,
 * so a run never lands on another checkout's dev server.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g8 npx playwright test -c e2e/glass-room.config.ts
 */
const APP_PORT = process.env.PARACORD_E2E_ROOM_PORT ?? '4393';
const RT_PORT = process.env.PARACORD_E2E_ROOM_RT_PORT ?? '4395';

export default defineConfig({
  testDir: '.',
  testMatch: new RegExp(process.env.PARACORD_E2E_ROOM_MATCH ?? "[\\\\/]glass-room\\.spec\\.ts$"),
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
  projects: [{ name: 'glass-room', use: { ...devices['Desktop Chrome'] } }],
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
