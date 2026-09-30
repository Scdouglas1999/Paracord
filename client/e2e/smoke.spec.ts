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
 * and again with touch. It is the Glass product walked the way a person walks it
 * (docs/glass-spec.md §3, §8; docs/design/glass-plan.md §5):
 *
 *   - the account signs in through a session refresh, the contract-checked
 *     payloads load, and the places panel and the conversation appear;
 *   - the conversation header (the title that opens the channel menu, search,
 *     members, your face) and the sheets it opens;
 *   - the composer, on every width, through a revoked permission;
 *   - a voice channel opens as its own chat, with the call pill in its header;
 *   - Home, a server's overview, direct messages, the command palette;
 *   - on a phone places is its own screen and the header's first button goes back to it.
 *
 * Nothing here needs a media relay: the stage, theater and the room are proved
 * by the Glass review specs and by the motion gate. What a call does when a join
 * is refused is here, because it is the path a mocked page can actually reach.
 */

/**
 * Every test gets its own mocked world, and ends by asserting the page raised
 * no uncaught error. `welcomed: false` is for the one test about the welcome.
 */
const test = base.extend<{ app: SmokeApp; welcomed: boolean }>({
  welcomed: [true, { option: true }],
  // `auto`: a test that never names `app` still runs in the mocked world. A
  // lazy fixture would leave it with no mocks at all, on the login page.
  app: [
    async ({ page, welcomed }, use) => {
      const app = await installSmokeApp(page, { welcomed });
      await use(app);
      expect(app.pageErrors, 'the page raised an uncaught error').toEqual([]);
    },
    { auto: true },
  ],
});

const textChannelUrl = `/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`;

/** The window sizes the product has to fit, by the frame each one gets. */
const PHONE_WIDTHS = [320, 375, 414] as const;
const COMPACT_WIDTH = 768;
const DESKTOPS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

const layoutOf = (page: Page) => page.locator('.glass-frame').getAttribute('data-layout');

/** The conversation pane's header: its title button, and what sits beside it. */
const header = (page: Page) => page.locator('.glass-header');
const titleButton = (page: Page) => header(page).getByRole('heading', { level: 1 }).getByRole('button');
const composerOf = (page: Page) => page.getByPlaceholder(COMPOSER_PLACEHOLDER);

/** Places: the server row, the server's title and its channel rows. */
const serverRow = (page: Page) => page.getByRole('navigation', { name: 'Servers' });
const channelRows = (page: Page) => page.getByRole('navigation', { name: 'Channels' });
const channelRow = (page: Page, name: RegExp | string) => channelRows(page).getByRole('link', { name });

/** The call pill: a region named for its channel. */
const pillFor = (page: Page, name: string) => page.getByRole('region', { name: `${name}, live voice channel` });

