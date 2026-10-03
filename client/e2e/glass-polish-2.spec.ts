import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fakeLoungeMedia } from './fixtures/glass/calls';
import { installGlassScene } from './fixtures/glass/install';
import { CAST, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * Glass polish 2 (docs/design/glass-polish-2-checkpoint.md): what each item looks like and does in
 * the running app, on the mocked Glass scene (no server, no media stack), at 1440x900 and
 * 390x844.
 *
 *   1. The call pill above sheets: a sheet draws the pill in its own header, so the call's
 *      controls stay one press away, clear of the title and the close button.
 *   2. The camera crop anchor: a portrait camera in a wide tile keeps its faces (the real
 *      CanvasRenderer, the options the stage really passes).
 *   3. Reactions for screen readers: a polite live region, at most one line every two seconds.
 *   4. One Watch button in an expanded pill, not two with one name.
 *   5. A window resized across 768px keeps its open dialogs and sheets.
 *   6. The call with no cameras on.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=polish-2 npx playwright test -c e2e/glass-polish-2.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/*.png
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'polish-2';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;
type Size = keyof typeof SIZES;

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
const lounge = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.lounge}`;
const dmBrendan = `/app/dms/${CH.dmBrendan}`;

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

async function open(page: Page, size: Size | { width: number; height: number }, route: string, quiet = false) {
  await page.setViewportSize(typeof size === 'string' ? SIZES[size] : size);
  await installGlassScene(page, { quiet });
  await page.goto(route);
  await expect(page.getByRole('main')).toBeVisible();
}

async function shoot(page: Page, name: string) {
  const size = page.viewportSize();
  if (size) await page.mouse.move(size.width - 3, size.height - 3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
}

/** No Glass layout move still playing (stageTransition.ts names its animations `glass-morph:*`). */
async function settled(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.getAnimations().filter((a) => a.id.startsWith('glass-morph:') && a.playState === 'running').length
            + document.querySelectorAll('.glass-morph > *').length,
        ),
      { timeout: 5_000 },
    )
    .toBe(0);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('no box');
  return b;
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const stagePane = (page: Page) => page.getByRole('region', { name: 'Stage' });

/* ================================================================== 1. The pill above sheets */

