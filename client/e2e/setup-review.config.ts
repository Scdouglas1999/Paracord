import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * The first-run review config (docs/design/setup-plan.md S13a): the one config
 * every first-run package runs its own spec through, on its own ports, so a run
 * never lands on another package's dev server.
 *
 *   cd client
 *   npx playwright test -c e2e/setup-review.config.ts            # every e2e/setup-*.spec.ts
 *   PARACORD_E2E_SETUP_SPEC=setup-harness \
 *   PARACORD_E2E_SETUP_PORT=4993 PARACORD_E2E_SETUP_RT_PORT=4995 \
 *   PARACORD_E2E_SETUP_WP=s13a \
 *   npx playwright test -c e2e/setup-review.config.ts
 *
 * Environment (all optional; ports default to S13a's pair, plan 5.2):
 *
 *   PARACORD_E2E_SETUP_SPEC    which spec: `setup-harness`, `setup-harness.spec.ts` or a path to it.
 *                              Unset: every `e2e/setup-*.spec.ts`.
 *   PARACORD_E2E_SETUP_PORT    the Vite dev server (default 4993)
 *   PARACORD_E2E_SETUP_RT_PORT the realtime stub (default 4995; use PORT + 2)
 *   PARACORD_E2E_SETUP_WP      the package label: shots land in
 *                              output/design-reference/setup-build/<WP>/ (default `latest`)
 *   PARACORD_E2E_SETUP_REUSE   reuse servers that are already up (a long session)
 *
 * The scene is `e2e/fixtures/setup` (installSetupScene). The viewport is the
 * reference's 1280x800 at exactly 1x, so a shot is held against
 * `output/design-reference/setup/ref/` with `node e2e/setup-compare.mjs <WP>`.
 * Spec files must not be named `real-server.*` (those run on the real-server config).
 */
const APP_PORT = process.env.PARACORD_E2E_SETUP_PORT ?? '4993';
const RT_PORT = process.env.PARACORD_E2E_SETUP_RT_PORT ?? '4995';
const REUSE = Boolean(process.env.PARACORD_E2E_SETUP_REUSE);

function testMatch(): RegExp {
  const spec = process.env.PARACORD_E2E_SETUP_SPEC;
  if (!spec) return /[\\/]setup-[\w-]+\.spec\.ts$/;
  const name = path.basename(spec).replace(/\.spec\.ts$/, '').replace(/\.ts$/, '');
  return new RegExp(`[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.spec\\.ts$`);
}

export default defineConfig({
  testDir: '.',
  testMatch: testMatch(),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
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
      name: 'setup-review',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        // The references are shot with unrounded glyph advances (see setup-reference.mjs).
        launchOptions: { args: ['--font-render-hinting=none'] },
      },
    },
  ],
  webServer: [
    {
      command: 'node ./e2e/realtime-stub.mjs',
      cwd: '..',
      url: `http://127.0.0.1:${RT_PORT}/health`,
      reuseExistingServer: REUSE,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'ignore',
      stderr: 'pipe',
      env: { PARACORD_E2E_RT_PORT: RT_PORT },
    },
    {
      command: `node ./e2e/index-dev.mjs ${APP_PORT}`,
      cwd: '..',
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: REUSE,
      env: { VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${RT_PORT}`, VITE_DEV_HMR: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