test('signs in by refresh, serves contract-valid payloads, and opens the server', async ({ page, app }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(textChannelUrl);
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`));
  await expect(page.locator('.glass-frame')).toHaveAttribute('data-layout', 'wide');

  // The places panel, on the left: the server row, the server's title, its channels.
  const servers = serverRow(page);
  await expect(servers.getByRole('button', { name: 'Home and direct messages' })).toBeVisible();
  await expect(servers.getByRole('button', { name: literal(GUILD_NAME) })).toHaveAttribute('aria-current', 'true');
  await expect(servers.getByRole('button', { name: 'Add or join a server' })).toBeVisible();
  await expect(page.getByRole('button', { name: literal(`${GUILD_NAME} menu. 4 members`) })).toBeVisible();

  // Channel rows show what is in them (no `#`): the newest message, by whom, and when.
  const general = channelRow(page, literal(TEXT_CHANNEL_NAME));
  await expect(general).toHaveAttribute('aria-current', 'page');
  await expect(general).toContainText('Ada: Kickoff is at nine, bring a chair.');
  await expect(channelRow(page, ATTENTION_CHANNEL_NAME)).toContainText('An update waiting for you.');
  await expect(channelRow(page, VOICE_CHANNEL_NAME)).toBeVisible();

  // The conversation, on the right: the 76px header with the channel's title and
  // its server, search, members and your face; then the timeline and the message box.
  await expect(page.getByRole('main')).toBeVisible();
  await expect(titleButton(page)).toHaveText(TEXT_CHANNEL_NAME);
  await expect(header(page).getByText(GUILD_NAME)).toBeVisible();
  const tools = header(page).getByRole('group', { name: 'Conversation actions' });
  await expect(tools.getByRole('button', { name: 'Search messages' })).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Members', exact: true })).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Your profile, online' })).toBeVisible();
  expect((await header(page).boundingBox())?.height).toBe(76);
  await expect(page.getByLabel('Message history')).toBeVisible();
  await expect(composerOf(page)).toBeVisible();

  // Nothing is live and nobody is in a call: no call pill is drawn.
  await expect(page.getByRole('region', { name: /live voice channel|voice call/ })).toHaveCount(0);

  // The guild list came through the generated contract validators, and they ran.
  expect(app.validated.guildList).toBeGreaterThan(0);
});

test.describe('the first visit', () => {
  test.use({ welcomed: false });

  test('welcomes you to the server once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(textChannelUrl);
    const welcome = page.getByRole('dialog', { name: literal(GUILD_NAME) });
    await expect(welcome).toBeVisible();
    await expect(welcome.getByText('Welcome aboard')).toBeVisible();
    await welcome.getByRole('button', { name: 'Jump in' }).click();
    await expect(welcome).toBeHidden();
    // It is remembered: the next visit goes straight to the conversation.
    await page.reload();
    await expect(composerOf(page)).toBeVisible();
    await expect(page.getByRole('dialog', { name: literal(GUILD_NAME) })).toHaveCount(0);
  });
});

test('fits every window, phone to wide desktop, with the frame each one gets', async ({ page }) => {
  await page.goto(textChannelUrl);

  // Phone (< 768): places is its own screen, so the header's first button goes back to it.
  for (const width of PHONE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('main')).toBeVisible();
    await expect.poll(() => layoutOf(page)).toBe('phone');
    await expect(header(page).getByRole('button', { name: 'Back to places' })).toBeVisible();
    await expect(composerOf(page)).toBeVisible();
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }

  // Compact (768 to 859): the conversation alone; places opens from the header.
  await page.setViewportSize({ width: COMPACT_WIDTH, height: 900 });
  await expect.poll(() => layoutOf(page)).toBe('compact');
  await expect(header(page).getByRole('button', { name: 'Show places' })).toBeVisible();
  await expect(composerOf(page)).toBeVisible();
  await expect.poll(() => fitsWidth(page)).toBe(true);

  // Wide (>= 860): both panes, and nothing to open.
  for (const viewport of DESKTOPS) {
    await page.setViewportSize(viewport);
    await expect.poll(() => layoutOf(page)).toBe('wide');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(serverRow(page)).toBeVisible();
    await expect(channelRows(page)).toBeVisible();
    await expect(header(page).getByRole('button', { name: /^(Show places|Back to places)$/ })).toHaveCount(0);
    await expect(composerOf(page)).toBeVisible();
    await expect.poll(() => fitsWidth(page)).toBe(true);
  }
});

