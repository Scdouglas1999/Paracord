import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { CAST, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * WP-G20 (the phone shell): the phone frame on the Glass reference scene, mocked
 * like glass-stage.spec.ts (no server, no media stack), at 390x844 (and 430x932,
 * 360x780 for the two screens, 768x1024 for the tablet check). Each state is
 * reached the way a person reaches it: a tap on a row, the back button, the pill's
 * Watch, the stream card's full screen.
 *
 * The media a relay would deliver is put into the stores from the page (the
 * same fake as WP-G14's spec).
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g20 npx playwright test -c e2e/glass-phone.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/phone-*.png and phone-rects.json
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'g20';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const PHONE = { width: 390, height: 844 };

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
const rects: Record<string, unknown> = {};

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(path.join(OUT_DIR, 'phone-rects.json'), JSON.stringify(rects, null, 2));
});

const IDS = {
  sean: CAST.sean.id,
  vincent: CAST.vincent.id,
  brendan: CAST.brendan.id,
  lounge: CH.lounge,
  guild: GAME_NIGHT_ID,
};

/**
 * The media a relay would deliver, faked in the page: `startWatch` goes live on
 * an engine that paints the fixture stream into whatever canvas it is given
 * (and taps it for the glow), `stopWatch` clears it, and the watcher count and
 * the stream's start time are what the server would say.
 */
async function fakeMedia(page: Page, options: { joined: boolean; watchers?: number }) {
  await page.evaluate(
    async ({ ids, joined, watchers }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const fixture = (await import('/src/lib/room/fixtureFrameSource.ts' as string)) as any;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const scope = { serverId, userId: ids.sean };
      const store = voice.useVoiceStore;

      /** An engine that paints a fixture scene into a canvas, like the WebCodecs route does. */
      const engineFor = (scenes: Record<string, string>) => {
        const sources = new Map<string, any>();
        const source = (scene: string) => {
          if (!sources.has(scene)) sources.set(scene, fixture.createFixtureFrameSource({ scene, width: 1280, height: 720 }));
          return sources.get(scene);
        };
        return {
          subscribeVideo(userId: string, canvas: HTMLCanvasElement, onFrame?: () => void, opts?: { preferredTrackId?: string }) {
            const scene = scenes[`${userId}:${opts?.preferredTrackId ?? 'screen'}`];
            if (!scene) return () => {};
            const context = canvas.getContext('2d');
            const stop = source(scene).subscribe((bitmap: ImageBitmap) => {
              const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
              const h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
              if (canvas.width !== w) canvas.width = w;
              if (canvas.height !== h) canvas.height = h;
              // Cover, like a camera tile (the stream is 16:9 in a 16:9 box anyway).
              const scale = Math.max(w / bitmap.width, h / bitmap.height);
              const dw = bitmap.width * scale;
              const dh = bitmap.height * scale;
              context?.drawImage(bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
              bitmap.close();
              onFrame?.();
            }, 8);
            return stop;
          },
          tapVideoFrames(userId: string, trackId: string, onFrame: (frame: unknown) => void) {
            const scene = scenes[`${userId}:${trackId}`];
            if (!scene) return { route: Promise.resolve('no-track'), release: () => {} };
            const stop = source(scene).subscribe((bitmap: unknown) => onFrame(bitmap), 2);
            return { route: Promise.resolve('frames'), release: stop };
          },
        };
      };

      const watchEngine = engineFor({ [`${ids.vincent}:screen`]: 'stream' });
      const callEngine = engineFor({ [`${ids.brendan}:camera`]: 'camera', [`${ids.vincent}:screen`]: 'stream' });

      store.setState({
        startWatch: async (target: any) => {
          store.setState({
            watchView: {
              id: 'e2e-watch',
              kind: 'watch',
              scope,
              guildId: target.guildId,
              channelId: target.channelId,
              streamerId: target.streamerId,
              route: joined ? 'call' : 'session',
              phase: 'live',
              engine: joined ? callEngine : watchEngine,
              sessionId: 'e2e-view',
              endReason: null,
              pauseReason: null,
              error: null,
            },
          });
        },
        stopWatch: async () => store.setState({ watchView: null }),
        fetchWatchers: async () => {
          if (!watchers) return;
          store.getState().handleWatchersUpdate(
            { channel_id: ids.lounge, guild_id: ids.guild, streams: [{ user_id: ids.vincent, watchers }] },
            scope,
          );
        },
      });

      // Vincent went live 42 minutes before the scene's clock (9:12 PM), as the server would say.
      const startedAt = new Date(Date.now() - 42 * 60_000 - 10_000).toISOString();
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
        self_mute: false,
        self_stream: false,
        self_video: false,
        suppress: false,
        mode: 'joined',
      };
      // The mocked gateway replays READY now and then; put the call's rows back each time.
      const put = () => {
        const current = store.getState();
        const there = current.channelParticipants.get(ids.lounge) ?? [];
        const vincent = there.find((s: any) => s.user_id === ids.vincent);
        const settled = vincent?.self_stream_started_at && (!joined || there.some((s: any) => s.user_id === ids.sean));
        if (settled) return;
        const rows = there
          .filter((s: any) => s.user_id !== ids.sean)
          .map((s: any) => (s.user_id === ids.vincent ? { ...s, self_stream_started_at: startedAt } : s));
        if (joined) rows.push(me);
        const channelParticipants = new Map(current.channelParticipants);
        channelParticipants.set(ids.lounge, rows);
        store.setState({
          channelParticipants,
          ...(joined
            ? {
                callId: 'e2e-call',
                callScope: scope,
                callPhase: 'connected',
                callMode: 'joined',
                connected: true,
                joining: false,
                channelId: ids.lounge,
                guildId: ids.guild,
                selfMute: false,
                mediaEngine: callEngine,
                participants: new Map(rows.map((s: any) => [s.user_id, s])),
                speakingUsers: new Set([ids.brendan]),
              }
            : {}),
        });
      };
      put();
      store.subscribe(put);
      if (joined) {
        const levels = (await import('/src/lib/motion/voiceLevel.ts' as string)) as any;
        const speak = () => levels.publishVoiceLevels('room', new Map([[ids.brendan, 0.55 + 0.35 * Math.sin(Date.now() / 260)]]));
        speak();
        setInterval(speak, 250);
      }
    },
    { ids: IDS, joined: options.joined, watchers: options.watchers ?? 0 },
  );
}


