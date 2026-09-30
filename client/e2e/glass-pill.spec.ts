import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { BASECAMP_ID, CAST, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * WP-G12 (the call pill): the pill on the Glass reference scene, mocked like
 * glass-review.spec.ts (no server, no media stack), at 1440x900 and 390x844.
 * Each test drives the app the way a person does (a click on the faces, on
 * Listen, a key) and shoots what the pill draws; the listen state itself is
 * put into `voiceStore` from the page, because a listen needs a media relay.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g12 npx playwright test -c e2e/glass-pill.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/pill-*.png and pill-rects.json
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'g12';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
const trips = `/app/guilds/${BASECAMP_ID}/channels/${CH.trips}`;
const dm = `/app/dms/${CH.dmBrendan}`;

const rects: Record<string, unknown> = {};

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(path.join(OUT_DIR, 'pill-rects.json'), JSON.stringify(rects, null, 2));
});

async function open(page: Page, route: string, size: keyof typeof SIZES = 'desktop', options: { quiet?: boolean } = {}) {
  await page.setViewportSize(SIZES[size]);
  await installGlassScene(page, { quiet: options.quiet });
  await page.goto(route);
  await expect(page.getByRole('main')).toBeVisible();
}

const pill = (page: Page) => page.getByRole('region', { name: /live voice channel|voice call/ });

