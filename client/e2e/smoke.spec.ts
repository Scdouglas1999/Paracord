import { expect, test as base, type Page } from '@playwright/test';
import { THEME_IDS } from '../src/lib/themes';
import {
  ATTENTION_CHANNEL_ID,
  ATTENTION_CHANNEL_NAME,
  COMPOSER_PLACEHOLDER,
  GUILD_ID,
  GUILD_NAME,
  TEXT_CHANNEL_ID,
  TEXT_CHANNEL_NAME,
  VOICE_CHANNEL_ID,
  VOICE_CHANNEL_NAME,
  fitsWidth,
  installSmokeApp,
  literal,
  type SmokeApp,
} from './fixtures/smokeApp';

/**
 * The default mocked CI gate: `npm run test:e2e` runs this against `npm run dev`
 * with every `/api` call intercepted (fixtures/smokeApp.ts), in desktop Chromium
 * and again with touch. It is the Index product walked the way a person walks it
 * (docs/index-spec.md §3, §4, §9):
 *
 *   - the account signs in through a session refresh, the contract-checked
 *     payloads load, and the sidebar, the dock and the conversation appear;
 *   - the toolbar (search, members, your face), the large title that opens the
 *     channel menu, and the sheets they open;
 *   - the message box, on every width, through a revoked permission;
 *   - a voice channel's row joins it, and its call opens as the call view;
 *   - the server's Overview, People, Friends, direct messages, the quick switcher;
 *   - on a phone the sidebar is the root screen and a conversation is pushed on it.
 *
 * Nothing here needs a media relay: the call view's streams are proved by the
 * Index review specs (`e2e/index-call.spec.ts`) and the real-server voice specs.
 * What a call does when a join is refused is here, because it is the path a
 * mocked page can actually reach. Every test ends by asserting the page raised
 * no uncaught error.
 */
const test = base.extend<{ app: SmokeApp }>({
  // `auto`: a test that never names `app` still runs in the mocked world. A
  // lazy fixture would leave it with no mocks at all, on the login page.
  app: [
    async ({ page }, use) => {
      const app = await installSmokeApp(page);
      await use(app);
      expect(app.pageErrors, 'the page raised an uncaught error').toEqual([]);
    },
    { auto: true },
  ],
});

const textChannelUrl = `/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`;

/** The window sizes the product has to fit, by the layout each one gets (§3). */
const PHONE_WIDTHS = [320, 375, 414] as const;
const NARROW_WIDTHS = [768, 900, 1023] as const;
const DESKTOPS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

const layoutOf = (page: Page) => page.locator('.ix-frame').getAttribute('data-layout');

const sidebarOf = (page: Page) => page.getByTestId('ix-sidebar');
const dockOf = (page: Page) => page.getByTestId('ix-dock');
const toolbarOf = (page: Page) => page.getByTestId('ix-toolbar');
const titleOf = (page: Page) => page.getByTestId('ix-title');
const composerOf = (page: Page) => page.getByTestId('ix-composer').getByRole('textbox');
const channelRow = (page: Page, name: string) => page.getByTestId('ix-channel-row').filter({ hasText: name });
const roomRow = (page: Page, name: string) => page.getByTestId('ix-room-row').filter({ hasText: name });
const roomCard = (page: Page, state?: string) =>
  state ? page.locator(`[data-testid="ix-room-card"][data-state="${state}"]`) : page.getByTestId('ix-room-card');
const dockItem = (page: Page, place: string) => dockOf(page).locator(`[data-testid="ix-dock-item"][data-place="${place}"]`);