/**
 * A phone with a notch and a home indicator, like the reference's 390x844: the
 * frame reads `--safe-top` and `--safe-bottom` (tokens.css), which are
 * `env(safe-area-inset-*)` and cannot be set from a test, so the test sets them.
 */
async function withSafeAreas(page: Page, top = 47, bottom = 34) {
  await page.addStyleTag({ content: `:root{--safe-top:${top}px;--safe-bottom:${bottom}px}` });
}

async function open(page: Page, route = general, size: { width: number; height: number } = PHONE) {
  await page.setViewportSize(size);
  await installGlassScene(page);
  await page.goto(route);
  await expect(page.locator('.glass-frame[data-layout="phone"]')).toBeVisible();
}

const places = (page: Page) => page.locator('.glass-phone__screen--places');
const conversation = (page: Page) => page.locator('.glass-phone__screen--conversation');
// The pill of the conversation screen (the places screen, off to the side, holds its own while you are in a call).
const pill = (page: Page) => page.locator('.glass-phone__screen--conversation').getByRole('region', { name: /live voice channel|voice call/ });
const stagePane = (page: Page) => page.getByRole('region', { name: 'Stage' });

/** Which screen is in front, and that the other one cannot be reached. */
async function screenIs(page: Page, screen: 'places' | 'conversation') {
  const front = screen === 'places' ? places(page) : conversation(page);
  const back = screen === 'places' ? conversation(page) : places(page);
  await expect(front).toHaveAttribute('data-active', 'true');
  await expect(front).not.toHaveAttribute('inert', '');
  await expect(back).toHaveAttribute('inert', '');
}

/** Every screen slide has finished. */
async function settled(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.id.startsWith('glass-phone:') && a.playState === 'running').length))
    .toBe(0);
}