async function shoot(page: Page, name: string) {
  const size = page.viewportSize();
  if (size) await page.mouse.move(size.width - 3, size.height - 3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('no box');
  return { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
}

interface Hold {
  mode: 'listen' | 'joined';
  /** Selfmute (the preference while listening). */
  muted?: boolean;
  /** Feed the ambient view with the fixture stream, so the preview draws a picture. */
  ambient?: boolean;
}

/**
 * Put this client in the Lounge's call. The state is what `voiceStore` holds
 * after a real join: the call, its mode, and this person's own voice state.
 */
async function holdCall(page: Page, hold: Hold) {
  await page.evaluate(
    async ({ hold: h, ids }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const scope = { serverId, userId: ids.sean };
      const store = voice.useVoiceStore;
      const muted = h.muted ?? h.mode === 'listen';
      const me = {
        user_id: ids.sean,
        channel_id: ids.lounge,
        guild_id: ids.guild,
        session_id: 'e2e-session',
        username: 'sean',
        display_name: 'Sean',
        avatar_hash: null,
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: muted,
        self_stream: false,
        self_video: false,
        suppress: false,
        mode: h.mode,
      };
      // The mocked gateway replays READY now and then, which rebuilds the guild's
      // voice states without this made-up call; put the call's own row back.
      const put = () => {
        const current = store.getState();
        const there = current.channelParticipants.get(ids.lounge) ?? [];
        if (there.some((s: { user_id: string }) => s.user_id === ids.sean && s.mode === h.mode)) return;
        const members = [...there.filter((s: { user_id: string }) => s.user_id !== ids.sean), me];
        const channelParticipants = new Map(current.channelParticipants);
        channelParticipants.set(ids.lounge, members);
        store.setState({
          callId: 'e2e-call',
          callScope: scope,
          callPhase: 'connected',
          callMode: h.mode,
          connected: true,
          joining: false,
          channelId: ids.lounge,
          guildId: ids.guild,
          selfMute: muted,
          channelParticipants,
          participants: new Map(members.map((s: { user_id: string }) => [s.user_id, s])),
          speakingUsers: new Set([ids.brendan]),
        });
      };
      put();
      store.subscribe(put);
      // What the media engine does a few times a second: Brendan's voice level.
      const levels = (await import('/src/lib/motion/voiceLevel.ts' as string)) as any;
      const speak = () => levels.publishVoiceLevels('room', new Map([[ids.brendan, 0.55 + 0.35 * Math.sin(Date.now() / 260)]]));
      speak();
      setInterval(speak, 250);
      if (h.ambient) {
        const fixture = (await import('/src/lib/room/fixtureFrameSource.ts' as string)) as any;
        const source = fixture.createFixtureFrameSource({ scene: 'stream', width: 320, height: 180 });
        const engine = {
          tapVideoFrames(_user: string, _track: string, onFrame: (frame: unknown) => void) {
            const stop = source.subscribe((bitmap: unknown) => onFrame(bitmap), 2);
            return { route: Promise.resolve('frames'), release: stop };
          },
        };
        store.setState({
          ambientView: {
            id: 'e2e-ambient',
            kind: 'ambient',
            scope,
            guildId: ids.guild,
            channelId: ids.lounge,
            streamerId: ids.vincent,
            route: 'session',
            phase: 'live',
            engine,
            sessionId: 'e2e-view',
            endReason: null,
            pauseReason: null,
            error: null,
          },
        });
      }
    },
    {
      hold,
      ids: {
        sean: CAST.sean.id,
        vincent: CAST.vincent.id,
        brendan: CAST.brendan.id,
        lounge: CH.lounge,
        guild: GAME_NIGHT_ID,
      },
    },
  );
}

test('01 compact, not joined (reading Game Night)', async ({ page }) => {
  await open(page, general);
  const p = pill(page);
  await expect(p).toBeVisible();
  await expect(p.getByRole('button', { name: 'Listen in to Lounge' })).toBeVisible();
  await expect(p.getByRole('button', { name: /^Watch Vincent's screen$/ })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Join Lounge' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Microphone on when you join' })).toHaveAttribute('aria-pressed', 'false');
  rects['01'] = {
    pill: await box(p),
    faces: await box(p.locator('.glass-pill__faces')),
    name: await box(p.locator('.glass-pill__name')),
    listen: await box(p.locator('.glass-pill__listen')),
    watch: await box(p.locator('.glass-pill__watch')),
    mute: await box(p.locator('.glass-pill__mute')),
    join: await box(p.locator('.glass-pill__join')),
    slot: await box(page.locator('.glass-header__pill')),
  };
  await shoot(page, 'pill-01-compact-desktop');
});

test('02 another server names the channel with its server', async ({ page }) => {
  await open(page, trips);
  const p = pill(page);
  await expect(p).toBeVisible();
  await expect(p.locator('.glass-pill__name')).toHaveText('Game Night Lounge');
  await expect(p).toHaveAttribute('aria-label', 'Game Night Lounge, live voice channel');
  rects['02'] = { pill: await box(p), name: await box(p.locator('.glass-pill__name')), join: await box(p.locator('.glass-pill__join')) };
  await shoot(page, 'pill-02-cross-server-desktop');
});

test('a direct message also shows the live channel, with its server', async ({ page }) => {
  await open(page, dm);
  await expect(pill(page).locator('.glass-pill__name')).toHaveText('Game Night Lounge');
});

test('quiet: nothing live and no call draws no pill, and the slot takes no room', async ({ page }) => {
  await open(page, `/app/guilds/${BASECAMP_ID}/channels/${CH.trips}`, 'desktop', { quiet: true });
  // Sunday League still has a match on, so use a route whose account has nothing live at all.
  await page.evaluate(async () => {
    const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
    voice.useVoiceStore.setState({ channelParticipants: new Map() });
  });
  await expect(pill(page)).toHaveCount(0);
  await expect(page.locator('.glass-header__pill')).toBeHidden();
});

test('03 expanded while listening in', async ({ page }) => {
  await open(page, general);
  await holdCall(page, { mode: 'listen', ambient: true });
  const p = pill(page);
  await expect(p.getByRole('button', { name: 'Stop listening in to Lounge' })).toHaveAttribute('aria-pressed', 'true');
  await expect(p.locator('.glass-pill__listen')).toContainText('Listening');
  await shoot(page, 'pill-03a-listening-compact-desktop');
  rects['03a'] = { pill: await box(p), listen: await box(p.locator('.glass-pill__listen')) };

  await p.getByRole('button', { name: "Show who's in Lounge" }).click();
  await expect(p).toHaveAttribute('data-phase', 'expanded');
  await expect(p.getByText("Everyone in Lounge can see you're listening in.")).toBeVisible();
  const roster = p.getByRole('list', { name: 'In Lounge' });
  await expect(roster.getByRole('listitem')).toHaveCount(4);
  await expect(roster.getByRole('listitem').nth(0)).toContainText('Sharing screen');
  await expect(roster.getByRole('listitem').nth(1)).toContainText('Talking');
  await expect(roster.getByRole('listitem').nth(2)).toContainText('Muted');
  await expect(roster.getByRole('listitem').nth(3)).toContainText('Listening in');
  // Let the spring settle, and the fixture stream deliver a frame.
  await page.waitForTimeout(1_400);
  rects['03'] = {
    pill: await box(p),
    surface: await box(p.locator('.glass-pill__surface')),
    preview: await box(p.locator('.glass-pill__preview')),
    roster: await box(roster),
    column: await box(page.locator('.glass-header')),
  };
  await shoot(page, 'pill-03-expanded-listening-desktop');

  // Escape collapses, and the focus returns to what opened it.
  await p.getByRole('button', { name: /Watch Vincent's screen/ }).first().focus();
  await page.keyboard.press('Escape');
  await expect(p).toHaveAttribute('data-phase', 'compact');
  await expect(p.getByRole('button', { name: "Show who's in Lounge" })).toBeFocused();
});

test('03b expanded, joined', async ({ page }) => {
  await open(page, general);
  await holdCall(page, { mode: 'joined', muted: false, ambient: true });
  const p = pill(page);
  await expect(p.getByRole('button', { name: 'Leave Lounge' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Microphone' })).toHaveAttribute('aria-pressed', 'true');
  await expect(p.getByRole('button', { name: 'Join Lounge' })).toHaveCount(0);
  await shoot(page, 'pill-03b-joined-compact-desktop');
  await p.getByRole('button', { name: "Show who's in Lounge" }).click();
  await expect(p.getByRole('list', { name: 'In Lounge' }).getByRole('listitem').nth(3)).toContainText('Mic on');
  await page.waitForTimeout(1_400);
  rects['03b'] = { pill: await box(p) };
  await shoot(page, 'pill-03b-joined-expanded-desktop');
});

test('expanded, not joined: 222px tall, exactly the column wide', async ({ page }) => {
  await open(page, general);
  const p = pill(page);
  await p.getByRole('button', { name: "Show who's in Lounge" }).click();
  await page.waitForTimeout(1_400);
  const b = await box(p);
  rects['expanded-idle'] = { pill: b };
  // The column is 720 wide at 1440, from x 526; the pill ends on its right edge.
  expect(b.w).toBeGreaterThan(715);
  expect(b.w).toBeLessThan(725);
  expect(b.h).toBeGreaterThan(215);
  expect(b.h).toBeLessThan(230);
  await shoot(page, 'pill-04-expanded-idle-desktop');
});

test('collapse order at narrower widths', async ({ page }) => {
  for (const [name, width] of [['1024', 1024], ['900', 900]] as const) {
    await page.setViewportSize({ width, height: 768 });
    await installGlassScene(page);
    await page.goto(general);
    await expect(pill(page)).toBeVisible();
    await page.waitForTimeout(500);
    rects[`width-${name}`] = {
      collapse: await pill(page).getAttribute('data-collapse'),
      pill: await box(pill(page)),
      slot: await box(page.locator('.glass-header__pill')),
    };
    await shoot(page, `pill-05-width-${name}`);
  }
});

test('07 phone: two rows', async ({ page }) => {
  await open(page, general, 'phone');
  const p = pill(page);
  await expect(p).toBeVisible();
  await expect(p).toHaveAttribute('data-layout', 'stacked');
  await expect(p.getByRole('button', { name: 'Listen in to Lounge' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Join Lounge' })).toBeVisible();
  rects['07'] = {
    pill: await box(p),
    listen: await box(p.locator('.glass-pill__listen')),
    mute: await box(p.locator('.glass-pill__mute')),
    join: await box(p.locator('.glass-pill__join')),
  };
  await shoot(page, 'pill-07-phone');
  await p.getByRole('button', { name: "Show who's in Lounge" }).click();
  await page.waitForTimeout(900);
  await shoot(page, 'pill-07b-phone-expanded');
});

/** Pause the pill's move at `at` ms into its 550ms spring, and read where the capsule is. */
async function pillAt(page: Page, at: number) {
  return page.evaluate((t) => {
    const surface = document.querySelector('.glass-pill__surface') as HTMLElement;
    // Every finite animation (the spring, the roster's rise, the line's fade)
    // is held at the same moment; the waveform's endless loop is left alone.
    const animations = document
      .getAnimations()
      .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime as number));
    for (const a of animations) {
      a.pause();
      a.currentTime = t;
    }
    const r = surface.getBoundingClientRect();
    return {
      count: animations.filter((a) => a.id.startsWith('glass-pill:')).length,
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
    };
  }, at);
}

test('the move is a spring on the capsule: it starts as the old capsule and ends as the new one', async ({ page }) => {
  await open(page, general);
  const p = pill(page);
  const compact = await box(p.locator('.glass-pill__surface'));
  await p.getByRole('button', { name: "Show who's in Lounge" }).click();
  const start = await pillAt(page, 0);
  expect(start.count).toBeGreaterThanOrEqual(2); // the capsule and the faces
  // First frame: the old capsule (same box, to a pixel).
  expect(Math.abs(start.w - compact.w)).toBeLessThan(1.5);
  expect(Math.abs(start.h - compact.h)).toBeLessThan(1.5);
  expect(Math.abs(start.x + start.w - (compact.x + compact.w))).toBeLessThan(1.5);
  for (const t of [0, 60, 130, 260, 550]) {
    await pillAt(page, t);
    await shoot(page, `pill-move-open-${String(t).padStart(3, '0')}`);
  }
  // Rest: the column's width, 222 tall.
  const end = await pillAt(page, 550);
  expect(Math.abs(end.w - 720)).toBeLessThan(2);
  expect(Math.abs(end.h - 222)).toBeLessThan(2);
  await page.evaluate(() => document.getAnimations().filter((a) => a.id.startsWith('glass-pill:')).forEach((a) => a.finish()));

  // And back: the words fade, then the capsule shrinks to the compact one.
  await page.keyboard.press('Escape');
  await expect(p).toHaveAttribute('data-phase', 'compact');
  const back = await pillAt(page, 0);
  expect(Math.abs(back.w - 720)).toBeLessThan(2);
  for (const t of [0, 90, 200, 550]) {
    await pillAt(page, t);
    await shoot(page, `pill-move-close-${String(t).padStart(3, '0')}`);
  }
  await pillAt(page, 550);
  await page.evaluate(() => document.getAnimations().filter((a) => a.id.startsWith('glass-pill:')).forEach((a) => a.finish()));
  const settled = await box(p.locator('.glass-pill__surface'));
  expect(Math.abs(settled.w - compact.w)).toBeLessThan(1.5);
});

test('reduced motion: no move, a short crossfade of the words', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, general);
  const p = pill(page);
  await p.getByRole('button', { name: "Show who's in Lounge" }).click();
  await expect(p).toHaveAttribute('data-phase', 'expanded');
  const animations = await page.evaluate(
    () => document.getAnimations().filter((a) => a.id.startsWith('glass-pill:')).length,
  );
  expect(animations).toBe(0);
  await shoot(page, 'pill-reduced-motion-expanded');
});

test('the phone at 320 wide: the two rows fit, Watch and Listen keep only their icons', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await installGlassScene(page);
  await page.goto(general);
  await expect(page.getByRole('main')).toBeVisible();
  const p = pill(page);
  await expect(p).toBeVisible();
  const b = await box(p);
  const join = await box(p.locator('.glass-pill__join'));
  rects['320'] = { pill: b, join };
  expect(join.x + join.w).toBeLessThanOrEqual(b.x + b.w + 0.5);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await shoot(page, 'pill-07c-phone-320');
});
