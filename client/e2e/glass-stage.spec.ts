import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { CAST, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * WP-G14 (the stage, side by side): the stage on the Glass reference scene,
 * mocked like glass-review.spec.ts (no server, no media stack), at 1440x900 and
 * 390x844. Each state is reached the way a person reaches it: the call pill's
 * Watch opens the stage. What a relay would do is put into the stores from the
 * page: the watch goes live on an engine that draws the DEV fixture stream into
 * the stage's canvas, and (joined) the call's engine draws the fixture camera
 * for Brendan.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g14 npx playwright test -c e2e/glass-stage.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/stage-*.png and stage-rects.json
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'g14';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
const rects: Record<string, unknown> = {};

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(path.join(OUT_DIR, 'stage-rects.json'), JSON.stringify(rects, null, 2));
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
async function fakeMedia(page: Page, options: { joined: boolean; watchers?: number; sharing?: boolean }) {
  await page.evaluate(
    async ({ ids, joined, watchers, sharing }) => {
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

      const watchEngine = engineFor({ [`${ids.vincent}:screen`]: 'stream', [`${ids.sean}:screen`]: 'stream' });
      const callEngine = engineFor({ [`${ids.brendan}:camera`]: 'camera', [`${ids.vincent}:screen`]: 'stream', [`${ids.sean}:screen`]: 'stream' });

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
        self_stream: sharing,
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
                selfStream: sharing,
                changeStreamQuality: async (quality: string) => { (window as any).__appliedShareQuality = quality; },
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
    { ids: IDS, joined: options.joined, watchers: options.watchers ?? 0, sharing: options.sharing ?? false },
  );
}

async function open(page: Page, size: keyof typeof SIZES) {
  await page.setViewportSize(SIZES[size]);
  await installGlassScene(page);
  await page.goto(general);
  await expect(page.getByRole('main')).toBeVisible();
}

const pill = (page: Page) => page.getByRole('region', { name: /live voice channel|voice call/ });
const stagePane = (page: Page) => page.getByRole('region', { name: 'Stage' });

async function watchFromPill(page: Page) {
  await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
  await expect(stagePane(page)).toBeVisible();
  // The fixture has painted the stream.
  await expect(page.locator('.glass-stage__stream[data-picture="true"]')).toBeVisible();
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

async function shoot(page: Page, name: string) {
  const size = page.viewportSize();
  if (size) await page.mouse.move(size.width - 3, size.height - 3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('no box');
  return { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
}

async function measure(page: Page, key: string) {
  const buttons = await page.locator('.glass-stage__controls > button').all();
  rects[key] = {
    stage: await box(stagePane(page)),
    stream: await box(page.locator('.glass-stage__stream')),
    tiles: await Promise.all((await page.locator('.glass-stage__tile').all()).map(box)),
    chips: await Promise.all((await page.locator('.glass-stage__chip').all()).map(box)),
    controls: await Promise.all(buttons.map(box)),
    conversation: await box(page.getByRole('main')),
  };
}

test('04 side by side, joined', async ({ page }) => {
  await open(page, 'desktop');
  await fakeMedia(page, { joined: true, watchers: 2 });
  await watchFromPill(page);
  const stage = stagePane(page);
  await expect(stage.getByText("Vincent's screen")).toBeVisible();
  await expect(stage.getByText(/Game Night Lounge, live for 42 min/)).toBeVisible();
  await expect(stage.getByText('2 watching')).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Leave Lounge' })).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Join Lounge' })).toHaveCount(0);
  // Brendan's camera from the call, talking.
  await expect(page.locator('.glass-stage__tile[data-talking="true"]')).toContainText('Brendan');
  // The pill became the stage; the conversation stays at 420 and keeps working.
  await expect(pill(page)).toHaveCount(0);
  await measure(page, '04-joined');
  await shoot(page, 'stage-04-side-joined-desktop');
});

test('the conversation keeps working beside the stage (a staged reply survives)', async ({ page }) => {
  await open(page, 'desktop');
  await fakeMedia(page, { joined: true });
  const box = page.getByRole('textbox').last();
  await box.click();
  await box.fill('on my way');
  await watchFromPill(page);
  await expect(page.getByRole('main')).not.toHaveAttribute('inert', '');
  await expect(box).toHaveValue('on my way');
  // The pill-to-stage move (WP-G15) plays on transforms for 650ms: measure once it settled.
  await settled(page);
  const main = await page.getByRole('main').boundingBox();
  expect(Math.round(main?.width ?? 0)).toBe(420);
});

test('06 side by side, not joined (the stage part of screens/06)', async ({ page }) => {
  await open(page, 'desktop');
  await fakeMedia(page, { joined: false, watchers: 1 });
  await watchFromPill(page);
  const stage = stagePane(page);
  await expect(stage.getByRole('button', { name: 'Join Lounge' })).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Microphone on when you join' })).toHaveAttribute('aria-pressed', 'false');
  await measure(page, '06-not-joined');
  await shoot(page, 'stage-06-side-not-joined-desktop');
});

test('browse (S) grows the stage to 1076 and the stream with it', async ({ page }) => {
  await open(page, 'desktop');
  await fakeMedia(page, { joined: false });
  await watchFromPill(page);
  await stagePane(page).getByRole('button', { name: 'Show servers and channels' }).click();
  await expect(page.locator('.glass-frame__places')).toBeVisible();
  await page.waitForTimeout(800);
  await measure(page, '06-browse');
  await shoot(page, 'stage-06b-browse-not-joined-desktop');
});

test('the microphone menu (right-click) and More, joined', async ({ page }) => {
  await open(page, 'desktop');
  await fakeMedia(page, { joined: true });
  await watchFromPill(page);
  await stagePane(page).getByRole('button', { name: 'More call actions' }).click();
  await expect(page.getByRole('menu', { name: 'More call actions' })).toBeVisible();
  await shoot(page, 'stage-more-menu-desktop');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  // Escape closed the menu, not the stage.
  await expect(stagePane(page)).toBeVisible();
  await stagePane(page).getByRole('button', { name: 'Microphone' }).click({ button: 'right' });
  await expect(page.getByRole('dialog', { name: 'Microphone and speaker' })).toBeVisible();
  await shoot(page, 'stage-mic-menu-desktop');
});

test('Stop watching returns to the conversation and keeps the call; Esc too', async ({ page }) => {
  await open(page, 'desktop');
  await fakeMedia(page, { joined: true });
  await watchFromPill(page);
  await stagePane(page).getByRole('button', { name: /Stop watching/ }).click();
  await expect(stagePane(page)).toHaveCount(0);
  await expect(pill(page).getByRole('button', { name: 'Leave Lounge' })).toBeVisible();
  const connected = await page.evaluate(async () => {
    const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
    const s = voice.useVoiceStore.getState();
    return { connected: s.connected, watch: s.watchView };
  });
  expect(connected).toEqual({ connected: true, watch: null });
  await watchFromPill(page);
  await page.keyboard.press('Escape');
  await expect(stagePane(page)).toHaveCount(0);
});

test('phone: the stream above the conversation, joined', async ({ page }) => {
  await open(page, 'phone');
  await fakeMedia(page, { joined: true, watchers: 2 });
  await pill(page).getByRole('button', { name: /Watch/ }).first().click();
  await expect(stagePane(page)).toBeVisible();
  await expect(page.locator('.glass-stage__stream[data-picture="true"]')).toBeVisible();
  await shoot(page, 'stage-04-phone');
});

test('phone: not joined', async ({ page }) => {
  await open(page, 'phone');
  await fakeMedia(page, { joined: false, watchers: 1 });
  await pill(page).getByRole('button', { name: /Watch/ }).first().click();
  await expect(stagePane(page)).toBeVisible();
  await expect(page.locator('.glass-stage__stream[data-picture="true"]')).toBeVisible();
  await shoot(page, 'stage-06-phone');
});


test('shared screens, preview visibility and quality stay inside the call', async ({ page }) => {
  await open(page, 'desktop');
  await fakeMedia(page, { joined: true, sharing: true });
  await page.evaluate(async (ids) => {
    const glass = await import('/src/stores/glassStore.ts' as string) as any;
    const voice = await import('/src/stores/voiceStore.ts' as string) as any;
    glass.useGlassStore.getState().openStage({ serverId: voice.useVoiceStore.getState().callScope.serverId, guildId: ids.guild, channelId: ids.lounge, streamerId: null });
  }, IDS);
  const stage = stagePane(page);
  await expect(stage.getByRole('group', { name: 'Shared screens' })).toBeVisible();
  await stage.getByRole('button', { name: 'Watch your stream' }).click();
  await expect(stage.locator('.glass-stage__stream[data-picture="true"]')).toBeVisible();
  await expect(stage.getByRole('button', { name: /React with/ })).toHaveCount(0);
  await stage.getByRole('button', { name: /Change stream quality:/ }).click();
  await page.getByRole('dialog', { name: 'Share quality' }).getByRole('button', { name: '1080p 60fps' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__appliedShareQuality)).toBe('1080p60');
  await stage.getByRole('button', { name: 'Hide your stream preview' }).click();
  await expect(stage.getByRole('button', { name: 'Watch your stream' })).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Stop sharing your screen' })).toBeVisible();
  const bounds = await stage.boundingBox();
  for (const control of await stage.locator('.glass-stage__controls > button').all()) {
    const rect = await control.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  await shoot(page, 'stage-call-sharing-controls');
});
