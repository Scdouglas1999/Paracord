import { defineConfig, devices } from '@playwright/test';

// Two mutually exclusive E2E modes, selected by PARACORD_E2E_REAL:
//
//   unset  -> fast mocked smoke (smoke.spec.ts) against `npm run dev`. Every
//             /api call is intercepted with page.route, so it never touches a
//             real server. This is the fast CI gate; `npm run test:e2e` runs it.
//
//   "1"    -> real-server smoke (real-server.smoke.spec.ts) against the actual
//             release paracord-server binary (launched by
//             e2e/real-server-harness.mjs) serving the embedded UI + a throwaway
//             SQLite DB. Run with:
//               PARACORD_E2E_REAL=1 npx playwright test
//
// Gating the `projects` array (not just testMatch) guarantees the default
// mocked invocation never runs the real-server project or triggers the heavier
// real-server webServer.
const REAL_SERVER = process.env.PARACORD_E2E_REAL === '1';
const REAL_SERVER_PORT = process.env.PARACORD_E2E_PORT ?? '18150';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: REAL_SERVER ? `http://127.0.0.1:${REAL_SERVER_PORT}` : 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: REAL_SERVER
    ? [
        {
          name: 'real-server',
          testMatch: /real-server\.smoke\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : [
        {
          name: 'chromium',
          // Anchor so this never picks up real-server.smoke.spec.ts.
          testMatch: /[\\/]smoke\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'] },
        },
      ],
  webServer: REAL_SERVER
    ? {
        command: 'node ./e2e/real-server-harness.mjs',
        url: `http://127.0.0.1:${REAL_SERVER_PORT}/health`,
        // Launching the prebuilt binary + running migrations is fast, but give
        // headroom for a cold CI runner.
        timeout: 180_000,
        reuseExistingServer: false,
        // Default teardown is SIGKILL, which would skip the harness's temp-dir
        // cleanup; ask for SIGTERM first so it can remove its SQLite data dir.
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PARACORD_E2E_PORT: REAL_SERVER_PORT },
      }
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