test('signs in by refresh, serves contract-valid payloads, and opens the server', async ({ page, app }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(textChannelUrl);
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`));
  await expect(page.locator('.ix-frame')).toHaveAttribute('data-layout', 'wide');

  // The sidebar: the server's header, its search field, the channels and the voice channels.
  await expect(sidebarOf(page)).toBeVisible();
  const header = page.getByTestId('ix-sidebar-header');
  await expect(header.getByRole('button', { name: literal(`${GUILD_NAME} overview`) })).toContainText('4 members');
  await expect(page.getByTestId('ix-search-field')).toBeVisible();

  // The dock: People first, then the server (the one you are in), then Add a server.
  await expect(dockOf(page).getByRole('button', { name: 'People' })).toBeVisible();
  await expect(dockItem(page, GUILD_ID)).toHaveAttribute('aria-current', 'page');
  await expect(dockOf(page).getByRole('button', { name: 'Add a server' })).toBeVisible();

  // Channel rows show what is in them (no `#`): the newest message, by whom, and when.
  const general = channelRow(page, TEXT_CHANNEL_NAME);
  await expect(general).toHaveAttribute('aria-current', 'page');
  await expect(general).toContainText('Ada: Kickoff is at nine, bring a chair.');
  await expect(channelRow(page, ATTENTION_CHANNEL_NAME)).toContainText('An update waiting for you.');
  await expect(roomRow(page, VOICE_CHANNEL_NAME)).toContainText('Empty');

  // The conversation: the large title (the channel's name) with the server's line, the
  // toolbar's tools, the feed and the message box.
  await expect(page.getByRole('main')).toBeVisible();
  await expect(titleOf(page)).toHaveText(TEXT_CHANNEL_NAME);
  await expect(toolbarOf(page).getByRole('button', { name: 'Search messages' })).toBeVisible();
  await expect(toolbarOf(page).getByRole('button', { name: 'Members', exact: true })).toBeVisible();
  await expect(toolbarOf(page).getByRole('button', { name: 'Your account' })).toBeVisible();
  await expect(page.getByLabel('Message history')).toBeVisible();
  await expect(composerOf(page)).toBeVisible();

  // Nothing is live and nobody is in a call: no room card is drawn.
  await expect(roomCard(page)).toHaveCount(0);

  // The guild list came through the generated contract validators, and they ran.
  expect(app.validated.guildList).toBeGreaterThan(0);
});

test('an empty conversation says it is ready and offers a first step; Say hello fills the box and never sends', async ({ page, app }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(textChannelUrl);
  const welcome = page.getByTestId('ix-welcome');
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole('heading', { name: literal(`${TEXT_CHANNEL_NAME} is ready`) })).toBeVisible();
  await welcome.getByRole('button', { name: /^Say hello/ }).click();
  await expect(composerOf(page)).toBeFocused();
  await expect(composerOf(page)).not.toHaveValue('');
  // It fills the draft; the person sends it.
  expect(app.messages).toHaveLength(0);
});

test('fits every window, phone to wide desktop, with the layout each one gets', async ({ page }) => {
  await page.goto(textChannelUrl);

  // Phone (< 768): the sidebar is the root screen and main is pushed over it.
  for (const width of PHONE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('main')).toBeVisible();
    await expect.poll(() => layoutOf(page)).toBe('phone');
    await expect(toolbarOf(page).getByRole('button', { name: 'Back to the sidebar' })).toBeVisible();
    await expect(composerOf(page)).toBeVisible();
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }

  // Narrow (768 to 1023): both columns, the sidebar at 280, nothing to open.
  for (const width of NARROW_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => layoutOf(page)).toBe('narrow');
    await expect(sidebarOf(page)).toBeVisible();
    await expect.poll(async () => (await sidebarOf(page).boundingBox())?.width).toBe(280);
    await expect(toolbarOf(page).getByRole('button', { name: 'Back to the sidebar' })).toHaveCount(0);
    await expect(composerOf(page)).toBeVisible();
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }

  // Wide (1024 and up): both columns, the sidebar at 316.
  for (const viewport of DESKTOPS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => layoutOf(page)).toBe('wide');
    await expect(page.getByRole('main')).toBeVisible();
    await expect.poll(async () => (await sidebarOf(page).boundingBox())?.width).toBe(316);
    await expect(dockOf(page)).toBeVisible();
    await expect(composerOf(page)).toBeVisible();
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }
});