test('compact: places opens as an overlay from the header and a pick closes it', async ({ page }) => {
  await page.setViewportSize({ width: COMPACT_WIDTH, height: 900 });
  await page.goto(textChannelUrl);
  const toggle = header(page).getByRole('button', { name: 'Show places' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(channelRows(page)).toBeVisible();
  await channelRow(page, ATTENTION_CHANNEL_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${ATTENTION_CHANNEL_ID}$`));
  await expect(titleButton(page)).toHaveText(ATTENTION_CHANNEL_NAME);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('phone: places is its own screen, and the header goes back to it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(textChannelUrl);
  const frame = page.locator('.glass-frame');
  // A deep link opens on the conversation; the screen behind it is inert.
  await expect(frame).toHaveAttribute('data-screen', 'conversation');
  await expect(page.locator('.glass-phone__screen--places')).toHaveAttribute('inert', '');

  await header(page).getByRole('button', { name: 'Back to places' }).click();
  await expect(frame).toHaveAttribute('data-screen', 'places');
  await expect(page.locator('.glass-phone__screen--conversation')).toHaveAttribute('inert', '');
  // The places screen: the server row, the server's title and its channels, full width.
  await expect(serverRow(page).getByRole('button', { name: literal(GUILD_NAME) })).toBeVisible();
  await expect(channelRow(page, ATTENTION_CHANNEL_NAME)).toBeVisible();
  await expect.poll(() => fitsWidth(page)).toBe(true);

  // Picking a row brings that conversation in.
  await channelRow(page, ATTENTION_CHANNEL_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${ATTENTION_CHANNEL_ID}$`));
  await expect(frame).toHaveAttribute('data-screen', 'conversation');
  await expect(titleButton(page)).toHaveText(ATTENTION_CHANNEL_NAME);
  await expect(page.locator('.glass-phone__screen--places')).toHaveAttribute('inert', '');
  await expect(composerOf(page).or(page.getByRole('textbox', { name: `Message ${ATTENTION_CHANNEL_NAME}` }))).toBeVisible();
});

test('every lazy route loads and fits, and the admin page stays shut to a member', async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const routes = [
    // Home: the greeting is the title ("Afternoon, <name>."), and For you is its first group.
    { path: '/app', region: 'Home', text: /, smoke-user/ },
    { path: '/app/friends', region: 'Friends', text: /Friends/ },
    { path: '/app/dms', region: 'Messages', text: /Messages/ },
    { path: '/app/discovery', text: /Discover servers/i },
    { path: '/app/templates', text: /Template Gallery/i },
    { path: '/app/developers', text: /Developer portal/i },
  ];
  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.getByRole('main')).toBeVisible();
    if (route.region) await expect(page.getByRole('region', { name: route.region, exact: true })).toBeVisible();
    await expect(page.getByText(route.text).first()).toBeVisible();
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

  // An account whose stored theme is one of the retired looks opens Glass, and
  // nothing refuses it; high contrast opens the Glass contrast theme.
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

test('the conversation header: the title opens the channel menu; search, members and your face open sheets', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto(textChannelUrl);

  for (const width of [320, 390, 767, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const phone = width < 768;
    // The frame changes with the window (a phone, compact and wide frame are three
    // trees); act on the one this width gets, not on the one being torn down.
    await expect.poll(() => layoutOf(page)).toBe(phone ? 'phone' : width < 860 ? 'compact' : 'wide');
    await expect(titleButton(page)).toBeVisible();
    await expect(titleButton(page)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(header(page).getByRole('button', { name: 'Search messages' })).toBeInViewport();
    await expect(header(page).getByRole('button', { name: 'Members', exact: true })).toBeInViewport();
    // Your face is the header's last tool on a window; on a phone it lives on the places screen.
    await expect(header(page).getByRole('button', { name: 'Your profile, online' })).toHaveCount(phone ? 0 : 1);
    // No docked member list anywhere (docs/glass-spec.md §1.7); members is a sheet.
    await expect(page.getByRole('complementary', { name: /members/i })).toHaveCount(0);

    // The title's menu: ArrowDown opens it and hands it focus; Escape closes it and gives focus back.
    await titleButton(page).focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'Channel actions' });
    await expect(menu).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: 'Server leaderboard' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(titleButton(page)).toBeFocused();

    // A row of the menu opens its page in a sheet over the conversation, and closing it gives focus back.
    await titleButton(page).click();
    await menu.getByRole('menuitem', { name: 'Pinned messages' }).click();
    const pins = page.getByRole('dialog', { name: 'Pinned messages' });
    await expect(pins).toBeVisible();
    // The menu finishes leaving before a person could answer the sheet; closing
    // the sheet inside that beat hands focus to a node that is already going.
    // (By CSS: a leaving menu is `aria-hidden`, so a role query no longer sees it.)
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await expect(pins.getByRole('button', { name: 'Close pinned messages' })).toBeInViewport();
    if (width === 1280) await page.screenshot({ path: testInfo.outputPath('header-pins-sheet-desktop.png') });
    await page.keyboard.press('Escape');
    await expect(pins).toBeHidden();
    await expect(titleButton(page), `focus returns to the title at ${width}px`).toBeFocused();

    // Search and members.
    const search = header(page).getByRole('button', { name: 'Search messages' });
    await search.click();
    await expect(search).toHaveAttribute('aria-expanded', 'true');
    const searchSheet = page.getByRole('dialog', { name: 'Search messages' });
    await expect(searchSheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(searchSheet).toBeHidden();
    await expect(search).toBeFocused();

    const members = header(page).getByRole('button', { name: 'Members', exact: true });
    await members.click();
    const membersSheet = page.getByRole('dialog', { name: 'Members' });
    await expect(membersSheet).toBeVisible();
    await expect(membersSheet.getByRole('button', { name: 'Close members' })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(membersSheet).toBeHidden();
    await expect(members).toBeFocused();

    // Your face opens the account menu.
    if (!phone) {
      const face = header(page).getByRole('button', { name: 'Your profile, online' });
      await face.click();
      const account = page.getByRole('menu', { name: 'Account' });
      await expect(account).toBeVisible();
      await expect(account.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
      await expect(account.getByRole('menuitemradio', { name: 'Online' })).toBeChecked();
      await page.keyboard.press('Escape');
      await expect(account).toBeHidden();
      await expect(face).toBeFocused();
    }
    await expect.poll(() => fitsWidth(page)).toBe(true);
    if (width === 390) {
      await titleButton(page).click();
      await page.screenshot({ path: testInfo.outputPath('header-menu-mobile.png') });
      await page.keyboard.press('Escape');
    }
  }
});

test('attention: what needs you is said in words, in the menu, the inbox and the places panel', async ({ page, app }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(textChannelUrl);
  for (const attention of ['unread', 'mentions', 'read'] as const) {
    app.headerAttention = attention;
    // The read states are refreshed by the inbox row itself; the title's own
    // description is the summary a screen reader hears.
    await titleButton(page).click();
    await page.getByRole('menuitem', { name: /^Inbox/ }).click();
    await expect(page.getByRole('dialog', { name: 'Inbox', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close inbox', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Inbox', exact: true })).toBeHidden();
    const description =
      attention === 'mentions'
        ? '3 mentions in 1 unread conversation'
        : attention === 'unread'
          ? '1 unread conversation'
          : 'No unread conversations';
    await expect(titleButton(page)).toHaveAccessibleDescription(description);
    if (attention !== 'read') await page.screenshot({ path: testInfo.outputPath(`header-${attention}-mobile.png`) });
  }

  // On the places screen the channel row says it too: a white @ chip for mentions.
  app.headerAttention = 'mentions';
  await page.goto(textChannelUrl);
  await page.getByRole('button', { name: 'Back to places' }).click();
  await expect(channelRow(page, ATTENTION_CHANNEL_NAME)).toContainText('3 mentions');
  await expect(serverRow(page).getByRole('button', { name: new RegExp(`^${GUILD_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, 3 mentions`) })).toBeVisible();
});

test('direct messages: the header keeps search, the call and the people, at every width', async ({ page, app }, testInfo) => {
  test.setTimeout(90_000);
  app.showDmFixtures = true;
  for (const dm of app.dmFixtures) {
    await page.goto(`/app/dms/${dm.id}`);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(titleButton(page)).toBeVisible();
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      if (width < 768) await expect(header(page).getByRole('button', { name: 'Back to places' })).toBeVisible();
      await expect(header(page).getByRole('button', { name: 'Search messages' })).toBeInViewport();
      await expect(header(page).getByRole('button', { name: 'Start direct message voice call' })).toBeInViewport();
      await expect(header(page).getByRole('button', { name: 'People in this message' })).toBeInViewport();
      // A long title is bounded inside the header on a narrow screen, never pushed off it.
      if (dm.type === 3 && width < 480) await expect(titleButton(page)).toBeInViewport();
      await expect.poll(() => fitsWidth(page)).toBe(true);
      if (width === 390) await page.screenshot({ path: testInfo.outputPath(`header-dm-${dm.type}-mobile.png`) });
    }
    // The people of a message or a group are a sheet, never a docked list.
    await page.setViewportSize({ width: 1280, height: 800 });
    await header(page).getByRole('button', { name: 'People in this message' }).click();
    await expect(page.getByRole('dialog', { name: 'People in this message' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'People in this message' })).toBeHidden();
  }
});

test('the composer keeps a draft, bounds a long one, sends, and obeys a revoked permission', async ({ page, app }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto(textChannelUrl);
  const composer = composerOf(page);

  // A draft survives opening the message tools, at every width.
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(composer).toBeVisible();
    await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
    await composer.fill('A draft that remains intact while opening message tools.');
    const more = page.getByRole('button', { name: 'More message tools' });
    if (await more.isVisible()) {
      await more.click();
      await expect(page.getByRole('menu', { name: 'Message tools' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(more).toBeFocused();
    } else {
      await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();
    }
    await expect(composer).toHaveValue('A draft that remains intact while opening message tools.');
    await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
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

  // Permission discovery updates an already-mounted composer without erasing
  // the draft or allowing Enter/picker actions to bypass the decision.
  await composer.fill('Keep this draft after my role changes.');
  const countBeforeRevocation = app.messages.length;
  app.compositionRevoked = true;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('paracord:roles-changed')));
  await expect(page.getByRole('status').filter({ hasText: 'Your role no longer allows posting in this channel.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await composer.press('Enter');
  await expect(composer).toHaveValue('Keep this draft after my role changes.');
  expect(app.messages.length).toBe(countBeforeRevocation);

  // The message tools menu names what is off and stays inside the window, even on a short one.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole('button', { name: 'More message tools' }).click();
  await expect(page.getByRole('menuitem', { name: /Create a poll/ })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: /Attach files/ })).toBeDisabled();
  const permissionMenu = page.getByRole('menu', { name: 'Message tools' });
  await expect.poll(async () => permissionMenu.evaluate((menu) => menu.getBoundingClientRect().bottom <= window.innerHeight - 7)).toBe(true);
  await expect(page.getByRole('menuitem', { name: /^Emoji/ })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('composer-permission-390.png') });
  await page.setViewportSize({ width: 390, height: 420 });
  await expect.poll(async () => permissionMenu.evaluate((menu) => menu.getBoundingClientRect().bottom <= window.innerHeight - 7)).toBe(true);
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: /^Emoji/ })).toBeInViewport();
  await expect(permissionMenu).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.keyboard.press('Escape');

  // Giving the permission back re-enables send, and the draft was never lost.
  app.compositionRevoked = false;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('paracord:roles-changed')));
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Keep this draft after my role changes.');
});

