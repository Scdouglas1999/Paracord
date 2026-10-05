import { expect, test } from '@playwright/test';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  GUILD,
  REFERENCE_DIR,
  REFERENCE_STATES,
  SIZES,
  callView,
  composer,
  dockItem,
  installIndexScene,
  outDir,
  roomCard,
  roomCards,
  shoot,
  sidebar,
  title,
  toolbar,
  walkStates,
  welcome,
  type ReferenceState,
} from './fixtures/index';

/**
 * The review walk (docs/design/index-plan.md §3, IX-19): the prototype's whole
 * evening, on the mocked Index scene, with every one of the ten reference
 * states reached the way a person reaches it and shot at the reference's size
 * (1280x800 at exactly 1x). It is the one spec that proves the states exist
 * and are reachable in order; the per-surface Index specs (`index-sidebar`,
 * `index-card`, `index-call`, ...) hold each surface's numbers.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-review PARACORD_E2E_INDEX_PORT=4713 \
 *   PARACORD_E2E_INDEX_RT_PORT=4715 PARACORD_E2E_INDEX_WP=review \
 *     npx playwright test -c e2e/index-review.config.ts
 *   node e2e/index-compare.mjs review     # side by side with the references
 *
 * Each shot is held to what the state is about (a few facts the reference shows)
 * and to the reference's own pixel size. The pictures themselves are read, or
 * compared with `index-compare.mjs`, not diffed here: the references are local
 * renders (`output/` is not committed), so a CI run has none to hold them to.
 */

/** The width and height a PNG says it is (its IHDR chunk). */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('every reference state is reached in the prototype\'s order, and shot at the reference size', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize(SIZES.reference);
  const h = await installIndexScene(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mkdir(outDir(), { recursive: true });

  const visited: ReferenceState[] = [];
  const facts: Record<ReferenceState, () => Promise<void>> = {
    // Fuel, new and empty: the welcome with its action cards.
    's0-quiet': async () => {
      await expect(title(page)).toHaveText('general');
      await expect(welcome(page)).toBeVisible();
      await expect(roomCards(page)).toHaveCount(0);
    },
    // Plan a night drafts an event card in the conversation, to be posted.
    's0-plan-a-night': async () => {
      await expect(page.getByTestId('ix-draft-event')).toBeVisible();
      await expect(page.getByTestId('ix-draft-event').getByRole('button', { name: 'Post it' })).toBeVisible();
    },
    // Typing opens the message box.
    's0-message-box-open': async () => {
      await expect(composer(page)).toHaveAttribute('data-ix-composer-open', 'true');
    },
    // Jeremy arrives and talks in General: the live card, and a live dot on Fuel's mark.
    's1-someone-arrives': async () => {
      await expect(roomCard(page, 'live')).toBeVisible();
      await expect(roomCard(page, 'live')).toContainText('General');
      await expect(dockItem(page, 'fuel')).toHaveAttribute('aria-current', 'page');
    },
    // You joined: the card is yours.
    's2-joined': async () => {
      await expect(roomCard(page, 'yours')).toBeVisible();
      await expect(roomCard(page, 'yours').getByTestId('ix-card-leave')).toBeVisible();
    },
    // Open call: the call view over main.
    's3-call-open': async () => {
      await expect(callView(page)).toBeVisible();
      await expect(callView(page).getByTestId('ix-call-back')).toBeVisible();
    },
    // Game Night while you are in the call: your call pinned at the top of its sidebar.
    's4-other-server': async () => {
      await expect(dockItem(page, 'gameNight')).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('[data-testid="ix-room-card"][data-position="pinned"]')).toBeVisible();
    },
    // Fuel, busy: five in the call and the conversation full of messages.
    's5-busy': async () => {
      await expect(dockItem(page, 'fuel')).toHaveAttribute('aria-current', 'page');
      await expect(roomCard(page, 'yours')).toBeVisible();
      await expect(page.locator('.ix-tl-col').first()).toBeVisible();
    },
    // Scrolled: the large title has folded into the toolbar.
    's5-busy-title-folded': async () => {
      await expect(toolbar(page)).toHaveAttribute('data-folded', 'true');
    },
    // People: the People place, Friends and Inbox above the messages.
    's6-people': async () => {
      await expect(dockItem(page, 'people')).toHaveAttribute('aria-current', 'page');
      await expect(sidebar(page)).toContainText('Messages');
    },
  };

  await walkStates(h, {
    visit: async (state) => {
      visited.push(state);
      await facts[state]();
      const file = await shoot(page, state);
      expect(await pngSize(file), `${state} is shot at the reference size`).toEqual(SIZES.reference);
      // A shot that is blank or all one color is not a state.
      expect((await stat(file)).size, `${state} is not blank`).toBeGreaterThan(20_000);
    },
  });

  expect(visited, 'all ten states, in order').toEqual([...REFERENCE_STATES]);
  expect(errors, 'uncaught errors in the page').toEqual([]);
  // The harness's own check on the cast: Fuel is the server the whole walk is about.
  expect(GUILD.fuel.id).toBeTruthy();

  // The references are local renders: where they exist, the shots must be the same size.
  for (const state of REFERENCE_STATES) {
    const reference = path.join(REFERENCE_DIR, `${state}.png`);
    if (!(await stat(reference).then(() => true, () => false))) continue;
    expect(await pngSize(path.join(outDir(), `${state}.png`)), `${state} against ${reference}`).toEqual(await pngSize(reference));
  }
});