test('phone: the sidebar is the root screen, and a pushed conversation goes back to it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(textChannelUrl);
  const frame = page.locator('.ix-frame');
  // A deep link opens on the conversation; the screen behind it is inert.
  await expect(frame).toHaveAttribute('data-screen', 'conversation');

  await toolbarOf(page).getByRole('button', { name: 'Back to the sidebar' }).click();
  await expect(frame).toHaveAttribute('data-screen', 'places');
  // The root screen: the server, its channels, the dock as a bar at the foot, full width.
  await expect(page.getByTestId('ix-sidebar-header')).toBeVisible();
  await expect(channelRow(page, ATTENTION_CHANNEL_NAME)).toBeVisible();
  await expect(dockOf(page)).toBeInViewport();
  await expect.poll(() => fitsWidth(page)).toBe(true);

  // Picking a row pushes that conversation.
  await channelRow(page, ATTENTION_CHANNEL_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${ATTENTION_CHANNEL_ID}$`));
  await expect(frame).toHaveAttribute('data-screen', 'conversation');
  await expect(titleOf(page)).toHaveText(ATTENTION_CHANNEL_NAME);
  await expect(composerOf(page).or(page.getByRole('textbox', { name: `Message ${ATTENTION_CHANNEL_NAME}` }))).toBeVisible();
});

test('every lazy route loads and fits, and the admin page stays shut to a member', async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  // `/app` is not a page: with nothing remembered it opens your first server's landing channel.
  await page.goto('/app');
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/`));
  await expect(page.getByRole('main')).toBeVisible();

  const routes = [
    { path: '/app/friends', title: 'Friends' },
    { path: '/app/inbox', title: 'Inbox' },
    { path: '/app/discovery', title: 'Discover' },
    { path: '/app/templates', text: /Template Gallery/i },
    { path: '/app/developers', text: /Developer portal/i },
  ];
  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.getByRole('main')).toBeVisible();
    if (route.title) await expect(titleOf(page)).toHaveText(route.title);
    if (route.text) await expect(page.getByText(route.text).first()).toBeVisible();
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }

  await page.goto('/app/admin');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(app.adminStatsRequests).toBe(0);
});

