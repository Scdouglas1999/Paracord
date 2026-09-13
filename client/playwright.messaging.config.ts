import { defineConfig, devices } from '@playwright/test';

/** Current production sources against the prebuilt real backend; no API fixtures. */
export default defineConfig({
  testDir: './e2e', testMatch: /(production-messaging|dm-attachment-confidentiality)\.spec\.ts$/, workers: 1, timeout: 90_000,
  expect: { timeout: 15_000 }, reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4174', trace: 'off', actionTimeout: 15_000, screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node ./e2e/messaging-server-harness.mjs', url: 'http://127.0.0.1:18161/ready', reuseExistingServer: false,
      env: { PARACORD_E2E_PORT: '18160', PARACORD_E2E_CONTROL_PORT: '18161', PARACORD_PUBLIC_URL: 'http://127.0.0.1:4174' }, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 }, stdout: 'pipe', stderr: 'pipe' },
    { command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort', url: 'http://127.0.0.1:4174', reuseExistingServer: false,
      env: { VITE_DEV_PROXY_TARGET: 'http://127.0.0.1:18160', VITE_DEV_HMR: 'false' }, stdout: 'ignore', stderr: 'pipe' },
  ],
});
