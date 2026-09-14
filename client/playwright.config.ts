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
// Design-review screenshots (design-review.spec.ts): opt-in, mocked like the
// smoke, output under output/design-reference/<WP>/. Gated out of the default
// run so the CI smoke stays fast. See docs/lantern-stage-spec.md §10.
const DESIGN_REVIEW = !REAL_SERVER && process.env.PARACORD_E2E_DESIGN === '1';
// The motion gate (motion-gate.spec.ts): opt-in, mocked like the smoke. It
// samples requestAnimationFrame across each signature moment and fails a frame
// over 32ms or an animation over 500ms (docs/lantern-stage-spec.md §5.3).
// Gated out of the default run: it deliberately sits and watches frames, which
// is the opposite of what a fast CI smoke should do. `npm run test:motion`.
const MOTION_GATE = !REAL_SERVER && !DESIGN_REVIEW && process.env.PARACORD_E2E_MOTION === '1';
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
          testMatch: /real-server(?:\.smoke|\.voice-check|\.voice-join|\.realtime-hold|-restore|-setup)\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : MOTION_GATE
    ? [
        {
          name: 'motion-gate',
          testMatch: /[\\/]motion-gate\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : DESIGN_REVIEW
    ? [
        {
          name: 'design-review',
          testMatch: /[\\/]design-review\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : [
        {
          name: 'encrypted-storage',
          testMatch: /(?:encrypted-storage|durable-dm|durable-delivery|delivered-mutations|messaging-runtime|prekey-enrollment|identity-setup)\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'] },
        },
        {
          name: 'chromium',
          // Anchor so this never picks up real-server.smoke.spec.ts.
          testMatch: /[\\/]smoke\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'] },
        },
        {
          // The fit gate for the first-run and account screens: a native window
          // does not scroll. Its own project because it drives its viewport
          // per-assertion rather than inheriting one.
          name: 'auth-fit',
          testMatch: /[\\/]auth-fit\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'] },
        },
        {
          name: 'chromium-touch',
          testMatch: /[\\/]smoke\.spec\.ts$/,
          use: { ...devices['Desktop Chrome'], hasTouch: true },
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
        env: {
          PARACORD_E2E_PORT: REAL_SERVER_PORT,
          // Forwarded so the voice connection-check spec can move the native
          // media UDP listener off the product default (see the harness).
          ...(process.env.PARACORD_E2E_MEDIA_PORT
            ? { PARACORD_E2E_MEDIA_PORT: process.env.PARACORD_E2E_MEDIA_PORT }
            : {}),
        },
      }
    : [
        // A real, persistent SSE stream: an intercepted stream always ends with
        // its fulfilled response, which would leave the client reconnecting and
        // its message runtime permanently between authenticated handshakes.
        {
          command: 'node ./e2e/realtime-stub.mjs',
          url: 'http://127.0.0.1:4175/health',
          reuseExistingServer: false,
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
          stdout: 'ignore',
          stderr: 'pipe',
        },
        {
          command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
          url: 'http://127.0.0.1:4173',
          reuseExistingServer: !process.env.CI,
          env: { VITE_DEV_PROXY_TARGET: 'http://127.0.0.1:4175', VITE_DEV_HMR: 'false' },
          stdout: 'ignore',
          stderr: 'pipe',
        },
      ],
});