test('every theme the client knows loads, and a retired one opens Glass', async ({ page, app }) => {
  // One page, reloaded once per theme: seven themes in one long test would be
  // past the suite's budget on a CI runner, so this one is only the themes.
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  // `src/lib/themes.ts` is the list, so a theme added there is exercised here
  // without editing this array.
  for (const theme of THEME_IDS) {
    app.serverTheme = theme;
    await page.goto(textChannelUrl);
    await expect(page.getByRole('main')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }

  // An account whose stored theme is one of the retired looks opens the default
  // theme, and nothing refuses it; high contrast opens the contrast theme (the
  // stored ids are kept, docs/index-spec.md §13.14).
  app.serverTheme = 'paper';
  await page.goto(textChannelUrl);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass');
  app.serverTheme = 'high-contrast';
  await page.goto(textChannelUrl);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass-contrast');
  app.serverTheme = 'glass';
  await page.goto(textChannelUrl);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass');
});

test('the toolbar and the title: the title opens the channel menu; search, members and your face open sheets and menus', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto(textChannelUrl);

  for (const width of [320, 390, 767, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const phone = width < 768;
    await expect.poll(() => layoutOf(page)).toBe(phone ? 'phone' : width < 1024 ? 'narrow' : 'wide');
    await expect(titleOf(page)).toBeVisible();
    await expect(toolbarOf(page).getByRole('button', { name: 'Search messages' })).toBeInViewport();
    await expect(toolbarOf(page).getByRole('button', { name: 'Members', exact: true })).toBeInViewport();
    // On a phone your face is on the root screen's header, not the toolbar.
    await expect(toolbarOf(page).getByRole('button', { name: 'Your account' })).toHaveCount(phone ? 0 : 1);
    // No docked member list anywhere; members is a sheet.
    await expect(page.getByRole('complementary', { name: /members/i })).toHaveCount(0);

    // The title opens the channel menu; Escape closes it and gives focus back.
    await page.getByRole('button', { name: TEXT_CHANNEL_NAME }).first().click();
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Pinned messages/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Leaderboard/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // A row of the menu opens its page in a sheet next to the conversation, and closing it gives focus back.
    await page.getByRole('button', { name: TEXT_CHANNEL_NAME }).first().click();
    await page.getByRole('menuitem', { name: /Pinned messages/ }).click();
    const pins = page.getByRole('dialog', { name: /Pinned messages|Channel/ }).first();
    await expect(pins).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
    if (width === 1280) await page.screenshot({ path: testInfo.outputPath('toolbar-pins-sheet-desktop.png') });
    await page.keyboard.press('Escape');
    await expect(pins).toBeHidden();

    // Search and members.
    const search = toolbarOf(page).getByRole('button', { name: 'Search messages' });
    await search.click();
    const searchSheet = page.getByRole('dialog', { name: 'Search messages' });
    await expect(searchSheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(searchSheet).toBeHidden();
    await expect(search).toBeFocused();

    const members = toolbarOf(page).getByRole('button', { name: 'Members', exact: true });
    await members.click();
    const membersSheet = page.getByRole('dialog', { name: 'Members' });
    await expect(membersSheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(membersSheet).toBeHidden();
    await expect(members).toBeFocused();

    // Your face opens the account menu.
    if (!phone) {
      const face = toolbarOf(page).getByRole('button', { name: 'Your account' });
      await face.click();
      const account = page.getByRole('menu', { name: 'Account' });
      await expect(account).toBeVisible();
      await expect(account.getByRole('menuitem', { name: /^Settings/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(account).toBeHidden();
    }
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }
});

test('attention: what needs you is said in words on the channel row and as a count', async ({ page, app }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const attention of ['unread', 'mentions', 'read'] as const) {
    app.headerAttention = attention;
    await page.goto(textChannelUrl);
    const row = channelRow(page, ATTENTION_CHANNEL_NAME);
    await expect(row).toBeVisible();
    // The state is in the accessible name after the channel's name, and in the row's attributes.
    if (attention === 'read') {
      await expect(row).not.toHaveAttribute('data-unread', /.*/);
      await expect(row).not.toHaveAttribute('data-mentions', /.*/);
    } else {
      await expect(row).toHaveAttribute('data-unread', 'true');
      await expect(row.getByText(/unread/)).toBeAttached();
    }
    if (attention === 'mentions') {
      await expect(row).toHaveAttribute('data-mentions', 'true');
      await expect(row.getByText(/3 mentions/)).toBeAttached();
      await expect(row.locator('.ix-ch__mention')).toHaveText('3');
      await page.screenshot({ path: testInfo.outputPath('attention-mentions-desktop.png') });
    }
  }
});

test('direct messages: the People place lists them, and the toolbar keeps search, the call and the people, at every width', async ({ page, app }, testInfo) => {
  test.setTimeout(90_000);
  app.showDmFixtures = true;
  for (const dm of app.dmFixtures) {
    await page.goto(`/app/dms/${dm.id}`);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(titleOf(page)).toBeVisible();
    if (dm.type === 1) {
      await expect(dockItem(page, 'people')).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('ix-dm-row').first()).toBeVisible();
    }
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      if (width < 768) await expect(toolbarOf(page).getByRole('button', { name: 'Back to the sidebar' })).toBeVisible();
      await expect(toolbarOf(page).getByRole('button', { name: 'Search messages' })).toBeInViewport();
      await expect(toolbarOf(page).getByRole('button', { name: 'People in this message' })).toBeInViewport();
      if (dm.type === 1) {
        await expect(toolbarOf(page).getByRole('button', { name: /call/i })).toBeInViewport();
      }
      // A long title is bounded inside the page on a narrow screen, never pushed off it.
      await expect(titleOf(page)).toBeVisible();
      await expect.poll(() => fitsWidth(page)).toBe(true);
      if (width === 390) await page.screenshot({ path: testInfo.outputPath(`dm-${dm.type}-mobile.png`) });
    }
    // The people of a message or a group are a sheet, never a docked list.
    await page.setViewportSize({ width: 1280, height: 800 });
    await toolbarOf(page).getByRole('button', { name: 'People in this message' }).click();
    await expect(page.getByRole('dialog', { name: 'People in this message' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'People in this message' })).toBeHidden();
  }
});

test('the message box keeps a draft, bounds a long one, sends, and obeys a revoked permission', async ({ page, app }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto(textChannelUrl);
  const composer = composerOf(page);

  // A draft survives at every width, and the box stays a usable width.
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(composer).toBeVisible();
    await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
    await composer.fill('A draft that remains intact while the window changes.');
    await expect(composer).toHaveValue('A draft that remains intact while the window changes.');
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('composer-390.png') });
  }

  // A reduced visual viewport represents the room available above an open
  // on-screen keyboard. Long drafts must stay bounded and leave send visible.
  await page.setViewportSize({ width: 390, height: 420 });
  await composer.fill('A multiline draft\n'.repeat(30));
  await expect.poll(async () => (await composer.boundingBox())?.height ?? 0).toBeLessThanOrEqual(190);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();

  // Zoomed to 200% the box is still a usable width; then a message goes out and lands.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await composer.fill('e2e smoke message');
  await composer.press('Enter');
  const history = page.getByLabel('Message history');
  await expect(history.getByText('e2e smoke message')).toBeVisible();

  // One word longer than the window is wrapped inside its bubble, and the page does not scroll sideways.
  await composer.fill('SuperLongUnbrokenMessageContentForOverflowCoverage'.repeat(4));
  await composer.press('Enter');
  await expect(history.getByText(/SuperLongUnbrokenMessageContentForOverflowCoverage/)).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => fitsWidth(page)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Permission discovery updates an already-mounted box without erasing the
  // draft or letting Enter bypass the decision: the box is replaced by the
  // reason, in the server's own words, and comes back with its draft.
  await composer.fill('Keep this draft after my role changes.');
  const countBeforeRevocation = app.messages.length;
  app.compositionRevoked = true;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('paracord:roles-changed')));
  await expect(page.getByText(/You can.t send messages in|Only moderators can post|Your role no longer allows posting in this channel\./).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  expect(app.messages.length).toBe(countBeforeRevocation);

  // Giving the permission back returns the box, and the draft was never lost.
  app.compositionRevoked = false;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('paracord:roles-changed')));
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Keep this draft after my role changes.');
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible();
});