test('the command palette jumps to a voice channel, which opens as its own chat', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(textChannelUrl);
  await expect(composerOf(page)).toBeVisible();

  // Ctrl+K inside the draft inserts a Markdown link; leave the editor before
  // exercising the global jump shortcut.
  await composerOf(page).press('Tab');
  await expect(composerOf(page)).not.toBeFocused();
  await page.keyboard.press('Control+K');
  const paletteInput = page.getByPlaceholder(/Jump to a channel, server, or setting/i);
  await expect(paletteInput).toBeVisible();
  await expect(paletteInput).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(paletteInput).toBeHidden();

  await page.keyboard.press('Control+K');
  await expect(paletteInput).toBeVisible();
  await paletteInput.fill(VOICE_CHANNEL_NAME);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/${VOICE_CHANNEL_ID}`));
  await expect(titleButton(page)).toHaveText(VOICE_CHANNEL_NAME);
});

test('a voice channel opens as its own chat, with the call pill for it in the header', async ({ page, app }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(textChannelUrl);

  // Opened from its row in the places panel, the way a person reaches it.
  await channelRow(page, VOICE_CHANNEL_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/${VOICE_CHANNEL_ID}`));
  await expect(channelRow(page, VOICE_CHANNEL_NAME)).toHaveAttribute('aria-current', 'page');

  // What the conversation pane holds is the channel's text chat: its title, a
  // timeline and a message box. The voice page, its lobby and its "Join voice"
  // header are gone.
  await expect(titleButton(page)).toHaveText(VOICE_CHANNEL_NAME);
  await expect(page.getByLabel('Message history')).toBeVisible();
  await expect(page.getByRole('textbox', { name: `Message ${VOICE_CHANNEL_NAME}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join voice', exact: true })).toHaveCount(0);

  // The pill in the header is for this channel even though nobody is in it.
  const pill = pillFor(page, VOICE_CHANNEL_NAME);
  await expect(pill).toBeVisible();
  await expect(pill.getByRole('button', { name: `Listen in to ${VOICE_CHANNEL_NAME}` })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Microphone on when you join' })).toBeVisible();
  const join = pill.getByRole('button', { name: `Join ${VOICE_CHANNEL_NAME}` });
  await expect(join).toBeVisible();
  await expect(pill.getByRole('button', { name: `Leave ${VOICE_CHANNEL_NAME}` })).toHaveCount(0);

  // There is no relay behind a mocked page, so the join is refused. The product
  // says so out loud and leaves you where you were: out of the call, with Join still there.
  await join.click();
  await expect.poll(() => app.voiceRequests).toContain(`join ${VOICE_CHANNEL_ID}`);
  await expect(page.getByText(new RegExp(`Could not join ${VOICE_CHANNEL_NAME}`)).first()).toBeVisible();
  await expect(pill.getByRole('button', { name: `Join ${VOICE_CHANNEL_NAME}` })).toBeVisible();
  await expect(pill.getByRole('button', { name: `Leave ${VOICE_CHANNEL_NAME}` })).toHaveCount(0);

  // A call this client holds (what `voiceStore` has after a real join) moves the pill to its joined set.
  await holdCall(page);
  const leave = pill.getByRole('button', { name: `Leave ${VOICE_CHANNEL_NAME}` });
  await expect(leave).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Microphone', exact: true })).toBeVisible();
  await expect(pill.getByRole('button', { name: `Join ${VOICE_CHANNEL_NAME}` })).toHaveCount(0);
  await expect(pill.getByRole('button', { name: `Listen in to ${VOICE_CHANNEL_NAME}` })).toHaveCount(0);
  // Nobody else is sharing a screen, so there is nothing to Watch; the stage can show the call itself.
  await expect(pill.getByRole('button', { name: /^Watch / })).toHaveCount(0);
  const showCall = pill.getByRole('button', { name: 'Show the call' });
  await expect(showCall).toBeVisible();
  await expect(leave).toBeEnabled();

  // Somebody else starts sharing a screen: Watch is offered for theirs, and there is no need to "show the call".
  await someoneShares(page);
  await expect(pill.getByRole('button', { name: "Watch Ada's screen" })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Show the call' })).toHaveCount(0);
  await someoneStopsSharing(page);
  await expect(pill.getByRole('button', { name: "Watch Ada's screen" })).toHaveCount(0);
  await expect(showCall).toBeVisible();

  // Show the call grows the stage out of the pill: the people in the call and the
  // call's own controls, with Leave among them. Escape puts it away and the call
  // goes on (closing the stage never leaves; Leave is the only way out).
  await showCall.click();
  const stage = page.getByRole('region', { name: 'Stage' });
  await expect(stage).toBeVisible();
  await expect(stage.getByRole('list', { name: 'People in the call' })).toBeVisible();
  const controls = stage.getByRole('group', { name: 'Call controls' });
  await expect(controls.getByRole('button', { name: 'Microphone' })).toBeVisible();
  await expect(controls.getByRole('button', { name: `Leave ${VOICE_CHANNEL_NAME}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(pill.getByRole('button', { name: `Leave ${VOICE_CHANNEL_NAME}` })).toBeVisible();
  // (The held call is store state with no session behind it, so Leave is not pressed
  // here: there is no relay to leave. The real join and leave are proved by the
  // real-server voice specs, `PARACORD_E2E_REAL=1`.)
});

test('a voice channel on a phone: its chat, and the stacked pill above the header', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(textChannelUrl);
  await header(page).getByRole('button', { name: 'Back to places' }).click();
  await channelRow(page, VOICE_CHANNEL_NAME).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${VOICE_CHANNEL_ID}$`));
  await expect(page.locator('.glass-frame')).toHaveAttribute('data-screen', 'conversation');
  await expect(titleButton(page)).toHaveText(VOICE_CHANNEL_NAME);
  const pill = pillFor(page, VOICE_CHANNEL_NAME);
  await expect(pill).toHaveAttribute('data-layout', 'stacked');
  await expect(pill.getByRole('button', { name: `Join ${VOICE_CHANNEL_NAME}` })).toBeInViewport();
  await expect.poll(() => fitsWidth(page)).toBe(true);
});

test('a server overview opens from the server menu, with its settings', async ({ page, app }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(textChannelUrl);
  await page.getByRole('button', { name: literal(`${GUILD_NAME} menu. 4 members`) }).click();
  const serverMenu = page.getByRole('menu', { name: literal(`${GUILD_NAME} menu`) });
  await expect(serverMenu.getByRole('menuitem', { name: 'Server settings' })).toBeVisible();
  await serverMenu.getByRole('menuitem', { name: 'Overview' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}$`));

  // The overview (docs/server-home-spec.md): the server's name, its voice
  // channels (or what is live), then the Latest feed. It lists no text channels;
  // those are the places panel's.
  const overview = page.getByRole('region', { name: literal(`${GUILD_NAME} home`) });
  await expect(overview.getByRole('heading', { level: 1, name: literal(GUILD_NAME) })).toBeVisible();
  await expect(overview.getByRole('region', { name: 'Voice channels', exact: true })).toBeVisible();
  await expect(overview.getByRole('region', { name: 'Latest', exact: true })).toBeVisible();

  // Server settings open from the overview's header (MANAGE_GUILD-gated), and
  // read the guild's full record, which is validated against its contract.
  await overview.getByRole('button', { name: 'Server settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Server settings' });
  await expect(settings).toBeVisible();
  await expect.poll(() => app.validated.guild).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // A channel row in places takes you back to a conversation.
  await channelRow(page, literal(TEXT_CHANNEL_NAME)).click();
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/${TEXT_CHANNEL_ID}`));
});

test('an unknown channel says so, and Home keeps direct mentions in view', async ({ page, app }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/guilds/${GUILD_ID}/channels/999999999`);
  await expect(page.getByRole('heading', { name: 'Channel not found' })).toBeVisible();

  // Home keeps direct mentions visible and never calls an unknown state quiet.
  app.headerAttention = 'mentions';
  app.showHomeFixtures = true;
  await page.goto('/app');
  const home = page.getByRole('region', { name: 'Home', exact: true });
  await expect(home.getByRole('heading', { level: 1 })).toHaveText(/, smoke-user/);
  const forYou = home.getByRole('region', { name: 'For you' });
  // The attention preview's author is the reader, so the row keeps the count.
  await expect(forYou.getByText('3 mentions for you', { exact: true })).toBeVisible();
  await expect(forYou.getByText(/An update waiting for you/)).toBeVisible();
  const conversations = home.getByRole('region', { name: 'Pick up the conversation' });
  for (const channel of app.homeChannels) {
    await expect(forYou.getByRole('button', { name: `Open ${channel.name}` })).toHaveCount(0);
    const conversation = conversations.getByRole('button', { name: `Open ${channel.name}` });
    await expect(conversation).toContainText(`Could you review ${channel.name}?`);
    const space = app.homeSpaces.find((candidate) => candidate.id === channel.guild_id);
    await expect(conversation).toContainText(space!.name);
  }
  await expect(home.getByText(/is quiet|No data|Nothing new for you/)).toHaveCount(0);

  const openAttention = forYou.getByRole('button', { name: `Open ${ATTENTION_CHANNEL_NAME}` });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => fitsWidth(page)).toBe(true);
    await expect(openAttention).toBeVisible();
    if (width === 320 || width === 1280) await page.screenshot({ path: testInfo.outputPath(`home-needs-you-${width}.png`) });
  }
  await openAttention.click();
  await expect(page).toHaveURL(new RegExp(`/app/guilds/${GUILD_ID}/channels/${ATTENTION_CHANNEL_ID}`));
});