async function watchFromPill(page: Page) {
  await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
  await expect(stagePane(page)).toBeVisible();
  await expect(page.locator('.glass-stage__stream[data-picture="true"]')).toBeVisible();
}

/** The mocked server refuses read-state acks; that toast is the harness's, not the frame's. */
async function clearToasts(page: Page) {
  await page.evaluate(async () => {
    const toasts = (await import('/src/stores/toastStore.ts' as string)) as any;
    toasts.useToastStore.setState({ toasts: [] });
  });
}

async function shoot(page: Page, name: string) {
  const size = page.viewportSize();
  if (size) await page.mouse.move(size.width - 3, size.height - 3);
  await clearToasts(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
}

async function box(locator: Locator) {
  if ((await locator.count()) === 0) return null;
  const b = await locator.first().boundingBox();
  if (!b) return null;
  return { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
}

async function measure(page: Page, key: string) {
  rects[key] = {
    viewport: page.viewportSize(),
    stage: await box(stagePane(page)),
    pill: await box(page.locator('.glass-conversation__phone-pill .glass-pill')),
    header: await box(page.locator('.glass-header')),
    title: await box(page.locator('.glass-header__title')),
    kicker: await box(page.locator('.glass-header__new')),
    timeline: await box(page.locator('.glass-conversation__timeline')),
    composer: await box(page.locator('.glass-composer__capsule')),
    placesPane: await box(page.locator('.glass-phone__places')),
    main: await box(page.getByRole('main')),
  };
}

/** Every button of the controls capsule is on the window and inside the capsule. */
async function expectCapsuleFits(page: Page, width: number) {
  const group = stagePane(page).getByRole('group', { name: 'Call controls' });
  const capsule = (await box(group))!;
  expect(capsule.x).toBeGreaterThanOrEqual(0);
  expect(capsule.x + capsule.w).toBeLessThanOrEqual(width);
  for (const button of await group.getByRole('button').all()) {
    const b = (await button.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(capsule.x - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(capsule.x + capsule.w + 0.5);
  }
}

test('07 the conversation, with the pill at 366 and the header under it', async ({ page }) => {
  await open(page);
  await screenIs(page, 'conversation');
  await withSafeAreas(page);
  await expect(page.getByText("I'm bringing the projector").first()).toBeVisible();
  await expect(pill(page)).toBeVisible();
  await measure(page, '07-conversation');
  await shoot(page, 'phone-07-conversation');
  const r = rects['07-conversation'] as any;
  // screens/07: the pill is the window minus 12px each side, the message box the same.
  expect(r.pill.w).toBe(366);
  expect(r.pill.x).toBe(12);
  expect(r.composer.x).toBe(12);
  expect(r.composer.w).toBe(366);
});

test('07 the conversation with no safe areas', async ({ page }) => {
  await open(page);
  await expect(page.getByText("I'm bringing the projector").first()).toBeVisible();
  await expect(pill(page)).toBeVisible();
  await measure(page, '07-conversation-flat');
  await shoot(page, 'phone-07-conversation-flat');
});

test('07 the phone as the reference draws it: watching, reply staged, on a device with a notch', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false, watchers: 2 });
  await withSafeAreas(page);
  await watchFromPill(page);
  // Jeremy's message is the one to answer: the reply chip lands in the message box.
  const jeremy = page.locator('.glass-msg', { hasText: 'still on?' }).first();
  await jeremy.hover();
  await page.getByRole('button', { name: 'Reply to Jeremy' }).first().click({ force: true });
  await expect(page.locator('.glass-composer__capsule').getByText('Jeremy')).toBeVisible();
  await measure(page, '07-phone');
  await shoot(page, 'phone-07-phone');
});

test('the screens slide: a frame early in the move, places gone before the conversation covers it, then at rest', async ({ page }) => {
  await open(page);
  await page.locator('.glass-header__nav').click();
  await screenIs(page, 'places');
  await settled(page);
  // Freeze the slide forward, part way: both screens are on screen, neither at rest.
  await page.getByRole('link', { name: /Clips/ }).first().click();
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.id.startsWith('glass-phone:')) {
        animation.pause();
        animation.currentTime = 30;
      }
    }
  });
  const during = await page.evaluate(() => {
    const at = (selector: string) => {
      const el = document.querySelector(selector) as HTMLElement;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), opacity: Number(getComputedStyle(el).opacity) };
    };
    return { places: at('.glass-phone__screen--places'), conversation: at('.glass-phone__screen--conversation') };
  });
  rects['slide-30ms'] = during;
  expect(during.conversation.x).toBeGreaterThan(0);
  expect(during.conversation.x).toBeLessThan(390);
  expect(during.places.x).toBeLessThan(0);
  expect(during.places.opacity).toBeGreaterThan(0);
  expect(during.places.opacity).toBeLessThan(1);
  await page.screenshot({ path: path.join(OUT_DIR, 'phone-slide-30ms.png') });
  // Places leaves early: by 150ms it is gone, so it never shows through the conversation.
  const late = await page.evaluate(() => {
    for (const animation of document.getAnimations()) if (animation.id.startsWith('glass-phone:')) animation.currentTime = 150;
    return Number(getComputedStyle(document.querySelector('.glass-phone__screen--places') as HTMLElement).opacity);
  });
  expect(late).toBe(0);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) if (animation.id.startsWith('glass-phone:')) animation.finish();
  });
  await settled(page);
  const after = await box(conversation(page));
  expect(after).toMatchObject({ x: 0, y: 0 });
});

