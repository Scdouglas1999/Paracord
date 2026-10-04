import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  CH,
  CLOCK,
  GUILD,
  channelRow,
  dockItem,
  installIndexScene,
  roomRow,
  roomRows,
  searchField,
  shoot,
  sidebar,
  sidebarHeader,
  type IndexHarness,
} from './fixtures/index';

/**
 * IX-5 (Sidebar): the server sidebar (docs/index-spec.md §4.1-4.7, §5.2, §5.3,
 * §5.20; docs/design/index-plan.md §3 IX-5), held against the reference's s0, s1,
 * s4 and s5 (index-compare reads the sidebar of each).
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-sidebar PARACORD_E2E_INDEX_PORT=4533 \
 *   PARACORD_E2E_INDEX_RT_PORT=4535 PARACORD_E2E_INDEX_WP=ix5 \
 *     npx playwright test -c e2e/index-review.config.ts
 *   node e2e/index-compare.mjs ix5
 *
 * Geometry below is what the prototype measures at 1x (paracord-index.html):
 * header 20-60 with the mark at x 18, search 74-108, a label 37 tall, channel rows
 * 51 tall on a 53 pitch, room rows 36. The main column and the room card are other
 * packages' (the Glass conversation and no card until IX-7), so shots are read for
 * the sidebar.
 */

const MOTION_GONE_MS = 2_000;

async function open(page: Page, route?: string): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page);
  await h.open(route ?? h.routes.channel('fuelGeneral'));
  await expect(sidebar(page)).toBeVisible();
  await expect(channelRow(page, 'fuelGeneral')).toBeVisible();
  return h;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const box = (locator: Locator): Promise<Box> =>
  locator.first().evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
  });

/** Every animation in the document: its id, and the transforms of its keyframes. */
const animations = (page: Page) =>
  page.evaluate(() =>
    document.getAnimations().map((animation) => ({
      id: animation.id,
      transforms: (animation.effect as KeyframeEffect | null)?.getKeyframes().map((frame) => frame.transform ?? null) ?? [],
      target: (animation.effect as KeyframeEffect | null)?.target instanceof Element ? ((animation.effect as KeyframeEffect).target as Element).className : '',
    })),
  );
const animationIds = async (page: Page) => (await animations(page)).map((animation) => animation.id).filter(Boolean);