test('the quick switcher jumps to a voice channel, which opens as its own chat', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(textChannelUrl);
  await expect(composerOf(page)).toBeVisible();

  // Ctrl+K inside the draft inserts a Markdown link; leave the editor before
  // exercising the global jump shortcut.
  await composerOf(page).press('Tab');
  await expect(composerOf(page)).not.toBeFocused();
  await page.keyboard.press('Control+K');
  const switcher = page.getByRole('dialog', { name: 'Quick switcher' });
  await expect(switcher).toBeVisible();
  const input = switcher.getByRole('combobox').or(switcher.getByRole('textbox')).first();
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(switcher).toBeHidden();

  await page.keyboard.press('Control+K');
  await expect(switcher).toBeVisible();
  await input.fill(VOICE_CHANNEL_NAME);
  // The first result is the voice channel (the list follows the words), and Enter takes it.
  await expect(switcher.getByRole('option').first()).toContainText(VOICE_CHANNEL_NAME);
  // ...and it is the row Enter will take, not just the first one drawn.
  await expect(switcher.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/${VOICE_CHANNEL_ID}`));
  await expect(titleOf(page)).toHaveText(VOICE_CHANNEL_NAME);
});

test('a voice channel: its row joins it (refused here, and said so); a held call opens as the call view', async ({ page, app }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(textChannelUrl);

  // Clicking the row joins and never navigates; the channel's chat is the row's "Open chat".
  await expect(roomCard(page)).toHaveCount(0);
  await roomRow(page, VOICE_CHANNEL_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${TEXT_CHANNEL_ID}$`));

  // There is no relay behind a mocked page, so the join is refused. The product
  // says so out loud and leaves you where you were: out of the call.
  await expect.poll(() => app.voiceRequests).toContain(`join ${VOICE_CHANNEL_ID}`);
  await expect(page.getByText(new RegExp(`Could not join ${VOICE_CHANNEL_NAME}`)).first()).toBeVisible();
  await expect(roomCard(page, 'yours')).toHaveCount(0);

  // A call this client holds (what `voiceStore` has after a real join) draws the card as yours.
  await holdCall(page);
  const card = roomCard(page, 'yours');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('ix-card-leave')).toBeVisible();
  await expect(card.getByTestId('ix-card-open-call')).toBeVisible();

  // Open call grows the call view out of the card: the people in the call and its controls,
  // with Leave among them. Back to chat puts it away and the call goes on (closing the view
  // never leaves; Leave is the only way out).
  await card.getByTestId('ix-card-open-call').click();
  const view = page.getByTestId('ix-call');
  await expect(view).toBeVisible();
  await expect(page.getByRole('region', { name: /^Call: / })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Microphone' })).toBeVisible();
  await expect(view.getByTestId('ix-call-leave')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  await expect(roomCard(page, 'yours')).toBeVisible();
  // (The held call is store state with no session behind it, so Leave is not pressed
  // here: there is no relay to leave. The real join and leave are proved by the
  // real-server voice specs, `PARACORD_E2E_REAL=1`.)
});