test('reduced motion: the screens crossfade in 150ms and nothing travels', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await page.locator('.glass-header__nav').click();
  await screenIs(page, 'places');
  const played = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.id.startsWith('glass-phone:'))
      .map((animation) => ({
        id: animation.id,
        duration: Number((animation.effect as KeyframeEffect).getComputedTiming().duration),
        props: Array.from(new Set((animation.effect as KeyframeEffect).getKeyframes().flatMap((frame) => Object.keys(frame)))).filter(
          (key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key),
        ),
        transforms: (animation.effect as KeyframeEffect).getKeyframes().map((frame) => String(frame.transform)),
      })),
  );
  expect(played.map((a) => a.id).sort()).toEqual(['glass-phone:in', 'glass-phone:out']);
  for (const animation of played) {
    expect(animation.duration).toBe(150);
    expect(animation.props.sort()).toEqual(['opacity', 'transform']);
    expect(animation.transforms.every((value) => value === 'none')).toBe(true);
  }
  await settled(page);
  await screenIs(page, 'places');
});

test('a message: back to places returns to the list, and Friends is a page with a way back', async ({ page }) => {
  // The messages index is the route that opens on places (Home opens its page).
  await open(page, '/app/dms');
  await screenIs(page, 'places');
  await page.getByRole('link', { name: /brendan/ }).first().click();
  await screenIs(page, 'conversation');
  await expect(page).toHaveURL(/\/app\/dms\/[^/]+$/);
  await settled(page);
  await shoot(page, 'phone-dm');
  // The header's first button is the way back to places, for a message as for a
  // channel (WP-G22: `PlacesToggle`); the list of messages is on that screen.
  await page.getByRole('button', { name: 'Back to places' }).click();
  await screenIs(page, 'places');
  await expect(page.getByRole('link', { name: /brendan/ }).first()).toBeVisible();
  await settled(page);

  await page.getByRole('link', { name: /Friends/ }).first().click();
  await screenIs(page, 'conversation');
  await expect(page).toHaveURL(/\/app\/friends$/);
  await settled(page);
  await shoot(page, 'phone-friends');
  await page.getByRole('button', { name: 'Back to places' }).click();
  await screenIs(page, 'places');
});

test('places while you are in a call: the pill rides above it', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await withSafeAreas(page);
  await page.locator('.glass-header__nav').click();
  await screenIs(page, 'places');
  await settled(page);
  const callPill = places(page).getByRole('region', { name: /voice/ });
  await expect(callPill).toBeVisible();
  const r = await box(callPill);
  rects['places-call'] = r;
  expect(r!.w).toBe(366);
  await shoot(page, 'phone-places-call');
  // The call is one tap away: Leave is on this screen.
  await expect(callPill.getByRole('button', { name: /Leave/ })).toBeVisible();
});

