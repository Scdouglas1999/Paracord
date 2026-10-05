import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  GUILD,
  composerInput,
  installIndexScene,
  outDir,
  sidebar,
  toolbar,
  type IndexHarness,
} from './fixtures/index';
import { HISTORY_EPOCH } from './fixtures/index/world';

/**
 * What survives a window resize (docs/index-spec.md §3 "Widths", §9). Dragging
 * the window across the phone breakpoint (768px) swaps the frame's layout; it
 * must not rebuild it. The dialog a person has open, the half-typed message in
 * the box and the sheet over main all ride through, in the window's own frame.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-continuity PARACORD_E2E_INDEX_PORT=4713 \
 *   PARACORD_E2E_INDEX_RT_PORT=4715 PARACORD_E2E_INDEX_WP=ix19 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * (The Glass spec this replaces, `glass-polish-2`, held the same promise for the
 * Glass frame.) Shots land in output/design-reference/index-build/<WP>/ with the
 * prefix `resize-` and are read, not diffed.
 */

const WIDE = { width: 1000, height: 800 };
const PHONE = { width: 700, height: 800 };

const pageErrors = new WeakMap<Page, string[]>();

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

async function open(page: Page): Promise<IndexHarness> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize(WIDE);
  const h = await installIndexScene(page);
  await h.open(h.routes.channel('gnLounge'));
  await expect(sidebar(page)).toBeVisible();
  return h;
}

const json = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    // The messaging runtime checks the history epoch on every message response.
    headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
    body: JSON.stringify(body),
  });

const LINE = 'bring the good guns this time';

/** A shot at whatever size the window is now (the harness's `shoot` sets its own size). */
async function shot(page: Page, name: string): Promise<void> {
  await mkdir(outDir(), { recursive: true });
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
  const view = page.viewportSize()!;
  await page.screenshot({ path: path.join(outDir(), `${name}@${view.width}x${view.height}.png`) });
}

/** Settle the swap: layout attribute flipped, the frame's own animations done. */
async function resizeTo(page: Page, size: { width: number; height: number }, layout: 'wide' | 'narrow' | 'phone') {
  await page.setViewportSize(size);
  await expect(page.locator('.ix-frame')).toHaveAttribute('data-layout', layout);
  await page.waitForTimeout(500);
}

test('a window resized across the phone breakpoint keeps its dialog and its draft', async ({ page }) => {
  test.setTimeout(120_000);
  const h = await open(page);
  const target = h.world.messagesIn('gnLounge').find((m: { content: string }) => m.content === LINE)!;
  await page.route('**/api/v1/channels/*/messages/*/edits', (route) =>
    json(route, [
      { id: 'e1', message_id: target.id, content: 'bring the good guns', edited_at: '2026-10-01T20:52:10-05:00' },
      { id: 'e2', message_id: target.id, content: LINE, edited_at: '2026-10-01T20:53:40-05:00' },
    ]),
  );
  // Somebody edited it: the gateway says so, and the message wears "edited".
  await h.emit({
    op: 0,
    t: 'MESSAGE_UPDATE',
    d: {
      ...h.world.revisedMessageRecord(target),
      guild_id: GUILD.gameNight.id,
      edited_timestamp: '2026-10-01T20:53:40-05:00',
      message_revision: String(Number(target.revision) + 1),
    },
  });

  const row = page.locator('[role="article"]', { hasText: LINE }).last();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Show the edit history/ }).click();
  const history = page.getByRole('dialog', { name: 'Edit history' });
  await expect(history).toBeVisible();
  await expect(history.getByText(/Version 2/)).toBeVisible();

  // A draft in the box. Mark the frame's nodes: a rebuilt frame is a different node.
  await composerInput(page).fill('half a thought');
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__frame = document.querySelector('.ix-frame');
    w.__main = document.getElementById('main-content');
  });
  await shot(page, 'resize-1-wide-dialog');

  // Across the breakpoint to a phone and back, twice.
  for (const [size, layout] of [
    [PHONE, 'phone'],
    [WIDE, 'narrow'],
    [PHONE, 'phone'],
    [WIDE, 'narrow'],
  ] as const) {
    await resizeTo(page, size, layout);
    expect(
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return {
          sameFrame: w.__frame === document.querySelector('.ix-frame'),
          sameMain: w.__main === document.getElementById('main-content'),
        };
      }),
      `${layout}: the frame was not rebuilt`,
    ).toEqual({ sameFrame: true, sameMain: true });
    await expect(history, `${layout}: the dialog is still open`).toBeVisible();
    await expect(history.getByText(/Version 2/), `${layout}: with its history`).toBeVisible();
    await expect(composerInput(page), `${layout}: the draft is still in the box`).toHaveValue('half a thought');
    if (layout === 'phone') await shot(page, 'resize-2-phone-dialog');
  }
  await shot(page, 'resize-3-wide-again-dialog');
});

test('a sheet stays open across the swap, in the window\'s own frame', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await toolbar(page).getByRole('button', { name: 'Members' }).click();
  const sheet = page.getByRole('dialog', { name: 'Members' });
  await expect(sheet).toBeVisible();
  // Over main, in the pane the toolbar belongs to.
  await expect(sheet).toHaveAttribute('data-host', 'pane');

  await page.setViewportSize(PHONE);
  await expect(page.locator('.ix-frame')).toHaveAttribute('data-layout', 'phone');
  // On a phone the sheet is the whole screen: the window's frame, not main's.
  await expect(page.getByRole('dialog', { name: 'Members' })).toHaveAttribute('data-host', 'window');
  await page.waitForTimeout(600);
  await shot(page, 'resize-4-sheet-phone');

  await page.setViewportSize(WIDE);
  await expect(page.getByRole('dialog', { name: 'Members' })).toHaveAttribute('data-host', 'pane');
  await page.waitForTimeout(600);
  await shot(page, 'resize-5-sheet-wide');
});
