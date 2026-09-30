import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * WP-G21 (long tail restyle): shots of every surface the packages that rebuild
 * the shell do not own, on the Glass reference scene, at 1440x900 and 390x844.
 * Mocked like glass-review.spec.ts, and driven through the app's own stores
 * (the same module instances the page runs, by URL) where a surface has no
 * stable trigger yet.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g21 npx playwright test -c e2e/glass-longtail.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/<surface>-{desktop,phone}.png
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'g21';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;
type Size = keyof typeof SIZES;

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;

async function shoot(page: Page, name: string, size: Size) {
  const view = page.viewportSize();
  if (view) await page.mouse.move(view.width - 3, view.height - 3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-${size}.png`), fullPage: false });
}

/**
 * Call into one of the app's own stores by module URL: the same instance the
 * running page holds, because the dev server serves each module at one URL.
 * `hook` is the store's exported hook, `method` a state action, `args` JSON.
 */
async function callStore(page: Page, module: string, hook: string | null, method: string, ...args: unknown[]) {
  await page.evaluate(
    async ({ module, hook, method, args }) => {
      const mod = (await import(/* @vite-ignore */ module)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const target = hook ? mod[hook].getState() : mod;
      void target[method](...args);
    },
    { module, hook, method, args },
  );
}

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

async function open(page: Page, size: Size, route = general) {
  test.setTimeout(90_000);
  await page.setViewportSize(SIZES[size]);
  await installGlassScene(page);
  await page.goto(route);
  await expect(page.getByRole('main')).toBeVisible();
  await page.waitForTimeout(500);
}

for (const size of ['desktop', 'phone'] as const) {
  test(`user settings at ${size}`, async ({ page }) => {
    await open(page, size, '/app?settings=account');
    await expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible();
    await shoot(page, 'settings-account', size);
    if (size === 'desktop') {
      await page.getByRole('button', { name: 'Appearance' }).click();
      await shoot(page, 'settings-appearance', size);
      await page.getByRole('button', { name: 'Notifications' }).click();
      await shoot(page, 'settings-notifications', size);
      await page.getByRole('button', { name: 'Voice & video' }).click();
      await shoot(page, 'settings-voice', size);
      await page.getByRole('button', { name: 'Keybinds' }).click();
      await shoot(page, 'settings-keybinds', size);
    } else {
      await page.goto('/app?settings=appearance');
      await expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible();
      await shoot(page, 'settings-appearance', size);
    }
  });

  test(`server settings at ${size}`, async ({ page }) => {
    await open(page, size);
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'openGuildSettings', '1001', 'overview');
    await expect(page.getByRole('dialog', { name: 'Server settings' })).toBeVisible();
    await shoot(page, 'server-settings-overview', size);
    if (size === 'desktop') {
      for (const label of ['Roles', 'Emojis', 'Invites', 'Bans', 'Add-ons']) {
        await page.getByRole('dialog', { name: 'Server settings' }).getByRole('button', { name: label, exact: true }).first().click();
        await shoot(page, `server-settings-${label.toLowerCase().replace(/[^a-z]/g, '')}`, size);
      }
    }
  });

  test(`confirm dialog, toast and menus at ${size}`, async ({ page }) => {
    await open(page, size);
    await callStore(page, '/src/stores/confirmStore.ts', null, 'confirm', {
      title: 'Delete Patch notes?',
      description: 'This removes the channel and every message in it. It cannot be undone.',
      confirmLabel: 'Delete channel',
      variant: 'danger',
    });
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await shoot(page, 'confirm-danger', size);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);

    await callStore(page, '/src/stores/confirmStore.ts', null, 'confirm', { title: 'Mark everything in Game Night as read?', confirmLabel: 'Mark read' });
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await shoot(page, 'confirm-default', size);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);

    await page.evaluate(async () => {
      const mod = (await import('/src/stores/toastStore.ts' as string)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      mod.useToastStore.getState().addToast('success', 'Saved the last 30 seconds', 60000, { label: 'Post to General', onClick: () => undefined });
    });
    await callStore(page, '/src/stores/toastStore.ts', 'useToastStore', 'addToast', 'error', 'Could not send that message. Check your connection and try again.', 60000);
    await callStore(page, '/src/stores/toastStore.ts', 'useToastStore', 'addToast', 'info', 'Vincent started streaming in Lounge', 60000);
    await shoot(page, 'toasts', size);
  });

  test(`command palette at ${size}`, async ({ page }) => {
    await open(page, size);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await shoot(page, 'palette', size);
    await page.keyboard.type('lou');
    await page.waitForTimeout(300);
    await shoot(page, 'palette-query', size);
  });

  test(`menus and pickers at ${size}`, async ({ page }) => {
    await open(page, size);
    const tools = page.getByRole('button', { name: 'More message tools' });
    await tools.click();
    await expect(page.getByRole('menu', { name: 'Message tools' })).toBeVisible();
    await shoot(page, 'context-menu-tools', size);
    for (const [item, shot] of [
      ['Emoji', 'emoji-picker'],
      ['GIFs', 'gif-picker'],
      ['Stickers', 'sticker-picker'],
    ] as const) {
      if (!(await page.getByRole('menu', { name: 'Message tools' }).isVisible().catch(() => false))) {
        await tools.click();
      }
      const entry = page.getByRole('menuitem', { name: item });
      if ((await entry.count()) === 0) continue;
      await entry.first().click();
      await page.waitForTimeout(600);
      await shoot(page, shot, size);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    if (size === 'desktop') {
      // A message's own context menu: the timeline, not the composer.
      await page.getByText("okay who's actually on tonight?").first().click({ button: 'right' });
      await page.waitForTimeout(500);
      await shoot(page, 'context-menu-message', size);
    }
  });

  test(`profile card, switcher and tooltip at ${size}`, async ({ page }) => {
    await open(page, size);
    // The author's name opens their profile card.
    await page.getByRole('main').getByText('Brendan', { exact: true }).first().click();
    await page.waitForTimeout(700);
    await shoot(page, 'profile-card', size);
    await page.keyboard.press('Escape');
    await page.mouse.click(size === 'desktop' ? 1000 : 200, 120);
    await page.waitForTimeout(300);
    // The header's channel title opens the switcher; a tooltip from any labeled icon.
    const title = page.getByRole('button', { name: /Switch channel/ });
    if ((await title.count()) > 0) {
      await title.first().click();
      await page.waitForTimeout(500);
      await shoot(page, 'channel-switcher', size);
      await page.keyboard.press('Escape');
    }
    if (size === 'desktop') {
      await page.getByRole('button', { name: /^Search$/ }).first().hover({ timeout: 4_000 }).catch(() => undefined);
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(OUT_DIR, `tooltip-${size}.png`) });
    }
  });
}

test('dialogs opened from the places panel', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(SIZES.desktop);
  await installGlassScene(page);
  await page.goto(general);
  await expect(page.getByRole('main')).toBeVisible();
  await page.getByRole('button', { name: 'Add or join a server' }).click();
  await page.waitForTimeout(700);
  await shoot(page, 'dialog-create-server', 'desktop');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // The server title's menu, then Invite people.
  await page.getByRole('button', { name: /^Game Night menu/ }).click();
  await page.waitForTimeout(500);
  await shoot(page, 'menu-server', 'desktop');
  const invite = page.getByRole('menuitem', { name: 'Invite people' });
  if ((await invite.count()) > 0) {
    await invite.first().click();
    await page.waitForTimeout(700);
    await shoot(page, 'dialog-invite', 'desktop');
  }
});

/**
 * The channel switcher is mounted by the old header only, which the new one
 * replaces, so it is mounted here directly from the running dev server: the same
 * React and router instances the page loaded, found by their resource URLs.
 */
test('channel switcher', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(SIZES.desktop);
  const seen: string[] = [];
  page.on('request', (request) => {
    if (/\/deps\/react(-dom_client|-router)?\.js\?v=/.test(request.url())) seen.push(request.url());
  });
  await installGlassScene(page);
  await page.goto(general);
  await expect(page.getByRole('main')).toBeVisible();
  const pick = (name: string) => seen.find((u) => u.includes(`/deps/${name}.js?v=`)) as string;
  await page.evaluate(
    async ({ reactUrl, domUrl, routerUrl }) => {
      // The optimized dependencies are CommonJS wrapped as ESM: the API may sit on `default`.
      const load = async (url: string, probe: string) => {
        const mod = (await import(/* @vite-ignore */ url)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        return mod[probe] ? mod : mod.default;
      };
      const React = await load(reactUrl, 'createElement');
      const Dom = await load(domUrl, 'createRoot');
      const Router = await load(routerUrl, 'MemoryRouter');
      const { ChannelSwitcher } = (await import('/src/components/layout/ChannelSwitcher.tsx' as string)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:560px;top:24px;z-index:80;width:20rem';
      document.body.appendChild(host);
      const ch = (id: string, name: string, type: number, position: number, topic: string | null = null) => ({
        id, guild_id: '1001', name, type, channel_type: type, position, topic, parent_id: null, nsfw: false,
      });
      const channels = [ch('2001', 'General', 0, 0, 'Haz 5 runs from 9. Bring snacks.'), ch('2002', 'Lounge', 2, 1), ch('2003', 'Clips', 0, 2), ch('2004', 'LFG', 0, 3), ch('2005', 'Patch notes', 0, 4)];
      Dom.createRoot(host).render(
        React.createElement(
          Router.MemoryRouter,
          null,
          React.createElement(ChannelSwitcher, { guildId: '1001', guildName: 'Game Night', channelId: '2001', channelName: 'General', channelType: 0, channels }),
        ),
      );
    },
    { reactUrl: pick('react'), domUrl: pick('react-dom_client'), routerUrl: pick('react-router') },
  );
  await page.getByRole('button', { name: /Switch channel/ }).click();
  await page.waitForTimeout(500);
  await shoot(page, 'channel-switcher', 'desktop');
});

/**
 * The composer's "Message tools" menu is a ContextMenu anchored to the + button.
 * It used to keep the offset of its previous opening when it reopened at the same
 * anchor (the placement effect never re-ran), so on a phone it could run off the
 * bottom edge. Closed and reopened, and with the window resized, it stays on screen.
 * (The regression test that fails without the fix is in ContextMenu.test.tsx; this
 * is the same behavior end to end, in a real layout.)
 */
test('the message tools menu stays on screen on a phone, opened again and resized', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, 'phone');
  const tools = page.getByRole('button', { name: 'More message tools' });
  const menu = page.getByRole('menu', { name: 'Message tools' });
  const onScreen = async () => menu.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight - 7 && el.getBoundingClientRect().top >= 0);
  for (const pass of [1, 2, 3]) {
    await tools.click();
    await expect(menu).toBeVisible();
    await expect.poll(onScreen, { message: `opening ${pass}` }).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // Wait for the leave to finish, so the next opening is a new node.
    await page.waitForFunction(() => !document.querySelector('[role="menu"][aria-label="Message tools"]'));
  }
  await tools.click();
  await page.setViewportSize({ width: 390, height: 420 });
  await expect.poll(onScreen, { message: 'after resizing to 420px tall' }).toBe(true);
});

/**
 * Mount a gallery of the shared primitives straight from the dev server, into the
 * running page: the same React and design system instances the app uses, found by
 * their resource URLs (an optimized dependency is CommonJS wrapped as ESM).
 */
async function mountGallery(page: Page) {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (/\/deps\/react(-dom_client)?\.js\?v=/.test(request.url())) seen.push(request.url());
  });
  await installGlassScene(page);
  await page.goto(general);
  await expect(page.getByRole('main')).toBeVisible();
  const pick = (name: string) => seen.find((u) => u.includes(`/deps/${name}.js?v=`)) as string;
  await page.evaluate(
    async ({ reactUrl, domUrl }) => {
      const load = async (url: string, probe: string) => {
        const mod = (await import(/* @vite-ignore */ url)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        return mod[probe] ? mod : mod.default;
      };
      const React = await load(reactUrl, 'createElement');
      const Dom = await load(domUrl, 'createRoot');
      const ui = (await import('/src/components/ui/index.ts' as string)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const h = React.createElement;
      const host = document.createElement('div');
      host.id = 'gallery';
      host.style.cssText =
        'position:fixed;inset:24px;z-index:80;overflow:auto;padding:32px;display:flex;flex-direction:column;gap:22px;border-radius:28px;background:var(--solid);box-shadow:var(--sh-pane)';
      document.body.appendChild(host);
      const row = (label: string, ...kids: unknown[]) =>
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } }, h('div', { className: 'glass-kicker', style: { width: 120, color: 'var(--ink-3)' } }, label), ...kids);
      const variants = ['primary', 'glass', 'ghost', 'danger'];
      const Tabs = ui.Tabs;
      const kids = [
        row('Button md', ...variants.map((v) => h(ui.Button, { key: v, variant: v }, v[0].toUpperCase() + v.slice(1)))),
        row('Button sm', ...variants.map((v) => h(ui.Button, { key: v, variant: v, size: 'sm' }, v))),
        row('Button lg', ...variants.map((v) => h(ui.Button, { key: v, variant: v, size: 'lg' }, v))),
        row('Disabled', ...variants.map((v) => h(ui.Button, { key: v, variant: v, disabled: true }, v))),
        row('IconButton', ...['ghost', 'raised', 'light', 'danger'].map((t) => h(ui.Tooltip, { key: t, content: t === 'raised' ? 'Mute microphone' : `${t} tone` }, h(ui.IconButton, { label: t, tone: t }, '+')))),
        row('Chips', h(ui.Chip, null, '12'), h(ui.Chip, { tone: 'accent' }, 'Accent'), h(ui.Chip, { tone: 'danger' }, 'Danger'), h(ui.Kbd, null, 'Ctrl K'), h(ui.Kbd, null, 'Esc')),
        row('Switch', h(ui.Switch, { checked: true, onChange() {}, label: 'on' }), h(ui.Switch, { checked: false, onChange() {}, label: 'off' }), h(ui.Switch, { checked: true, onChange() {}, label: 'sm', size: 'sm' })),
        row('Tabs', h(Tabs, { label: 'demo', value: 'a', onChange() {}, items: [{ value: 'a', label: 'Create' }, { value: 'b', label: 'Join' }, { value: 'c', label: 'Template' }] }), h(Tabs, { label: 'under', variant: 'underline', value: 'b', onChange() {}, items: [{ value: 'a', label: 'One' }, { value: 'b', label: 'Two', meta: '4' }] })),
        row('Fields', h('div', { style: { width: 260 } }, h(ui.TextField, { label: 'Server name', placeholder: 'Game Night', hint: 'Shown to everyone' })), h('div', { style: { width: 260 } }, h(ui.TextField, { label: 'Handle', defaultValue: 'sean', error: 'That handle is taken' }))),
        row('Feedback', h('div', { style: { width: 360 } }, h(ui.ErrorBanner, { message: 'Could not save. Try again.', onRetry() {} })), h('div', { style: { width: 300 } }, h(ui.EmptyState, { title: 'No invite links yet', description: 'Generate a link and hand it out.' }))),
        row('Section label', h(ui.SectionLabel, { meta: '24' }, 'Coming up'), h(ui.Divider, { label: '6 new since 8:58', style: { width: 260 } })),
      ];
      Dom.createRoot(host).render(h('div', { style: { display: 'flex', flexDirection: 'column', gap: 22 } }, ...kids));
    },
    { reactUrl: pick('react'), domUrl: pick('react-dom_client') },
  );
  await page.waitForTimeout(400);
}

test('primitives gallery: hover is a step lighter, press a step darker, nothing scales', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(SIZES.desktop);
  await mountGallery(page);
  await shoot(page, 'primitives', 'desktop');
  const gallery = page.locator('#gallery');
  const buttons = gallery.getByRole('button');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(20);
  const report: string[] = [];
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    if (!(await button.isEnabled())) continue;
    const read = () =>
      button.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { transform: cs.transform, bg: cs.backgroundColor, image: cs.backgroundImage };
      });
    await button.scrollIntoViewIfNeeded();
    await button.hover();
    await page.waitForTimeout(200);
    const hover = await read();
    await page.mouse.down();
    await page.waitForTimeout(200);
    const press = await read();
    await page.mouse.up();
    await page.mouse.move(2, 2);
    // Nothing scales: the transform stays `none` (or the identity) in every state.
    expect(hover.transform === 'none' || hover.transform === 'matrix(1, 0, 0, 1, 0, 0)', `hover transform of button ${i}: ${hover.transform}`).toBe(true);
    expect(press.transform === 'none' || press.transform === 'matrix(1, 0, 0, 1, 0, 0)', `press transform of button ${i}: ${press.transform}`).toBe(true);
    report.push(`${(await button.textContent())?.trim() || (await button.getAttribute('aria-label'))}: hover ${hover.bg} press ${press.bg} ${press.image === 'none' ? '' : '+wash'}`);
  }
  console.log(report.join('\n'));
  // A tooltip: near-solid, no arrow, no blur.
  await gallery.getByRole('button', { name: 'raised' }).hover();
  await page.waitForTimeout(1_100);
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.screenshot({ path: path.join(OUT_DIR, 'tooltip-desktop.png'), clip: { x: 0, y: 220, width: 620, height: 200 } });
  await page.mouse.move(2, 2);
  // Capture one hovered and one pressed Join, for the record.
  const join = gallery.getByRole('button', { name: 'Primary' }).first();
  await join.hover();
  await page.mouse.down();
  await page.waitForTimeout(250);
  await join.screenshot({ path: path.join(OUT_DIR, 'button-primary-pressed.png') });
  await page.mouse.up();
});

test('high contrast and reduced transparency', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, 'desktop');
  // Through the store, the way Settings does it, so the hook writes the attributes.
  await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setTheme', 'glass-contrast');
  await page.waitForTimeout(400);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass-contrast');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog').first()).toBeVisible();
  await shoot(page, 'hc-palette', 'desktop');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More message tools' }).click();
  await shoot(page, 'hc-tools-menu', 'desktop');
  await page.keyboard.press('Escape');
  await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', true, 'appearance');
  await page.waitForTimeout(500);
  await shoot(page, 'hc-settings', 'desktop');
  await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', false);
  await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setTheme', 'glass');
  await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setTransparency', 'reduced');
  await page.waitForTimeout(400);
  await expect(page.locator('html')).toHaveAttribute('data-reduced-transparency', 'true');
  await page.getByRole('button', { name: 'More message tools' }).click();
  await shoot(page, 'reduced-tools-menu', 'desktop');
  const menuBackground = await page.getByRole('menu', { name: 'Message tools' }).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, blur: cs.backdropFilter };
  });
  // Opaque and unblurred under reduced transparency.
  expect(menuBackground.blur).toBe('none');
  expect(menuBackground.bg).not.toMatch(/rgba\(.*0\.\d+\)$/);
});

/** Every section of both settings windows, so nothing in the long tail goes unseen. */
const USER_SECTIONS = ['account', 'appearance', 'voice', 'notifications', 'activity', 'keybinds', 'identity', 'about'];
const GUILD_SECTIONS = [
  'overview', 'server-hub', 'channels', 'emojis', 'stickers', 'soundboard', 'events', 'sports', 'file-storage',
  'roles', 'members', 'invites', 'onboarding', 'economy', 'bot-store', 'bots', 'webhooks', 'bans', 'automod',
  'mod-templates', 'reports', 'audit-log',
];

test('every settings section', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize(SIZES.desktop);
  await installGlassScene(page);
  await page.goto(general);
  await expect(page.getByRole('main')).toBeVisible();
  for (const section of USER_SECTIONS) {
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', true, section);
    await page.waitForTimeout(500);
    await shoot(page, `all-user-${section}`, 'desktop');
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setUserSettingsOpen', false);
    await page.waitForTimeout(250);
  }
  for (const section of GUILD_SECTIONS) {
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'openGuildSettings', '1001', section);
    await page.waitForTimeout(600);
    await shoot(page, `all-guild-${section}`, 'desktop');
    await callStore(page, '/src/stores/uiStore.ts', 'useUIStore', 'setGuildSettingsId', null);
    await page.waitForTimeout(250);
  }
});

test('login page', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* storage unavailable */
    }
  });
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/setup/status')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ setup_required: false, instance_name: 'Glass' }) });
    if (url.pathname === '/api/v1/instance')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ setup_required: false, instance_name: 'Glass' }) });
    if (url.pathname.endsWith('/auth/refresh')) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"UNAUTHORIZED"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  for (const [name, url] of [
    ['login', '/login'],
    ['register', '/register'],
    ['connect', '/connect'],
  ] as const) {
    for (const size of ['desktop', 'phone'] as const) {
      await page.setViewportSize(SIZES[size]);
      await page.goto(url);
      await page.waitForTimeout(800);
      await shoot(page, `auth-${name}`, size);
    }
  }
});
