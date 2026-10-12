/**
 * `installSetupScene(page)`: the first-run review scene behind a Playwright
 * page, with no server, no Tauri and no network.
 *
 *   - desktop (default): the Tauri host commands are stubbed (`tauriHost.ts`)
 *     with scripted preflight, setup progress and reachability;
 *   - web (`desktop: false`): no Tauri at all, as in a browser;
 *   - `GET /api/v1/invites/{code}` answers the scripted previews (`invites.ts`);
 *   - every other /api call gets a 404 and is recorded in `unhandled`, so a
 *     screen that needs an answer the scene does not have fails loudly instead
 *     of showing a half-working state.
 *
 *   const scene = await installSetupScene(page, { reach: 'refused', clipboard: inviteUrl('Rf8kQ2') });
 *   await page.goto('/');
 *
 * Call before the first `page.goto`. Routes are last-wins, so a spec may add
 * its own `page.route` after it. Use a fresh browser context per test: first
 * run's "launch already seen" flag lives in localStorage.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { installInviteRoutes } from './invites';
import { CLOCK } from './scene';
import { installTauriHost, type TauriHost, type TauriHostOptions } from './tauriHost';

export interface SetupSceneOptions extends TauriHostOptions {
  /** The desktop app (default) or a plain browser. */
  desktop?: boolean;
  /** Where the scene's clock starts. Default `CLOCK.start`. */
  clock?: string;
  /** `prefers-reduced-motion`: first run plays no launch and shows the still welcome (spec 1.2). */
  reducedMotion?: boolean;
}

export class SetupScene {
  /** `null` on the web. */
  readonly host: TauriHost | null;
  /** Every /api call no scene route answered: `"GET /api/v1/..."`. */
  readonly unhandled: string[] = [];

  constructor(
    readonly page: Page,
    host: TauriHost | null,
  ) {
    this.host = host;
  }

  /** Throws if the app asked for an API answer or a Tauri command the scene does not have. */
  expectNothingUnhandled(): void {
    const stubs = this.host ? [...this.host.unstubbed] : [];
    if (this.unhandled.length === 0 && stubs.length === 0) return;
    throw new Error(`The first-run scene had no answer for: ${[...this.unhandled, ...stubs.map((s) => `Tauri ${s}`)].join(', ')}`);
  }

  /** A 1280x800 shot into `output/design-reference/setup-build/<WP>/<name>.png`, the shape `setup-compare.mjs` reads. */
  async shoot(name: string): Promise<string> {
    const file = join(BUILD_DIR(), `${name}.png`);
    mkdirSync(dirname(file), { recursive: true });
    const size = this.page.viewportSize();
    if (!size || size.width !== 1280 || size.height !== 800) throw new Error(`a reference shot is 1280x800, the viewport is ${size ? `${size.width}x${size.height}` : 'unset'}`);
    await this.page.screenshot({ path: file, animations: 'allow', caret: 'hide' });
    return file;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = (): string => join(HERE, '..', '..', '..', '..', 'output', 'design-reference', 'setup-build', process.env.PARACORD_E2E_SETUP_WP ?? 'latest');

export async function installSetupScene(page: Page, options: SetupSceneOptions = {}): Promise<SetupScene> {
  await page.clock.setFixedTime(Date.parse(options.clock ?? CLOCK.start));
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });

  const host = options.desktop === false ? null : await installTauriHost(page, options);
  const scene = new SetupScene(page, host);

  // Playwright runs the LAST matching route: the 404 fallback goes in first, the scene's answers after it.
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    scene.unhandled.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'not_found', message: 'No such route in the first-run scene' }) });
  });
  await page.route('**/health', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok","service":"paracord"}' }));
  // What the account step asks a server before there is an account (spec 1.6): nothing required.
  await page.route('**/api/v1/auth/options', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ require_email: false, registration_mode: 'open' }) }),
  );
  await installInviteRoutes(page, (m, p) => scene.unhandled.push(`${m} ${p}`));
  return scene;
}