test('a page with no conversation header shows the call under its back button', async ({ page }) => {
  await open(page, '/app/friends');
  await fakeMedia(page, { joined: true, watchers: 0 });
  await withSafeAreas(page);
  await screenIs(page, 'conversation');
  const bar = page.getByRole('main').locator('.glass-frame__pane-bar');
  await expect(bar.getByRole('button', { name: 'Back to places' })).toBeVisible();
  const callPill = bar.getByRole('region', { name: /voice/ });
  await expect(callPill).toBeVisible();
  expect(Math.round((await box(callPill))!.w)).toBe(366 - 12);
  await shoot(page, 'phone-friends-call');
  await expect(callPill.getByRole('button', { name: /Leave/ })).toBeVisible();
});

test('the card says what is happening while the stream is not there: connecting, and a failed watch with its button', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false, watchers: 1 });
  await withSafeAreas(page);
  await watchFromPill(page);
  const setPhase = (phase: string, error: string | null) =>
    page.evaluate(
      async ({ phase: p, error: e }) => {
        const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
        const view = voice.useVoiceStore.getState().watchView;
        voice.useVoiceStore.setState({ watchView: { ...view, phase: p, error: e, engine: p === 'live' ? view.engine : null } });
      },
      { phase, error },
    );
  await setPhase('connecting', null);
  await expect(stagePane(page).getByText(/Connecting to/)).toBeVisible();
  await shoot(page, 'phone-watch-connecting');
  await setPhase('failed', 'The relay refused the watch.');
  const again = stagePane(page).getByRole('button', { name: 'Watch again' });
  await expect(again).toBeVisible();
  // The notice and its button sit clear of the chrome: back, clip and full screen stay reachable.
  const card = await box(stagePane(page));
  const button = await box(again);
  expect(button!.y).toBeGreaterThan(card!.y);
  expect(button!.y + button!.h).toBeLessThan(card!.y + card!.h);
  await shoot(page, 'phone-watch-failed');
  await expect(stagePane(page).getByRole('button', { name: 'Stop watching' })).toBeVisible();
  // The chrome is not in its way: a tap on the notice's button asks again.
  await again.click();
  await expect(page.locator('.glass-stage__stream[data-picture="true"]')).toBeVisible();
});

test('a voice channel page and a server overview keep a pane and the way back', async ({ page }) => {
  await open(page, `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.lounge}`);
  await withSafeAreas(page);
  await screenIs(page, 'conversation');
  await expect(page.getByRole('button', { name: 'Back to places' })).toBeVisible();
  await page.waitForTimeout(800);
  await shoot(page, 'phone-voice-channel');
  await open(page, `/app/guilds/${GAME_NIGHT_ID}`);
  await page.waitForTimeout(800);
  await shoot(page, 'phone-overview');
});

test('the live channel on places opens the stream over the conversation', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false, watchers: 2 });
  await withSafeAreas(page);
  await page.locator('.glass-header__nav').click();
  await screenIs(page, 'places');
  await settled(page);
  await page.getByRole('link', { name: /Lounge/ }).first().click();
  await screenIs(page, 'conversation');
  await expect(stagePane(page)).toBeVisible();
  await expect(page.locator('.glass-stage__stream[data-picture="true"]')).toBeVisible();
  await settled(page);
  await shoot(page, 'phone-live-row-watch');
});

