import { defineConfig, devices } from '@playwright/test';

/**
 * The DM attachment confidentiality spec on its own harness ports.
 *
 * Identical in kind to `playwright.messaging.config.ts` — the same real release
 * server, no API fixtures — but on 18170/18171 and Vite 4176 so it can run while
 * the shared messaging gate is occupied. The spec itself is part of that gate;
 * this config exists to run it in isolation.
 */
// The spec reads these to find the isolated harness; set them for the test
// workers here so the config is self-contained.
process.env.PARACORD_E2E_PORT ??= '18170';
process.env.PARACORD_E2E_CONTROL_PORT ??= '18171';
process.env.PARACORD_E2E_APP_ORIGIN ??= 'http://127.0.0.1:4176';

export default defineConfig({
  // Generous timeouts: this config exists to run beside other work on the same
  // machine, where a cold Vite dev server competes for CPU.
  testDir: './e2e', testMatch: /dm-attachment-confidentiality\.spec\.ts$/, workers: 1, timeout: 300_000,
  expect: { timeout: 45_000 }, reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4176', trace: 'off', actionTimeout: 45_000, screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node ./e2e/messaging-server-harness.mjs', url: 'http://127.0.0.1:18171/ready', reuseExistingServer: false,
      // A second server cannot share the default native-media UDP port, and the
      // server refuses to boot without a working voice endpoint.
      env: { PARACORD_E2E_PORT: '18170', PARACORD_E2E_CONTROL_PORT: '18171', PARACORD_PUBLIC_URL: 'http://127.0.0.1:4176',
        PARACORD_VOICE_PORT: '18172' },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 }, stdout: 'pipe', stderr: 'pipe' },
    { command: 'npm run dev -- --host 127.0.0.1 --port 4176 --strictPort', url: 'http://127.0.0.1:4176', reuseExistingServer: false,
      env: { VITE_DEV_PROXY_TARGET: 'http://127.0.0.1:18170' }, stdout: 'ignore', stderr: 'pipe' },
  ],
});