test.describe('IX-5 sidebar', () => {
  test('s0: header, search, channels and rooms sit where the prototype puts them, and nothing moves at rest', async ({ page }) => {
    await open(page);
    const header = sidebarHeader(page);
    await expect(header).toContainText('Fuel');
    await expect(header).toContainText('1 member · 1 here now');
    // Header: the 40px mark at (18, 20); the "…" at the far side.
    expect(await box(header.locator('[data-server-mark]'))).toMatchObject({ x: 18, y: 20, width: 40, height: 40 });
    expect(await box(header.getByRole('button', { name: 'Server options' }))).toMatchObject({ x: 268, y: 25, width: 30, height: 30 });
    // Search: 292 wide at y 74, 34 tall; "Ctrl K" in a kbd.
    expect(await box(searchField(page))).toMatchObject({ x: 12, y: 74, width: 292, height: 34 });
    await expect(searchField(page)).toContainText('Search Fuel');
    await expect(searchField(page).locator('kbd')).toHaveText('Ctrl K');
    // Channels: a label 37 tall, then rows 51 tall on a 53 pitch, no `#`.
    await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
    expect(await box(page.locator('.ix-section-label').first())).toMatchObject({ x: 12, y: 112, height: 37 });
    for (const [key, top] of [['fuelGeneral', 149], ['fuelClips', 202], ['fuelPlans', 255]] as const) {
      expect(await box(channelRow(page, key))).toMatchObject({ x: 12, y: top, width: 292, height: 51 });
    }
    await expect(channelRow(page, 'fuelGeneral')).toContainText('No messages yet');
    await expect(channelRow(page, 'fuelClips')).toContainText('Share your best moments');
    await expect(channelRow(page, 'fuelPlans')).toContainText('Nothing planned yet');
    await expect(channelRow(page, 'fuelGeneral')).toHaveAttribute('aria-current', 'page');
    await expect(channelRow(page, 'fuelClips')).not.toHaveAttribute('aria-current', 'page');
    // The selection sits behind the open row: one element, moved by transform.
    const selection = page.locator('.ix-sel');
    await expect(selection).toHaveAttribute('data-on', 'true');
    expect(await box(selection)).toMatchObject({ x: 12, y: 149, width: 292, height: 51 });
    // Voice channels: both rooms are rows (nobody is in either), 36 tall.
    await expect(page.getByRole('heading', { name: 'Voice channels' })).toBeVisible();
    await expect(roomRows(page)).toHaveCount(2);
    expect(await box(roomRow(page, 'General'))).toMatchObject({ x: 12, y: 343, width: 292, height: 36 });
    expect(await box(roomRow(page, 'Late night'))).toMatchObject({ x: 12, y: 379, height: 36 });
    await expect(roomRow(page, 'General')).toContainText('Empty');
    // Quiet at rest (the frame's own `ix-` animations are none either).
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await animationIds(page)).filter((id) => id.startsWith('ix-'))).toEqual([]);
    await shoot(page, 's0-quiet');
  });

  test('s1: an arrival gives clips its dot and rolls the previews; the open channel never gets one', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await expect(channelRow(page, 'fuelClips')).toHaveAttribute('data-unread', 'true');
    // Both lines changed in this pane: a roll for each, from `translateY(9px)` (§5.3).
    await expect.poll(async () => (await animations(page)).filter((a) => a.id === 'ix-preview:line').length, { intervals: [25], timeout: 2_000 }).toBeGreaterThan(0);
    const roll = (await animations(page)).find((a) => a.id === 'ix-preview:line');
    expect(roll?.transforms[0]).toBe('translateY(9px)');
    // The newest line and its time; Jeremy's name, no `#`.
    await expect(channelRow(page, 'fuelGeneral')).toContainText(/Jeremy: who[’']s up for a run tonight\?/);
    await expect(channelRow(page, 'fuelGeneral')).toContainText('9:41 PM');
    await expect(channelRow(page, 'fuelClips')).toContainText('Jeremy posted a video');
    await expect(channelRow(page, 'fuelClips')).toContainText('9:42 PM');
    // The dot is a scale on a 6px circle at left -1 / top 15, ink.
    await page.waitForTimeout(700);
    const dot = channelRow(page, 'fuelClips').locator('.ix-ch__dot');
    expect(await box(dot)).toMatchObject({ x: 11, width: 6, height: 6 });
    expect(await dot.evaluate((element) => getComputedStyle(element).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
    await expect(channelRow(page, 'fuelGeneral')).not.toHaveAttribute('data-unread', 'true');
    // The state is in the row's name for a screen reader.
    await expect(channelRow(page, 'fuelClips')).toContainText(', unread');
    // The room with Jeremy in it is the live card's (IX-7), so it is not also a row.
    await expect(roomRows(page)).toHaveCount(1);
    await expect(roomRow(page, 'Late night')).toBeVisible();
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await animationIds(page)).filter((id) => id.startsWith('ix-'))).toEqual([]);
    await shoot(page, 's1-someone-arrives');
  });

  test('s4: another server, while still in Fuel’s call', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');
    await h.setClock(CLOCK.visit);
    await page.waitForTimeout(MOTION_GONE_MS);
    await dockItem(page, 'gameNight').click();
    // Mid-slide: two panes. The one sliding out keeps Fuel: inert, hidden, frozen on general.
    await expect.poll(async () => page.locator('.ix-pane').count(), { timeout: 3_000 }).toBe(2);
    const leaving = page.locator('.ix-pane[data-leaving="true"]');
    await expect(leaving).toHaveAttribute('inert', '');
    await expect(leaving).toHaveAttribute('aria-hidden', 'true');
    await expect(leaving.getByTestId('ix-sidebar-header')).toContainText('Fuel');
    await expect(leaving.getByTestId('ix-channel-row').filter({ hasText: 'general' })).toHaveAttribute('aria-current', 'page');
    // A pane that is sliding out plays nothing of its own.
    const inLeaving = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => /^ix-(preview|select|collapse)/.test(animation.id) && (animation.effect as KeyframeEffect).target instanceof Element && ((animation.effect as KeyframeEffect).target as Element).closest('.ix-pane[data-leaving]'))
        .map((animation) => animation.id),
    );
    expect(inLeaving).toEqual([]);
    await page.waitForTimeout(MOTION_GONE_MS);
    await expect(page.locator('.ix-pane')).toHaveCount(1);
    const header = sidebarHeader(page);
    await expect(header).toContainText('Game Night');
    await expect(header).toContainText('12 members · 5 here now');  // the prototype leaves you out of its 4; you are here too
    await expect(channelRow(page, 'gnLounge')).toHaveAttribute('aria-current', 'page');
    await expect(channelRow(page, 'gnLounge')).toContainText("Vincent: streaming in Lounge if anyone wants to watch");
    await expect(channelRow(page, 'gnLounge')).toContainText('8:58 PM');
    await expect(channelRow(page, 'gnLfg')).toHaveAttribute('data-unread', 'true');
    await expect(channelRow(page, 'gnLfg')).toContainText('Maya: need one for ranked');
    await expect(channelRow(page, 'gnScreenshots')).toContainText('Nick posted 4 photos');
    await expect(channelRow(page, 'gnScreenshots')).toContainText('Sat');
    // Lounge is the live card here; Ranked is the only room row.
    await expect(roomRows(page)).toHaveCount(1);
    await expect(roomRow(page, 'Ranked')).toBeVisible();
    await shoot(page, 's4-other-server');
  });

  test('s5: busy Fuel: Coming up appears, previews follow the newest line, rooms follow the card', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');
    await h.step('crowd');
    await h.step('busy', { pace: 0 });
    await expect(channelRow(page, 'fuelGeneral')).toContainText('Nick: yep, bringing the projector');
    await expect(channelRow(page, 'fuelGeneral')).toContainText('10:02 PM');
    await expect(channelRow(page, 'fuelPlans')).toContainText('Movie night · Fri 9 PM');
    await expect(channelRow(page, 'fuelPlans')).toHaveAttribute('data-unread', 'true');
    await expect(channelRow(page, 'fuelClips')).toHaveAttribute('data-unread', 'true');
    await expect(sidebarHeader(page)).toContainText('6 members · 6 here now');
    // Coming up: the event, a date tile, "Fri 9:00 PM · General".
    const coming = page.getByRole('heading', { name: 'Coming up' });
    await expect(coming).toBeVisible();
    const event = page.getByTestId('ix-event-row');
    await expect(event).toHaveCount(1);
    await expect(event).toContainText('Movie night');
    await expect(event).toContainText('Fri 9:00 PM · General');
    await expect(event.locator('.ix-ev__weekday')).toHaveText('Fri');
    await expect(event.locator('.ix-ev__day')).toHaveText('2');
    expect(await box(event.locator('.ix-ev__tile'))).toMatchObject({ width: 32, height: 36 });
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 's5-busy');
  });

  test('clicking a channel moves the selection by transform alone, 450ms spring, and opens it', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await page.waitForTimeout(MOTION_GONE_MS);
    await channelRow(page, 'fuelClips').click();
    await expect(page).toHaveURL(new RegExp(`/channels/${CH.fuelClips}$`));
    await expect(channelRow(page, 'fuelClips')).toHaveAttribute('aria-current', 'page');
    const glide = (await animations(page)).find((a) => a.id === 'ix-select:glide');
    expect(glide?.transforms).toEqual(['translateY(37px)', 'translateY(90px)']);
    const timing = await page.evaluate(() => {
      const animation = document.getAnimations().find((a) => a.id === 'ix-select:glide');
      const t = animation?.effect?.getTiming();
      return { duration: t?.duration, easing: t?.easing };
    });
    expect(timing).toEqual({ duration: 450, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    // Only transform moves: no animation of the selection touches another property.
    const properties = await page.evaluate(() => {
      const animation = document.getAnimations().find((a) => a.id === 'ix-select:glide');
      return [...new Set((animation?.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame).filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k))))];
    });
    expect(properties).toEqual(['transform']);
    await page.waitForTimeout(MOTION_GONE_MS);
    // 90px into the rows' own space (a 37px label, then two rows of 53), wherever the card above puts them.
    const rowsTop = (await box(page.locator('.ix-sb__rows'))).y;
    expect((await box(page.locator('.ix-sel'))).y - rowsTop).toBe(90);
    expect((await box(page.locator('.ix-sel'))).height).toBe(51);
    // Reading it cleared its dot: nothing of it is unread any more.
    await expect(channelRow(page, 'fuelClips')).not.toHaveAttribute('data-unread', 'true');
    expect((await animationIds(page)).filter((id) => id.startsWith('ix-'))).toEqual([]);
  });

  test('a room row joins on click, and right-click offers Listen in and Open chat', async ({ page }) => {
    const h = await open(page);
    await roomRow(page, 'Late night').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Context menu' });
    await expect(menu.getByRole('menuitem', { name: 'Listen in' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Open chat' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy link to channel' })).toBeVisible();
    await page.keyboard.press('Escape');
    await roomRow(page, 'Late night').click();
    await expect.poll(() => page.evaluate(async () => ((await import('/src/stores/voiceStore.ts' as string)) as any).useVoiceStore.getState().channelId)).toBe(CH.fuelRoomLateNight);
    // Joining never navigates.
    await expect(page).toHaveURL(new RegExp(`/channels/${CH.fuelGeneral}$`));
    void h;
  });

  test('right-click on a channel: notification levels, mark read, copy link, and the owner’s Edit and Delete', async ({ page }) => {
    await open(page);
    await channelRow(page, 'fuelClips').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Context menu' });
    for (const name of ['Every message', 'Mark channel as read', 'Copy link to channel', 'Edit channel', 'Delete channel']) {
      await expect(menu.getByRole('menuitem', { name }).or(menu.getByRole('menuitemradio', { name }))).toBeVisible();
    }
    await page.keyboard.press('Escape');
  });

  test('the header opens Overview, "…" and a right-click open the server menu, the field opens the quick switcher', async ({ page }) => {
    await open(page);
    await sidebarHeader(page).getByRole('button', { name: /Fuel overview/ }).click();
    await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD.fuel.id}$`));
    await expect(sidebarHeader(page).getByRole('button', { name: /Fuel overview/ })).toHaveAttribute('aria-current', 'page');
    await sidebarHeader(page).getByRole('button', { name: 'Server options' }).click();
    const menu = page.getByRole('menu', { name: 'Fuel menu' });
    await expect(menu.getByRole('menuitem', { name: 'Mute server' })).toBeVisible();
    await page.keyboard.press('Escape');
    await sidebarHeader(page).click({ button: 'right', position: { x: 120, y: 20 } });
    await expect(page.getByRole('menu', { name: 'Fuel menu' })).toBeVisible();
    await page.keyboard.press('Escape');
    await searchField(page).click();
    await expect(page.getByRole('dialog').getByRole('combobox').or(page.getByPlaceholder(/search/i)).first()).toBeVisible();
  });

  test('keyboard: the rows are one Tab stop; the arrow keys move, Enter opens', async ({ page }) => {
    await open(page);
    await searchField(page).focus();
    // The "+" at the label's right (you may create channels here) is a stop of its own, shown on focus.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Create a channel in Channels' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(channelRow(page, 'fuelGeneral')).toBeFocused();
    // One stop: every other row is out of the Tab order.
    expect(await page.locator('[data-place-row][tabindex="0"]').count()).toBe(1);
    await page.keyboard.press('ArrowDown');
    await expect(channelRow(page, 'fuelClips')).toBeFocused();
    await page.keyboard.press('End');
    await expect(roomRow(page, 'Late night')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(channelRow(page, 'fuelGeneral')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(roomRow(page, 'Late night')).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/channels/${CH.fuelClips}$`));
    // Shift+Tab leaves the list for the "+", then the search field.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Create a channel in Channels' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(searchField(page)).toBeFocused();
  });

  test('categories: sentence-case labels, a closed one keeps its unread rows, and the rest moves up (§5.20)', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await page.evaluate(
      async ({ guildId, clips, plans }) => {
        const channels = (await import('/src/stores/channelStore.ts' as string)) as any;
        const guilds = (await import('/src/stores/guildStore.ts' as string)) as any;
        const guild = guilds.useGuildStore.getState().guilds.find((entry: any) => entry.id === guildId);
        const store = channels.useChannelStore;
        const existing = store.getState().channelsByGuild[guild.key] as any[];
        const category = { id: '999000000000000001', type: 4, guild_id: guildId, name: 'TEXT CHANNELS', position: 1, nsfw: false, created_at: new Date().toISOString() };
        store.getState().addChannel(category, guild.scope);
        for (const id of [clips, plans]) {
          store.getState().updateChannel({ ...existing.find((entry) => entry.id === id), parent_id: category.id }, guild.scope);
        }
      },
      { guildId: GUILD.fuel.id, clips: CH.fuelClips, plans: CH.fuelPlans },
    );
    // "general" is loose under "Channels"; the other two are under the category, in sentence case.
    await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
    const category = page.getByRole('heading', { name: 'Text channels' });
    await expect(category).toBeVisible();
    await page.waitForTimeout(MOTION_GONE_MS);
    const fold = category.getByRole('button', { name: 'Text channels' });
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    const roomsBefore = await box(page.getByRole('heading', { name: 'Voice channels' }));
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    // clips is unread (kept); plans is not (gone).
    await expect(channelRow(page, 'fuelClips')).toBeVisible();
    await expect(channelRow(page, 'fuelPlans')).toHaveCount(0);
    // The rest of the sidebar FLIPs up; the rows that left fade (150ms): a ghost, not the real row.
    const ids = await animationIds(page);
    expect(ids).toContain('ix-collapse:move');
    expect(ids).toContain('ix-collapse:fade');
    await page.waitForTimeout(MOTION_GONE_MS);
    const roomsAfter = await box(page.getByRole('heading', { name: 'Voice channels' }));
    expect(roomsAfter.y).toBe(roomsBefore.y - 53);
    expect((await animationIds(page)).filter((id) => id.startsWith('ix-'))).toEqual([]);
    expect(await page.locator('.ix-sb__ghosts > *').count()).toBe(0);
    // Open again.
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(channelRow(page, 'fuelPlans')).toBeVisible();
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await box(page.getByRole('heading', { name: 'Voice channels' }))).y).toBe(roomsBefore.y);
  });

  test('sizes: 1440x900, narrow 900x700 and the phone root', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await shoot(page, 's1-someone-arrives', { size: 'desktop' });
    await shoot(page, 's1-someone-arrives', { size: 'narrow' });
    expect((await box(sidebar(page))).width).toBe(280);
    await shoot(page, 's1-someone-arrives', { size: 'phone' });
    // The phone's root screen is the sidebar (IX-4 puts the toolbar's back button there; IX-16 finishes the phone).
    await page.getByRole('button', { name: 'Back to the sidebar' }).first().click();
    await expect(channelRow(page, 'fuelClips')).toBeInViewport();
    await shoot(page, 's1-someone-arrives-root', { size: 'phone' });
  });
});