test('Escape in full screen goes back to the card, and the next one stops watching', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await watchFromPill(page);
  await stagePane(page).getByRole('button', { name: 'Full screen' }).click();
  await expect(page.locator('.glass-frame[data-stage="theater"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.glass-frame[data-stage="side"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stagePane(page)).toHaveCount(0);
});

test('places is its own screen: a tap on a channel slides the conversation in, the back button returns', async ({ page }) => {
  await open(page);
  await withSafeAreas(page);
  // Back to places from the header's button.
  await page.locator('.glass-header__nav').click();
  await screenIs(page, 'places');
  await settled(page);
  await expect(page.getByRole('navigation', { name: 'Channels' })).toBeVisible();
  await measure(page, 'places');
  await shoot(page, 'phone-places');

  // A tap on a channel opens it.
  await page.getByRole('link', { name: /Clips/ }).first().click();
  await screenIs(page, 'conversation');
  await expect(page).toHaveURL(new RegExp(`/channels/${CH.clips}`));
  await settled(page);
  await expect(page.getByRole('main')).toBeFocused();
});

test('a tap on a server circle looks at that server; the current one goes back to its conversation', async ({ page }) => {
  await open(page);
  await page.locator('.glass-header__nav').click();
  await screenIs(page, 'places');
  await settled(page);
  // The server you are in: back to its conversation.
  await page.locator('.glass-places-servers [aria-current="true"]').click();
  await screenIs(page, 'conversation');
  await settled(page);
  await page.locator('.glass-header__nav').click();
  await screenIs(page, 'places');
  // Another server: stay on places and look at its channels.
  await page.getByRole('button', { name: /Basecamp/ }).first().click();
  await expect(page).toHaveURL(/\/app\/guilds\//);
  await page.waitForTimeout(600);
  await screenIs(page, 'places');
});

test('the edge swipe goes back; a swipe that starts inside the screen does not', async ({ page }) => {
  await open(page);
  await screenIs(page, 'conversation');
  const swipe = (fromX: number, toX: number) =>
    page.evaluate(
      ({ fromX: a, toX: b }) => {
        const fire = (type: string, x: number, y: number) => {
          const touch = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
          document.dispatchEvent(
            new TouchEvent(type, {
              touches: type === 'touchend' ? [] : [touch],
              changedTouches: [touch],
              bubbles: true,
            }),
          );
        };
        fire('touchstart', a, 400);
        fire('touchmove', (a + b) / 2, 404);
        fire('touchend', b, 406);
      },
      { fromX, toX },
    );
  await swipe(150, 290);
  await page.waitForTimeout(200);
  await screenIs(page, 'conversation');
  await swipe(4, 140);
  await screenIs(page, 'places');
  await settled(page);
  // On places the edge belongs to no gesture.
  await swipe(4, 140);
  await page.waitForTimeout(200);
  await screenIs(page, 'places');
});

test('Home opens its page; back shows its places; the tray, tapped again, shows the page', async ({ page }) => {
  await open(page, '/app');
  await screenIs(page, 'conversation');
  await withSafeAreas(page);
  await settled(page);
  await measure(page, 'home-page');
  await shoot(page, 'phone-home-page');

  await page.getByRole('button', { name: 'Back to places' }).click();
  await screenIs(page, 'places');
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  await settled(page);
  await measure(page, 'home-places');
  await shoot(page, 'phone-home-places');
  await page.getByRole('button', { name: /Home and direct messages/ }).click();
  await screenIs(page, 'conversation');
  await expect(page).toHaveURL(/\/app\/?$/);
});

test('the account menu is one tap from places (there is no bottom bar)', async ({ page }) => {
  await open(page, '/app/dms');
  await screenIs(page, 'places');
  await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(0);
  await page.getByRole('button', { name: /Your profile/ }).click();
  await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
  await screenIs(page, 'places');
  await shoot(page, 'phone-account-menu');
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'User settings' })).toBeVisible();
});

test('a sheet is the whole screen: search from the header', async ({ page }) => {
  await open(page);
  await withSafeAreas(page);
  await page.getByRole('button', { name: 'Search messages' }).click();
  await expect(page.locator('.glass-sheet[data-host="window"]')).toBeVisible();
  await page.waitForTimeout(400);
  const sheet = await box(page.locator('.glass-sheet[data-host="window"]'));
  expect(sheet).toMatchObject({ x: 0, y: 0, w: 390, h: 844 });
  await shoot(page, 'phone-sheet-search');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Members' }).click();
  await expect(page.locator('.glass-sheet[data-host="window"]')).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, 'phone-sheet-people');
});

