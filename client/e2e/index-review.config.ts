import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * The Index review config (docs/design/index-plan.md §3): the one config every
 * Index package runs its own spec through, on its own ports, so a run never
 * lands on another package's dev server.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-smoke \
 *   PARACORD_E2E_INDEX_PORT=4513 PARACORD_E2E_INDEX_RT_PORT=4515 \
 *   PARACORD_E2E_INDEX_WP=ix0 \
 *   npx playwright test -c e2e/index-review.config.ts
 *
 * Environment (all optional; ports default to IX-0's pair, §5.2):
 *
 *   PARACORD_E2E_INDEX_SPEC    which spec: `index-sidebar`, `index-sidebar.spec.ts`
 *                              or a path to it. Unset: every `e2e/index-*.spec.ts`.
 *   PARACORD_E2E_INDEX_PORT    the Vite dev server (default 4513)
 *   PARACORD_E2E_INDEX_RT_PORT the realtime stub (default 4515; use PORT + 2)
 *   PARACORD_E2E_INDEX_WP      the package label: shots land in
 *                              output/design-reference/index-build/<WP>/ (default `latest`)
 *   PARACORD_E2E_INDEX_REUSE   reuse servers that are already up (a long session)
 *
 * The scene itself is `e2e/fixtures/index` (installIndexScene). The page's
 * timezone is the scene's (America/Chicago), its clock is pinned by the
 * harness, and the default viewport is the reference's 1280x800 at exactly 1x:
 * a shot at that size is held against `output/design-reference/index/ref/`.
 */
const APP_PORT = process.env.PARACORD_E2E_INDEX_PORT ?? '4513';
const RT_PORT = process.env.PARACORD_E2E_INDEX_RT_PORT ?? '4515';
const REUSE = Boolean(process.env.PARACORD_E2E_INDEX_REUSE);

function testMatch(): RegExp {
  const spec = process.env.PARACORD_E2E_INDEX_SPEC;
  if (!spec) return /[\\/]index-[\w-]+\.spec\.ts$/;
  const name = path.basename(spec).replace(/\.spec\.ts$/, '').replace(/\.ts$/, '');
  return new RegExp(`[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.spec\\.ts$`);
}

export default defineConfig({
  testDir: '.',
  testMatch: testMatch(),
  fullyParallel: false,
  workers: 1,
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
      name: 'index-review',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        // Headless Linux Chromium rounds every glyph advance to a whole pixel;
        // a real window positions glyphs on subpixels, so the shots do too (the
        // reference renders are shot the same way).
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