/** Ada, in the voice channel's call, sharing her screen (or not), as the gateway would say. */
async function setAdaSharing(page: Page, sharing: boolean) {
  await page.evaluate(
    async ({ guildId, channelId, on }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as {
        useVoiceStore: { getState: () => Record<string, unknown>; setState: (state: Record<string, unknown>) => void };
      };
      const store = voice.useVoiceStore;
      const current = store.getState() as { channelParticipants: Map<string, Array<{ user_id: string }>> };
      const others = (current.channelParticipants.get(channelId) ?? []).filter((state) => state.user_id !== '43');
      const ada = {
        user_id: '43',
        channel_id: channelId,
        guild_id: guildId,
        session_id: 'e2e-ada',
        username: 'ada',
        display_name: 'Ada',
        avatar_hash: null,
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: false,
        self_stream: on,
        self_stream_started_at: on ? new Date().toISOString() : null,
        self_video: false,
        suppress: false,
        mode: 'joined',
      };
      const members = [...others, ada];
      const channelParticipants = new Map(current.channelParticipants);
      channelParticipants.set(channelId, members);
      store.setState({ channelParticipants, participants: new Map(members.map((state) => [state.user_id, state])) });
    },
    { guildId: GUILD_ID, channelId: VOICE_CHANNEL_ID, on: sharing },
  );
}
const someoneShares = (page: Page) => setAdaSharing(page, true);
const someoneStopsSharing = (page: Page) => setAdaSharing(page, false);

/**
 * Put this client in the voice channel's call: the state `voiceStore` holds
 * after a real join (the call, its mode, and this person's own voice state). A
 * mocked page has no relay to join through, so this is how the pill's joined set
 * is reached (e2e/glass-pill.spec.ts does the same).
 */
async function holdCall(page: Page) {
  await page.evaluate(
    async ({ guildId, channelId }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as {
        useVoiceStore: { getState: () => Record<string, unknown>; setState: (state: Record<string, unknown>) => void; subscribe: (listener: () => void) => void };
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
      };
      const put = () => {
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
      };
      put();
    },
    { guildId: GUILD_ID, channelId: VOICE_CHANNEL_ID },
  );
}