test('watching: the stream card above the pill, joined off', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false, watchers: 2 });
  await withSafeAreas(page);
  await watchFromPill(page);
  await screenIs(page, 'conversation');
  await measure(page, 'watching');
  await shoot(page, 'phone-watching');
  const r = rects.watching as any;
  expect(r.stage.x).toBe(12);
  expect(r.stage.w).toBe(366);
  expect(r.stage.h).toBeCloseTo(206, 0);
  expect(r.pill.w).toBe(366);
  await expect(stagePane(page).getByRole('button', { name: 'Stop watching' })).toBeVisible();
  await expect(stagePane(page).getByRole('button', { name: 'Clip the last 30 seconds' })).toBeVisible();
  await expect(stagePane(page).getByRole('button', { name: 'Full screen' })).toBeVisible();
  await expect(stagePane(page).locator('.glass-phone-stage__label')).toHaveText("Vincent's screen");
  await expect(stagePane(page).locator('.glass-phone-stage__count')).toHaveText('2 watching');
});

test('watching and back: Stop watching returns to the conversation and keeps the call', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await watchFromPill(page);
  await stagePane(page).getByRole('button', { name: 'Stop watching' }).click();
  await expect(stagePane(page)).toHaveCount(0);
  const connected = await page.evaluate(async () => {
    const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
    return voice.useVoiceStore.getState().connected;
  });
  expect(connected).toBe(true);
});

test('theater on a phone is the stream full screen with the controls capsule', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await withSafeAreas(page);
  await watchFromPill(page);
  await stagePane(page).getByRole('button', { name: 'Full screen' }).click();
  await expect(page.locator('.glass-frame[data-stage="theater"]')).toBeVisible();
  await page.waitForTimeout(500);
  const stage = await box(stagePane(page));
  expect(stage).toMatchObject({ x: 0, y: 0, w: 390, h: 844 });
  await expect(stagePane(page).getByRole('group', { name: 'Call controls' })).toBeVisible();
  await expect(page.getByRole('main')).toHaveAttribute('inert', '');
  rects['theater-controls'] = await box(stagePane(page).getByRole('group', { name: 'Call controls' }));
  await expectCapsuleFits(page, 390);
  await shoot(page, 'phone-theater-joined');
  await stagePane(page).getByRole('button', { name: 'Exit full screen' }).first().click();
  await expect(page.locator('.glass-frame[data-stage="side"]')).toBeVisible();
  await expect(page.getByRole('main')).not.toHaveAttribute('inert', '');
});

test('theater on a phone, not joined', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false, watchers: 1 });
  await withSafeAreas(page);
  await watchFromPill(page);
  await stagePane(page).getByRole('button', { name: 'Full screen' }).click();
  await expect(page.locator('.glass-frame[data-stage="theater"]')).toBeVisible();
  await page.waitForTimeout(500);
  rects['theater-controls-not-joined'] = await box(stagePane(page).getByRole('group', { name: 'Call controls' }));
  await expectCapsuleFits(page, 390);
  await shoot(page, 'phone-theater-not-joined');
});

test('a reaction rises about 90px on the card, not the stage\'s 270', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await watchFromPill(page);
  await page.evaluate(async (ids) => {
    const reactions = (await import('/src/stores/streamReactionStore.ts' as string)) as any;
    const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
    const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
    const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
    reactions.useStreamReactionStore.getState().receive(serverId, {
      guild_id: ids.guild,
      channel_id: ids.lounge,
      reactions: [
        { user_id: ids.brendan, stream_user_id: ids.vincent, kind: 'flame', count: 1, nonce: null, username: 'brendan', display_name: 'Brendan', avatar_hash: null },
      ],
    });
  }, IDS);
  await page.waitForTimeout(700);
  const bubble = page.locator('.glass-stage[data-layout="phone"] .glass-reactions__bubble');
  await expect(bubble.first()).toBeAttached();
  const name = await bubble.first().evaluate((el) => getComputedStyle(el).animationName);
  expect(name).toBe('glass-phone-reaction-rise');
  // It rises about 90px (the keyframes say -90px at the end), not the stage's 270.
  const rise = await page.evaluate(() => {
    const frames = Array.from(document.styleSheets)
      .flatMap((sheet) => { try { return Array.from(sheet.cssRules); } catch { return []; } })
      .find((rule) => rule instanceof CSSKeyframesRule && rule.name === 'glass-phone-reaction-rise') as CSSKeyframesRule | undefined;
    return frames ? (frames.cssRules[frames.cssRules.length - 1] as CSSKeyframeRule).style.transform : null;
  });
  expect(rise).toContain('-90px');
  await shoot(page, 'phone-reaction');
});