for (const size of ['desktop', 'phone'] as const) {
  test(`the call pill stays reachable over a sheet at ${size}`, async ({ page }) => {
    await open(page, size, general);
    await fakeLoungeMedia(page, { mode: 'joined' });
    const header = page.getByRole('main');
    const underneath = header.getByRole('region', { name: 'Lounge, live voice channel' });
    await expect(underneath.getByRole('button', { name: 'Leave Lounge' })).toBeVisible();

    await page.getByRole('button', { name: 'Members' }).click();
    const sheet = page.getByRole('dialog', { name: 'Members' });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(500);

    // One pill to reach: the sheet's own, with the call's controls on it.
    const pill = sheet.getByRole('region', { name: 'Lounge, live voice channel' });
    await expect(pill).toBeVisible();
    await expect(page.getByRole('region', { name: 'Lounge, live voice channel' })).toHaveCount(1);
    await expect(pill.getByRole('button', { name: 'Microphone' })).toBeVisible();
    await expect(pill.getByRole('button', { name: 'Leave Lounge' })).toBeVisible();
    // The one under the sheet is out of the tab order and the accessibility tree.
    await expect(page.locator('main .glass-header .glass-pill, main .glass-conversation__phone-pill .glass-pill')).toHaveAttribute('inert', '');

    // Clear of the sheet's title and its close button, and inside the sheet.
    const sheetBox = await box(sheet);
    const pillBox = await box(pill);
    const closeBox = await box(sheet.getByRole('button', { name: 'Close' }));
    const titleBox = await box(sheet.locator('.glass-sheet__title'));
    expect(overlaps(pillBox, closeBox), 'the pill overlaps the close button').toBe(false);
    expect(overlaps(pillBox, titleBox), 'the pill overlaps the title').toBe(false);
    expect(pillBox.x).toBeGreaterThanOrEqual(sheetBox.x);
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width);
    expect(pillBox.y).toBeGreaterThanOrEqual(sheetBox.y);
    if (size === 'desktop') {
      // Where the header's was: right aligned to the column, 6px under the header's top.
      expect(pillBox.height).toBeCloseTo(52, 0);
      expect(pillBox.y - sheetBox.y).toBeLessThan(16);
    } else {
      // A row above the sheet's header, edge to edge (12px in).
      const headerBox = await box(sheet.locator('.glass-sheet__header'));
      expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(headerBox.y + 1);
      expect(pillBox.x).toBeCloseTo(sheetBox.x + 12, 0);
    }
    await shoot(page, `sheet-pill-people-${size}`);

    // The focus went to the sheet's own first control, not onto the pill.
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toMatch(/^Close/);

    // Usable: the mic turns, the roster opens over the page, Escape puts the roster away and not the sheet.
    await pill.getByRole('button', { name: 'Show who\'s in Lounge' }).click();
    await expect(pill.getByRole('list', { name: 'In Lounge' })).toBeVisible();
    await page.waitForTimeout(900);
    await shoot(page, `sheet-pill-expanded-${size}`);
    await page.keyboard.press('Escape');
    await expect(pill.getByRole('list', { name: 'In Lounge' })).toBeHidden();
    await expect(sheet).toBeVisible();

    // Tab reaches the pill's buttons and stays inside the sheet.
    const reached = new Set<string>();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => ({
        inside: document.activeElement?.closest('[role="dialog"]') !== null,
        label: document.activeElement?.getAttribute('aria-label') ?? '',
      }));
      expect(info.inside).toBe(true);
      reached.add(info.label);
    }
    expect(reached.has('Leave Lounge')).toBe(true);

    // The next Escape is the sheet's, and the header's pill is back and reachable.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('region', { name: 'Lounge, live voice channel' })).toHaveCount(1);
    await expect(header.getByRole('region', { name: 'Lounge, live voice channel' }).getByRole('button', { name: 'Leave Lounge' })).toBeVisible();
    await expect(page.locator('main .glass-pill')).not.toHaveAttribute('inert', '');
  });

  test(`the pill sits beside the search field at ${size}, not over it`, async ({ page }) => {
    await open(page, size, general);
    await fakeLoungeMedia(page, {});
    await expect(page.getByRole('main').getByRole('region', { name: 'Lounge, live voice channel' })).toBeVisible();
    await page.getByRole('button', { name: 'Search messages' }).click();
    const sheet = page.getByRole('dialog', { name: 'Search messages' });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(500);
    const pill = sheet.getByRole('region', { name: 'Lounge, live voice channel' });
    await expect(pill).toBeVisible();
    await expect(pill.getByRole('button', { name: 'Join Lounge' })).toBeVisible();
    const field = await box(sheet.locator('.glass-search__field'));
    const pillBox = await box(pill);
    const closeBox = await box(sheet.getByRole('button', { name: 'Close search' }));
    expect(overlaps(pillBox, field), 'the pill overlaps the search field').toBe(false);
    expect(overlaps(pillBox, closeBox), 'the pill overlaps the close button').toBe(false);
    // The field is still a field: wide enough to type in.
    if (size === 'desktop') expect(field.width).toBeGreaterThan(400);
    await shoot(page, `sheet-pill-search-${size}`);
    await page.getByRole('combobox', { name: 'Search messages' }).fill('movie');
    await expect(sheet.getByText('results').first()).toBeVisible({ timeout: 3000 }).catch(() => {});
  });
}