test('a voice channel on a phone: the row, then the card on the root screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(textChannelUrl);
  await toolbarOf(page).getByRole('button', { name: 'Back to the sidebar' }).click();
  await expect(roomRow(page, VOICE_CHANNEL_NAME)).toBeInViewport();
  await holdCall(page);
  const card = roomCard(page, 'yours');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('ix-card-leave')).toBeInViewport();
  await expect.poll(() => fitsWidth(page)).toBe(true);
});

test("a server's Overview opens from the server menu, with its settings", async ({ page, app }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(textChannelUrl);
  await page.getByRole('button', { name: 'Server options' }).click();
  const serverMenu = page.getByRole('menu').first();
  await expect(serverMenu.getByRole('menuitem', { name: /^Server settings/ })).toBeVisible();
  await serverMenu.getByRole('menuitem', { name: /^Overview/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}$`));

  // The Overview is a page in main: the server's name is its large title.
  await expect(titleOf(page)).toHaveText(literal(GUILD_NAME));

  // Server settings open from the server menu (Manage Server), and read the
  // guild's full record, which is validated against its contract.
  await page.getByRole('button', { name: 'Server options' }).click();
  await page.getByRole('menu').first().getByRole('menuitem', { name: /^Server settings/ }).click();
  const settings = page.getByRole('dialog', { name: 'Server settings' });
  await expect(settings).toBeVisible();
  await expect.poll(() => app.validated.guild).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // A channel row takes you back to a conversation.
  await channelRow(page, TEXT_CHANNEL_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`));
});

test('an unknown channel says so, with a way back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/guilds/${GUILD_ID}/channels/999999999`);
  await expect(page.getByRole('heading', { name: 'This channel is gone' })).toBeVisible();
  await page.getByRole('button', { name: /^Go to / }).click();
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/`));
});

/**
 * Put this client in the voice channel's call: the state `voiceStore` holds
 * after a real join (the call, its mode, and this person's own voice state). A
 * mocked page has no relay to join through, so this is how the card's yours
 * state is reached (e2e/index-card.spec.ts does the same through its harness).
 */
async function holdCall(page: Page) {
  await page.evaluate(
    async ({ guildId, channelId }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as {
        useVoiceStore: { getState: () => Record<string, unknown>; setState: (state: Record<string, unknown>) => void };
      };
      const servers = (await import('/src/stores/serverListStore.ts' as string)) as {
        useServerListStore: { getState: () => { activeServerId: string | null } };
      };
      const scopes = (await import('/src/lib/serverScope.ts' as string)) as { LOCAL_SERVER_ID: string };
      const store = voice.useVoiceStore;
      const scope = { serverId: servers.useServerListStore.getState().activeServerId ?? scopes.LOCAL_SERVER_ID, userId: '42' };
      const me = {
        user_id: '42',
        channel_id: channelId,
        guild_id: guildId,
        session_id: 'e2e-session',
        username: 'smoke-user',
        display_name: null,
        avatar_hash: null,
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: false,
        self_stream: false,
        self_video: false,
        suppress: false,
        mode: 'joined',
        joined_at: new Date().toISOString(),
      };
      const current = store.getState() as { channelParticipants: Map<string, Array<{ user_id: string }>> };
      const there = current.channelParticipants.get(channelId) ?? [];
      if (there.some((state) => state.user_id === '42')) return;
      const members = [...there, me];
      const channelParticipants = new Map(current.channelParticipants);
      channelParticipants.set(channelId, members);
      store.setState({
        callId: 'e2e-call',
        callScope: scope,
        callPhase: 'connected',
        callMode: 'joined',
        connected: true,
        joining: false,
        channelId,
        guildId,
        selfMute: false,
        channelParticipants,
        participants: new Map(members.map((state) => [state.user_id, state])),
      });
    },
    { guildId: GUILD_ID, channelId: VOICE_CHANNEL_ID },
  );
}