for (const [name, size] of [
  ['430', { width: 430, height: 932 }],
  ['360', { width: 360, height: 780 }],
] as const) {
  test(`${name} wide: the conversation, watching, full screen, places and Home`, async ({ page }) => {
    await open(page, general, size);
    await fakeMedia(page, { joined: true, watchers: 2 });
    await withSafeAreas(page);
    await expect(page.getByText("I'm bringing the projector").first()).toBeVisible();
    await expect(pill(page)).toBeVisible();
    await measure(page, `conversation-${name}`);
    await shoot(page, `phone-conversation-${name}`);

    await watchFromPill(page);
    await measure(page, `watching-${name}`);
    const r = rects[`watching-${name}`] as any;
    expect(r.stage.w).toBe(size.width - 24);
    expect(r.pill.w).toBe(size.width - 24);
    await shoot(page, `phone-watching-${name}`);

    // Full screen: the stage is the window and its capsule fits inside it.
    await stagePane(page).getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('.glass-frame[data-stage="theater"]')).toBeVisible();
    await page.waitForTimeout(500);
    expect(await box(stagePane(page))).toMatchObject({ x: 0, y: 0, w: size.width, h: size.height });
    rects[`fullscreen-controls-${name}`] = await box(stagePane(page).getByRole('group', { name: 'Call controls' }));
    await expectCapsuleFits(page, size.width);
    await shoot(page, `phone-fullscreen-${name}`);
    await stagePane(page).getByRole('button', { name: 'Exit full screen' }).first().click();
    await stagePane(page).getByRole('button', { name: 'Stop watching' }).click();

    await page.locator('.glass-header__nav').click();
    await screenIs(page, 'places');
    await settled(page);
    await shoot(page, `phone-places-${name}`);

    // Home opens its own page on a phone, not the list.
    await page.getByRole('button', { name: /Home and direct messages/ }).click();
    await page.waitForTimeout(700);
    await screenIs(page, 'conversation');
    await shoot(page, `phone-home-page-${name}`);
  });
}

test('320 wide, the smallest phone: nothing overflows, the header and the capsule fit', async ({ page }) => {
  const size = { width: 320, height: 640 };
  await open(page, general, size);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await expect(page.getByText("I'm bringing the projector").first()).toBeVisible();
  await expect(pill(page)).toBeVisible();
  const overflow = () => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect((await overflow()).scroll).toBeLessThanOrEqual(320);
  const tools = await box(page.locator('.glass-header__tools'));
  expect(tools!.x + tools!.w).toBeLessThanOrEqual(320);
  await shoot(page, 'phone-conversation-320');
  await watchFromPill(page);
  await stagePane(page).getByRole('button', { name: 'Full screen' }).click();
  await expect(page.locator('.glass-frame[data-stage="theater"]')).toBeVisible();
  await page.waitForTimeout(500);
  await expectCapsuleFits(page, 320);
  await shoot(page, 'phone-fullscreen-320');
  await stagePane(page).getByRole('button', { name: 'Exit full screen' }).first().click();
  await stagePane(page).getByRole('button', { name: 'Stop watching' }).click();
  await page.locator('.glass-header__nav').click();
  await screenIs(page, 'places');
  await settled(page);
  expect((await overflow()).scroll).toBeLessThanOrEqual(320);
  await shoot(page, 'phone-places-320');
});

test('768x1024 is the tablet: the compact frame, not the phone', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await installGlassScene(page);
  await page.goto(general);
  await expect(page.locator('.glass-frame[data-layout="compact"]')).toBeVisible();
  await expect(page.locator('.glass-phone__screen')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show places' })).toBeVisible();
  await shoot(page, 'phone-tablet-768');
});