test('a channel menu page keeps the pill too, and a pill that has nothing to show takes no room', async ({ page }) => {
  await open(page, 'desktop', general);
  await page.waitForTimeout(500);
  await page.getByRole('main').getByRole('button', { name: 'General', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Pinned messages' }).click();
  const sheet = page.getByRole('dialog', { name: 'Pinned messages' });
  await expect(sheet).toBeVisible();
  // A live channel is somewhere (Game Night's Lounge): its pill is in the sheet, and only there.
  await expect(page.getByRole('region', { name: /live voice channel/ })).toHaveCount(1);
  await expect(sheet.getByRole('region', { name: /live voice channel/ })).toBeVisible();
  // Page tabs under the sheet header still work with the pill in it.
  await sheet.getByRole('tab', { name: 'Media' }).click();
  await expect(page.getByRole('dialog', { name: 'Media' }).getByRole('region', { name: /live voice channel/ })).toBeVisible();
  await shoot(page, 'sheet-pill-media-desktop');

  // Nothing live and no call: no pill, and the slot has no room in the header.
  await page.evaluate(async () => {
    const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
    voice.useVoiceStore.setState({ channelParticipants: new Map() });
  });
  await expect(page.getByRole('region', { name: /live voice channel/ })).toHaveCount(0);
  const slot = page.getByRole('dialog', { name: 'Media' }).locator('.glass-sheet__pill');
  await expect(slot).toBeEmpty();
  expect(await slot.evaluate((el) => getComputedStyle(el).display)).toBe('none');
  await shoot(page, 'sheet-no-pill-desktop');
});

/* ================================================================== 4. One Watch button */

test('an expanded pill has one Watch button for a screen reader, and the preview still works for the mouse', async ({ page }) => {
  await open(page, 'desktop', general);
  const pill = page.getByRole('main').getByRole('region', { name: 'Lounge, live voice channel' });
  await pill.getByRole('button', { name: "Show who's in Lounge" }).click();
  await expect(pill.locator('.glass-pill__preview')).toBeVisible();
  await expect(pill.getByRole('button', { name: "Watch Vincent's screen" })).toHaveCount(1);
  await expect(pill.locator('.glass-pill__preview')).toHaveAttribute('aria-hidden', 'true');
  await expect(pill.locator('.glass-pill__preview')).toHaveAttribute('tabindex', '-1');
  const names = await pill.getByRole('button').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label') ?? n.textContent));
  expect(names.filter((name) => /Watch Vincent/.test(name ?? ''))).toHaveLength(1);
  await shoot(page, 'pill-expanded-one-watch-desktop');
  // The mouse still gets the big target.
  await pill.locator('.glass-pill__preview').click();
  await expect(stagePane(page)).toBeVisible();
});

/* ================================================================== 3. Reactions for screen readers */

test('reactions are announced politely, once every two seconds, never your own', async ({ page }) => {
  await open(page, 'desktop', general);
  await fakeLoungeMedia(page, { mode: 'joined' });
  await page.getByRole('main').getByRole('button', { name: "Watch Vincent's screen" }).click();
  const stage = stagePane(page);
  await expect(stage).toBeVisible();
  const live = stage.getByTestId('stream-reactions-live');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveText('');

  const react = (who: string, name: string, kind = 'flame', count = 1) =>
    page.evaluate(
      async ({ who: userId, name: display, kind: k, count: n, ids }) => {
        const store = (await import('/src/stores/streamReactionStore.ts' as string)) as any;
        const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
        const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
        const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
        store.useStreamReactionStore.getState().receive(serverId, {
          guild_id: ids.guild,
          channel_id: ids.lounge,
          reactions: [{ user_id: userId, stream_user_id: ids.vincent, kind: k, count: n, nonce: null, username: display.toLowerCase(), display_name: display, avatar_hash: null }],
        });
      },
      { who, name, kind, count, ids: { guild: GAME_NIGHT_ID, lounge: CH.lounge, vincent: CAST.vincent.id } },
    );

  await react(CAST.brendan.id, 'Brendan');
  await expect(live).toHaveText('Brendan reacted with a flame');
  // A burst inside the interval is held, then said once.
  await react(CAST.nick.id, 'Nick', 'heart');
  await react(CAST.luke.id, 'Luke');
  await react(CAST.jeremy.id, 'Jeremy', 'heart');
  await page.waitForTimeout(600);
  await expect(live).toHaveText('Brendan reacted with a flame');
  await expect(live).toHaveText('3 reactions', { timeout: 3000 });
  // Your own is never said.
  await page.evaluate(async ({ ids }) => {
    const store = (await import('/src/stores/streamReactionStore.ts' as string)) as any;
    const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
    const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
    const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
    const before = store.useStreamReactionStore.getState().bubbles.length;
    store.useStreamReactionStore.getState().send({ serverId, channelId: ids.lounge, streamerId: ids.vincent }, 'flame');
    return before;
  }, { ids: { lounge: CH.lounge, vincent: CAST.vincent.id } });
  await page.waitForTimeout(2600);
  await expect(live).not.toContainText('Sean');
});

/* ================================================================== 2. The camera crop anchor */

/**
 * The call engine of a held call whose camera is a PORTRAIT picture (540x960): drawn by the real
 * `CanvasRenderer` with whatever `fit` and `anchor` the stage asks for (or, for the control, with
 * the anchor left out). The picture is bands of known colors at known heights, so what is
 * cropped can be read off a screenshot: green at 17-22% of the way down, red at 71-76%, a pale
 * head at 8-30% and a scale of ticks and labels every 10%.
 */
async function holdPortraitCamera(page: Page, options: { ignoreAnchor: boolean }) {
  await page.evaluate(
    async ({ ids, ignoreAnchor }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const renderer = (await import('/src/lib/media/video/canvasRenderer.ts' as string)) as any;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const scope = { serverId, userId: ids.sean };
      const store = voice.useVoiceStore;

      const W = 540;
      const H = 960;
      const source = new OffscreenCanvas(W, H);
      const g = source.getContext('2d') as OffscreenCanvasRenderingContext2D;
      const gradient = g.createLinearGradient(0, 0, 0, H);
      gradient.addColorStop(0, '#8a8f98');
      gradient.addColorStop(1, '#2c2f36');
      g.fillStyle = gradient;
      g.fillRect(0, 0, W, H);
      // A person: head at 8-30%, shoulders from 50%.
      g.fillStyle = '#e8c9a8';
      g.beginPath();
      g.ellipse(W / 2, H * 0.19, 78, 0.11 * H, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#202228';
      g.beginPath();
      g.ellipse(W / 2 - 30, H * 0.17, 8, 8, 0, 0, Math.PI * 2);
      g.ellipse(W / 2 + 30, H * 0.17, 8, 8, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#3b4a63';
      g.beginPath();
      g.ellipse(W / 2, H * 0.72, 250, 0.22 * H, 0, Math.PI, 0);
      g.fill();
      // The markers.
      g.fillStyle = '#00ff00';
      g.fillRect(0, H * 0.17, 40, H * 0.05);
      g.fillStyle = '#ff0000';
      g.fillRect(0, H * 0.71, 40, H * 0.05);
      g.fillStyle = '#ffffff';
      g.font = 'bold 22px sans-serif';
      for (let tick = 0; tick <= 100; tick += 10) {
        const y = Math.min(H - 2, (tick / 100) * H);
        g.fillRect(W - 60, y, 60, 2);
        g.fillText(`${tick}%`, W - 130, Math.min(H - 8, Math.max(24, y + 8)));
      }
      const pixels = g.getImageData(0, 0, W, H);
      const rgba = new Uint8Array(pixels.data.buffer);

      const engine = {
        subscribeVideo(userId: string, canvas: HTMLCanvasElement, onFrame?: () => void, opts?: { preferredTrackId?: string; fit?: string; anchor?: unknown }) {
          if (userId !== ids.brendan || opts?.preferredTrackId !== 'camera') return () => {};
          (window as any).__cameraOptions = { fit: opts.fit, anchor: opts.anchor };
          const drawer = new renderer.CanvasRenderer(canvas, { fit: opts.fit, anchor: ignoreAnchor ? undefined : opts.anchor });
          const paint = () => {
            drawer.drawRgba(rgba, W, H);
            onFrame?.();
          };
          paint();
          const timer = setInterval(paint, 250);
          return () => {
            clearInterval(timer);
            drawer.destroy();
          };
        },
        tapVideoFrames: () => ({ route: Promise.resolve('no-track'), release: () => {} }),
        listPublishedTracks: async () => [],
        registerTrackSubscription: async () => {},
      };
      const row = (userId: string, name: string, over: Record<string, unknown> = {}) => ({
        user_id: userId,
        channel_id: ids.lounge,
        guild_id: ids.guild,
        session_id: `e2e-${userId}`,
        username: name.toLowerCase(),
        display_name: name,
        avatar_hash: null,
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: false,
        self_stream: false,
        self_video: false,
        suppress: false,
        mode: 'joined',
        ...over,
      });
      const rows = [row(ids.brendan, 'Brendan', { self_video: true }), row(ids.sean, 'Sean')];
      const put = () => {
        const current = store.getState();
        const there = current.channelParticipants.get(ids.lounge) ?? [];
        if (there.some((s: any) => s.user_id === ids.sean) && current.callId === 'e2e-call') return;
        const channelParticipants = new Map(current.channelParticipants);
        channelParticipants.set(ids.lounge, rows);
        store.setState({
          channelParticipants,
          callId: 'e2e-call',
          callScope: scope,
          callPhase: 'connected',
          callMode: 'joined',
          connected: true,
          joining: false,
          channelId: ids.lounge,
          guildId: ids.guild,
          selfMute: false,
          mediaEngine: engine,
          participants: new Map(rows.map((s) => [s.user_id, s])),
          speakingUsers: new Set([ids.brendan]),
          leaveChannel: async () => store.setState({ callId: null, callPhase: 'closed', connected: false, channelId: null, guildId: null }),
        });
      };
      put();
      store.subscribe(put);
    },
    {
      ids: { sean: CAST.sean.id, brendan: CAST.brendan.id, lounge: CH.lounge, guild: GAME_NIGHT_ID },
      ignoreAnchor: options.ignoreAnchor,
    },
  );
}

/** What colors a tile's screenshot holds: whether pure green and pure red rows are in it. */
async function markers(tile: Locator): Promise<{ green: number; red: number; width: number; height: number }> {
  const png = await tile.screenshot();
  const { PNG } = createRequire(import.meta.url)('pngjs') as { PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } } };
  const image = PNG.sync.read(png);
  let green = 0;
  let red = 0;
  for (let y = 0; y < image.height; y++) {
    // The markers are 40px of the source's left edge; look along the tile's left third.
    let rowGreen = false;
    let rowRed = false;
    for (let x = 0; x < Math.floor(image.width / 3); x++) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
      // (The tile's own shade darkens the bottom of the picture, so red is only red-ish there.)
      if (g > 200 && r < 60 && b < 60) rowGreen = true;
      if (r > 90 && g < 40 && b < 40) rowRed = true;
    }
    if (rowGreen) green += 1;
    if (rowRed) red += 1;
  }
  return { green, red, width: image.width, height: image.height };
}

test('a portrait camera in a wide tile keeps its faces: the crop falls toward the top', async ({ page }) => {
  await open(page, 'desktop', lounge);
  await holdPortraitCamera(page, { ignoreAnchor: false });
  await page.getByRole('main').getByRole('region', { name: 'Lounge, live voice channel' }).getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  await expect(stage).toBeVisible();
  // The stage asked for a cover crop around the upper third.
  expect(await page.evaluate(() => (window as any).__cameraOptions)).toEqual({ fit: 'cover', anchor: { x: 0.5, y: 0.35 } });
  const tile = stage.locator('.glass-stage__tile').first();
  await expect(tile).toBeVisible();
  await page.waitForTimeout(1200);
  const anchored = await markers(tile);
  await shoot(page, 'camera-anchor-desktop');

  // What fraction of the picture the tile shows, from its own shape: the portrait source is 9:16.
  const visible = (9 / 16) / (anchored.width / anchored.height);
  expect(visible, 'the tile should be much shorter than the picture for this to say anything').toBeLessThan(0.7);
  // Anchored 35%: the window is [0.35(1-v), 0.35(1-v)+v]. Green (17-22%) is in it, red (71-76%) is not.
  const top = 0.35 * (1 - visible);
  expect(top).toBeLessThan(0.17);
  expect(top + visible).toBeLessThan(0.71);
  expect(anchored.green, 'the face band is in the tile').toBeGreaterThan(anchored.height * 0.03);
  expect(anchored.red, 'the bottom band has been cropped away').toBe(0);
});

test('the same camera, cropped about the center (what it did before): the face band is cut off', async ({ page }) => {
  await open(page, 'desktop', lounge);
  await holdPortraitCamera(page, { ignoreAnchor: true });
  await page.getByRole('main').getByRole('region', { name: 'Lounge, live voice channel' }).getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  await expect(stage).toBeVisible();
  const tile = stage.locator('.glass-stage__tile').first();
  await expect(tile).toBeVisible();
  await page.waitForTimeout(1200);
  const centered = await markers(tile);
  await shoot(page, 'camera-center-control-desktop');
  const visible = (9 / 16) / (centered.width / centered.height);
  expect((1 - visible) / 2).toBeGreaterThan(0.22);
  expect(centered.green, 'the face band is cropped off the top').toBe(0);
  expect(centered.red, 'the bottom band stays').toBeGreaterThan(centered.height * 0.03);
});

/* ================================================================== 6. The call with no cameras */

/**
 * This client holds a call in `channelId`. Brendan talks, Nick is muted, and nobody has a camera
 * on; `sharing` has Vincent share his screen as well.
 */
async function holdCameraless(page: Page, target: { channelId: string; guildId: string | null }, sharing = false) {
  await page.evaluate(
    async ({ ids, target, sharing }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const levels = (await import('/src/lib/motion/voiceLevel.ts' as string)) as any;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const scope = { serverId, userId: ids.sean };
      const store = voice.useVoiceStore;
      const row = (userId: string, name: string, over: Record<string, unknown> = {}) => ({
        user_id: userId,
        channel_id: target.channelId,
        guild_id: target.guildId,
        session_id: `e2e-${userId}`,
        username: name.toLowerCase(),
        display_name: name,
        avatar_hash: null,
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: false,
        self_stream: false,
        self_video: false,
        suppress: false,
        mode: 'joined',
        ...over,
      });
      const rows = [
        row(ids.brendan, 'Brendan'),
        ...(target.guildId ? [row(ids.nick, 'Nick', { self_mute: true }), row(ids.luke, 'Luke'), row(ids.jeremy, 'Jeremy', { mode: 'listen', self_mute: true })] : []),
        ...(target.guildId && sharing ? [row(ids.vincent, 'Vincent', { self_stream: true })] : []),
        row(ids.sean, 'Sean'),
      ];
      const put = () => {
        const current = store.getState();
        const there = current.channelParticipants.get(target.channelId) ?? [];
        if (there.some((s: any) => s.user_id === ids.sean) && current.callId === 'e2e-call') return;
        const channelParticipants = new Map(current.channelParticipants);
        channelParticipants.set(target.channelId, rows);
        store.setState({
          channelParticipants,
          callId: 'e2e-call',
          callScope: scope,
          callPhase: 'connected',
          callMode: 'joined',
          connected: true,
          joining: false,
          channelId: target.channelId,
          guildId: target.guildId ?? 'dm',
          selfMute: false,
          mediaEngine: { subscribeVideo: () => () => {}, tapVideoFrames: () => ({ route: Promise.resolve('no-track'), release: () => {} }), listPublishedTracks: async () => [], registerTrackSubscription: async () => {} },
          participants: new Map(rows.map((s) => [s.user_id, s])),
          speakingUsers: new Set([ids.brendan]),
          leaveChannel: async () => store.setState({ callId: null, callPhase: 'closed', connected: false, channelId: null, guildId: null }),
        });
      };
      put();
      store.subscribe(put);
      // What the media engine does a few times a second: Brendan's voice level.
      const speak = () => levels.publishVoiceLevels('room', new Map([[ids.brendan, 0.55 + 0.35 * Math.sin(Date.now() / 260)]]));
      speak();
      setInterval(speak, 250);
    },
    {
      ids: { sean: CAST.sean.id, brendan: CAST.brendan.id, nick: CAST.nick.id, luke: CAST.luke.id, jeremy: CAST.jeremy.id, vincent: CAST.vincent.id },
      target,
      sharing,
    },
  );
}

test('the call with nobody on camera: the faces, the call, and that no one is sharing (desktop)', async ({ page }) => {
  await open(page, 'desktop', lounge, true);
  await holdCameraless(page, { channelId: CH.lounge, guildId: GAME_NIGHT_ID });
  const pill = page.getByRole('main').getByRole('region', { name: 'Lounge, live voice channel' });
  await pill.getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  await expect(stage).toBeVisible();
  const empty = stage.locator('.glass-call-empty');
  await expect(empty).toBeVisible();
  await expect(stage.getByRole('status')).toHaveText('No one is sharing');
  await expect(stage.getByRole('list', { name: 'People in the call' }).getByRole('listitem')).toHaveCount(5);
  await expect(stage.locator('.glass-call-empty__name')).toHaveText('Game Night Lounge');
  await expect(stage.locator('.glass-call-empty__person[data-talking="true"]')).toContainText('Brendan');
  await expect(stage.locator('.glass-call-empty__person[data-talking="true"] .glass-call-empty__wave')).toBeVisible();
  await expect(stage.locator('.glass-call-empty__person', { hasText: 'Nick' })).toContainText('Muted');
  await expect(stage.locator('.glass-call-empty__person', { hasText: 'Jeremy' })).toContainText('Listening in');
  // The controls stay where they were.
  const row = stage.getByRole('group', { name: 'Call controls' });
  await expect(row.getByRole('button', { name: 'Camera' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Leave Lounge' })).toBeVisible();

  // Centered in the space the stage gives the people: the faces and the text as one group.
  // "Show the call" plays the 650ms pill-to-stage move on transforms: measure once it settled.
  await settled(page);
  const main = await box(stage.locator('.glass-stage__call-main'));
  const people = await box(stage.locator('.glass-call-empty__people'));
  const text = await box(stage.locator('.glass-call-empty__text'));
  const groupCenterX = (Math.min(people.x, text.x) + Math.max(people.x + people.width, text.x + text.width)) / 2;
  expect(Math.abs(groupCenterX - (main.x + main.width / 2))).toBeLessThan(6);
  const groupTop = people.y;
  const groupBottom = text.y + text.height;
  expect(Math.abs((groupTop + groupBottom) / 2 - (main.y + main.height / 2))).toBeLessThan(40);
  // Large: five people are 96px faces.
  const faceBox = await box(stage.locator('.glass-call-empty__face').first());
  expect(faceBox.width).toBeGreaterThan(94);
  expect(faceBox.width).toBeLessThan(98);
  await shoot(page, 'call-empty-desktop');
});

test('the call with nobody on camera: someone starts sharing, and their face opens their screen (desktop)', async ({ page }) => {
  await open(page, 'desktop', lounge, true);
  await holdCameraless(page, { channelId: CH.lounge, guildId: GAME_NIGHT_ID });
  await page.getByRole('main').getByRole('region', { name: 'Lounge, live voice channel' }).getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  await expect(stage.getByRole('status')).toHaveText('No one is sharing');
  await page.evaluate(
    async ({ ids }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const store = voice.useVoiceStore;
      const channelParticipants = new Map(store.getState().channelParticipants);
      const there = channelParticipants.get(ids.lounge) as any[];
      channelParticipants.set(ids.lounge, [
        { ...there[0], user_id: ids.vincent, username: 'vincent', display_name: 'Vincent', session_id: 'e2e-vincent', self_stream: true, self_mute: false },
        ...there,
      ]);
      store.setState({ channelParticipants });
    },
    { ids: { lounge: CH.lounge, vincent: CAST.vincent.id } },
  );
  await expect(stage.getByRole('status')).toHaveText('Vincent is sharing their screen');
  const vincent = stage.locator('.glass-call-empty__person', { hasText: 'Vincent' });
  await expect(vincent).toHaveAttribute('data-ring', 'amber');
  await expect(vincent).toContainText('Sharing screen');
  await expect(stage.getByRole('button', { name: "Watch Vincent's screen" })).toHaveCount(1);
  await shoot(page, 'call-empty-sharing-desktop');
  // Their face opens their screen: the stage becomes the stream's.
  await stage.getByRole('button', { name: "Watch Vincent's screen" }).click();
  await expect(stage.locator('.glass-stage__stream')).toBeVisible();
});

test('the call with nobody on camera, on a phone: the card, then full screen', async ({ page }) => {
  await open(page, 'phone', lounge, true);
  await holdCameraless(page, { channelId: CH.lounge, guildId: GAME_NIGHT_ID });
  await page.getByRole('main').getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  await expect(stage).toBeVisible();
  await expect(stage.locator('.glass-call-empty')).toBeVisible();
  await expect(stage.locator('.glass-call-empty__person')).toHaveCount(5);
  // The card's chrome names the call; the empty state draws no name or line of its own.
  await expect(stage.locator('.glass-call-empty__name')).toHaveCount(0);
  await expect(stage.getByRole('status')).toHaveText('No one is sharing');
  await expect(stage.getByRole('status')).toHaveClass(/sr-only/);
  // Every face sits inside the card.
  const card = await box(stage);
  for (const face of await stage.locator('.glass-call-empty__face').all()) {
    const faceBox = await box(face);
    expect(faceBox.x).toBeGreaterThanOrEqual(card.x);
    expect(faceBox.x + faceBox.width).toBeLessThanOrEqual(card.x + card.width);
    expect(faceBox.y).toBeGreaterThanOrEqual(card.y);
    expect(faceBox.y + faceBox.height).toBeLessThanOrEqual(card.y + card.height);
  }
  await shoot(page, 'call-empty-phone');
  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect(page.getByRole('group', { name: 'Call controls' })).toBeVisible();
  await shoot(page, 'call-empty-phone-fullscreen');
});

test('a DM call with nobody on camera (desktop)', async ({ page }) => {
  await open(page, 'desktop', dmBrendan);
  await holdCameraless(page, { channelId: CH.dmBrendan, guildId: null });
  const pill = page.getByRole('main').getByRole('region', { name: 'Brendan, voice call' });
  await pill.getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  await expect(stage.locator('.glass-call-empty')).toBeVisible();
  await expect(stage.getByRole('list', { name: 'People in the call' }).getByRole('listitem')).toHaveCount(2);
  await shoot(page, 'call-empty-dm-desktop');
});

test('a camera turning on puts the tiles back, and off puts the faces back', async ({ page }) => {
  await open(page, 'desktop', lounge, true);
  await holdCameraless(page, { channelId: CH.lounge, guildId: GAME_NIGHT_ID });
  await page.getByRole('main').getByRole('region', { name: 'Lounge, live voice channel' }).getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  await expect(stage.locator('.glass-call-empty')).toBeVisible();
  const setCamera = (on: boolean) =>
    page.evaluate(
      async ({ on, ids }) => {
        const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
        const store = voice.useVoiceStore;
        const channelParticipants = new Map(store.getState().channelParticipants);
        channelParticipants.set(
          ids.lounge,
          (channelParticipants.get(ids.lounge) as any[]).map((s) => (s.user_id === ids.brendan ? { ...s, self_video: on } : s)),
        );
        store.setState({ channelParticipants });
      },
      { on, ids: { lounge: CH.lounge, brendan: CAST.brendan.id } },
    );
  await setCamera(true);
  await expect(stage.locator('.glass-call-empty')).toHaveCount(0);
  await expect(stage.locator('.glass-stage__tile')).toHaveCount(1);
  await setCamera(false);
  await expect(stage.locator('.glass-call-empty')).toBeVisible();
  await expect(stage.locator('.glass-stage__tile')).toHaveCount(0);
});

/* ================================================================== 5. Resizing across 768px */

test('a window resized across the phone breakpoint keeps its dialog, its draft and its sheet', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, { width: 1000, height: 800 }, general);
  await expect(page.getByText('home in 20. what are we playing tonight?')).toBeVisible();
  // An edited message, and the history the dialog loads.
  const target = await page.evaluate(
    async ({ channel, userId }) => {
      const messages = (await import('/src/stores/messageStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const store = messages.getMessageStore({ serverId, userId });
      const all = store.getState().messages as Record<string, any[]>;
      const key = Object.keys(all).find((k) => k === channel || k.endsWith(`:${channel}`) || k.includes(channel));
      const mine = ((key ? all[key] : []) as any[]).find((m) => m.content?.startsWith('home in 20'));
      if (!mine) return `no message; keys ${Object.keys(all).join(',')}`;
      store.getState().updateMessage(channel, { id: mine.id, edited_timestamp: '2026-10-01T20:59:00-05:00' });
      return mine.id as string;
    },
    { channel: CH.general, userId: CAST.sean.id },
  );
  expect(target, 'the scene has the message to edit').toMatch(/^\d+$/);
  await page.route(/\/api\/v1\/channels\/\d+\/messages\/\d+\/edits$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // The messaging runtime checks the history epoch on every message response.
      headers: { 'X-Paracord-History-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      body: JSON.stringify([{ id: '9001', message_id: target, content: 'home in 15. what are we playing tonight?', edited_at: '2026-10-01T20:59:00-05:00' }]),
    }),
  );

  // Open the dialog (held in the message list's local state), type a draft, scroll the timeline.
  await page.getByRole('button', { name: `Show edit history for message ${target}` }).click();
  const history = page.getByRole('dialog', { name: 'Edit history' });
  await expect(history).toBeVisible();
  await expect(page.getByText('home in 15.')).toBeVisible();
  const composer = page.getByRole('textbox').last();
  await composer.fill('half a thought');
  // Mark the pane's node: a rebuilt frame would be a different node.
  await page.evaluate(() => {
    (window as any).__main = document.getElementById('main-content');
    (window as any).__page = document.querySelector('.glass-outlet');
  });
  await shoot(page, 'resize-1-wide-dialog');

  // Across the breakpoint to a phone, and back, twice.
  for (const [width, label] of [[700, 'phone'], [1000, 'wide'], [700, 'phone-again'], [1000, 'wide-again']] as const) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator('.glass-frame')).toHaveAttribute('data-layout', width < 768 ? 'phone' : 'wide');
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() => ({
        sameMain: (window as any).__main === document.getElementById('main-content'),
        samePage: (window as any).__page === document.querySelector('.glass-outlet'),
      })),
      label,
    ).toEqual({ sameMain: true, samePage: true });
    await expect(history, label).toBeVisible();
    await expect(page.getByText('home in 15.'), label).toBeVisible();
    await expect(page.getByRole('textbox').last(), label).toHaveValue('half a thought');
    if (label === 'phone') await shoot(page, 'resize-2-phone-dialog');
  }
  await shoot(page, 'resize-3-wide-again-dialog');

  // A sheet stays open across the swap too, in the window's own frame.
  await page.getByRole('button', { name: 'Close edit history' }).click();
  await expect(history).toBeHidden();
  await page.getByRole('button', { name: 'Members' }).click();
  const sheet = page.getByRole('dialog', { name: 'Members' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-host', 'pane');
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Members' })).toHaveAttribute('data-host', 'window');
  await page.waitForTimeout(600);
  await shoot(page, 'resize-4-sheet-phone');
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.getByRole('dialog', { name: 'Members' })).toHaveAttribute('data-host', 'pane');
  await page.waitForTimeout(600);
  await shoot(page, 'resize-5-sheet-wide');
});
