import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { CAST, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * WP-G15 (theater, browse, the moves): the stage on the Glass reference scene,
 * mocked like glass-stage.spec.ts (no server, no media stack), at 1440x900.
 * Each state is reached the way a person reaches it: the pill's Watch, then the
 * stage's keys (T, H, S) or buttons. The media a relay would deliver is put
 * into the stores from the page (the same fake as WP-G14's spec).
 *
 * The filmstrips hold a move at fixed moments: each frame is its own run of
 * the move, frozen (every running animation paused at the same time) right
 * after it starts, so the shot is exactly that moment.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g15 npx playwright test -c e2e/glass-theater.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/theater-*.png, browse-*.png,
 * move-*.png and theater-rects.json
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'g15';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const DESKTOP = { width: 1440, height: 900 };

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
const rects: Record<string, unknown> = {};

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(path.join(OUT_DIR, 'theater-rects.json'), JSON.stringify(rects, null, 2));
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

async function open(page: Page) {
  await page.setViewportSize(DESKTOP);
  await installGlassScene(page);
  await page.goto(general);
  await expect(page.getByRole('main')).toBeVisible();
}

const pill = (page: Page) => page.getByRole('region', { name: /live voice channel|voice call/ });
const stagePane = (page: Page) => page.getByRole('region', { name: 'Stage' });

async function watchFromPill(page: Page) {
  await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
  await expect(stagePane(page)).toBeVisible();
  await expect(page.locator('.glass-frame__stage .glass-stage__stream[data-picture="true"]')).toBeVisible();
}

/** Every move's clones and shield are gone, and nothing of it is still playing. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.getAnimations().filter((a) => a.id.startsWith('glass-morph:') && a.playState === 'running').length
        + document.querySelectorAll('.glass-morph > *').length,
      ),
    )
    .toBe(0);
  await page.waitForTimeout(250);
}

/**
 * The mocked server refuses read-state acks ("Failed to save read position"), and
 * that toast is the harness's, not the stage's: clear it before a shot.
 */
async function clearToasts(page: Page) {
  await page.evaluate(async () => {
    const toasts = (await import('/src/stores/toastStore.ts' as string)) as any;
    toasts.useToastStore.setState({ toasts: [] });
  });
}

async function shoot(page: Page, name: string) {
  await page.mouse.move(DESKTOP.width - 3, DESKTOP.height - 3);
  await clearToasts(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
}

async function box(locator: Locator) {
  if ((await locator.count()) === 0) return null;
  const b = await locator.first().boundingBox();
  if (!b) return null;
  return { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
}

async function measure(page: Page, key: string) {
  const buttons = await page.locator('.glass-frame__stage .glass-stage__controls > button').all();
  rects[key] = {
    stage: await box(stagePane(page)),
    stream: await box(page.locator('.glass-frame__stage .glass-stage__stream')),
    title: await box(page.locator('.glass-frame__stage [data-glass-move="title"]')),
    actions: await box(page.locator('.glass-frame__stage [data-glass-move="actions"]')),
    tiles: await Promise.all((await page.locator('.glass-frame__stage .glass-theater__people .glass-stage__tile').all()).map(box)),
    faces: await Promise.all((await page.locator('.glass-frame__stage .glass-theater__face').all()).map(box)),
    controls: await box(page.locator('.glass-frame__stage .glass-stage__controls')),
    controlButtons: await Promise.all(buttons.map(box)),
    surfacing: await Promise.all((await page.locator('.glass-surfacing__bubble').all()).map(box)),
    reactions: await box(page.locator('.glass-frame__stage .glass-reactions')),
    conversation: await box(page.getByRole('main')),
    places: await box(page.locator('.glass-frame__places')),
  };
}

/** Messages that arrive in General while the chat is hidden (screens/05). */
async function arrive(page: Page) {
  await page.evaluate(
    async ({ ids, channel }) => {
      const messages = (await import('/src/stores/messageStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const store = messages.getMessageStore({ serverId, userId: ids.sean });
      const author = (id: string, name: string) => ({ id, username: name.toLowerCase(), display_name: name, avatar_hash: null });
      const base = BigInt('900000000000000000');
      const at = new Date().toISOString();
      const send = (n: number, who: { id: string; name: string }, content: string) =>
        store.getState().addMessage(channel, {
          id: String(base + BigInt(n)),
          channel_id: channel,
          author: author(who.id, who.name),
          content,
          timestamp: at,
          created_at: at,
          tts: false,
          mention_everyone: false,
          pinned: false,
          type: 0,
          attachments: [],
          reactions: [],
        });
      send(1, { id: ids.nick, name: 'Nick' }, 'that flare placement was perfect');
      await new Promise((resolve) => setTimeout(resolve, 250));
      send(2, { id: ids.jeremy, name: 'Jeremy' }, `<@${ids.sean}> is movie night still on?`);
    },
    { ids: { sean: CAST.sean.id, nick: CAST.nick.id, jeremy: CAST.jeremy.id }, channel: CH.general },
  );
}

test('05 theater with the chat beside it, joined', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await watchFromPill(page);
  await settled(page);
  await page.keyboard.press('t');
  await settled(page);
  const stage = stagePane(page);
  await expect(page.locator('.glass-stage[data-mode="theater"]')).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Hide chat' })).toHaveAttribute('aria-pressed', 'true');
  // Only the talker has a tile; everyone else is a face.
  await expect(page.locator('.glass-theater__people .glass-stage__tile')).toHaveCount(1);
  await expect(page.locator('.glass-theater__people .glass-stage__tile')).toContainText('Brendan');
  await expect(page.getByRole('main')).not.toHaveAttribute('data-away', 'true');
  await measure(page, '05-chat');
  await shoot(page, 'theater-05-chat-desktop');
});

test('05 theater, chat hidden (H), messages surfacing; a click brings the chat back', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await watchFromPill(page);
  await settled(page);
  await page.keyboard.press('t');
  await settled(page);
  await page.keyboard.press('h');
  await settled(page);
  await expect(page.getByRole('main')).toHaveAttribute('data-away', 'true');
  await arrive(page);
  const surfaced = page.getByRole('button', { name: /Show chat, 2 new messages/ });
  await expect(surfaced).toBeVisible();
  await expect(page.locator('.glass-surfacing__bubble[data-mention="true"]')).toContainText('mentioned you');
  await expect(page.locator('.glass-surfacing__bubble').first()).toContainText('Nick in General');
  await measure(page, '05-hidden');
  await shoot(page, 'theater-05-hidden-desktop');
  await surfaced.click();
  await expect(page.getByRole('main')).not.toHaveAttribute('data-away', 'true');
  await expect(page.locator('.glass-surfacing__bubble')).toHaveCount(0);
});

test('06 browse (S), side by side, not joined', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false, watchers: 1 });
  await watchFromPill(page);
  await settled(page);
  await page.keyboard.press('s');
  await settled(page);
  await expect(page.locator('.glass-frame__places')).toBeVisible();
  await expect(page.getByRole('main')).toHaveAttribute('data-away', 'true');
  await measure(page, '06-browse-side');
  await shoot(page, 'browse-06-side-desktop');
  // Esc puts places away first, and the conversation comes back.
  await page.keyboard.press('Escape');
  await settled(page);
  await expect(page.locator('.glass-frame__places')).toHaveCount(0);
  await expect(stagePane(page)).toBeVisible();
});

test('browse in theater: places floats over the stream, the faces and controls move over', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false, watchers: 1 });
  await watchFromPill(page);
  await settled(page);
  await page.keyboard.press('t');
  await settled(page);
  await page.keyboard.press('s');
  await settled(page);
  await expect(page.locator('.glass-stage[data-mode="theater"][data-browse="true"]')).toBeVisible();
  await expect(page.getByRole('main')).toHaveAttribute('data-away', 'true');
  await measure(page, '06-browse-theater');
  await shoot(page, 'browse-06-theater-desktop');
  // Picking a channel closes browse and brings that conversation back beside the stream.
  await page.locator('.glass-frame__places').getByRole('link', { name: /Clips/ }).first().click();
  await settled(page);
  await expect(page.locator('.glass-frame__places')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toHaveAttribute('data-away', 'true');
  await expect(page.locator('.glass-stage[data-mode="theater"]')).toBeVisible();
  await expect(page.locator('.glass-frame__stage .glass-stage__stream[data-picture="true"]')).toBeVisible();
  await measure(page, '06-browse-theater-picked');
  await shoot(page, 'browse-06-theater-picked-desktop');
});

test('Stop watching shrinks the stage back into the pill and keeps the call', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true });
  await watchFromPill(page);
  await settled(page);
  await page.keyboard.press('Escape');
  await expect(stagePane(page)).toHaveCount(0);
  await settled(page);
  await expect(pill(page).getByRole('button', { name: 'Leave Lounge' })).toBeVisible();
});

/** Freeze every running animation at `ms` into the move. */
async function freezeAt(page: Page, ms: number) {
  await page.evaluate((t) => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = t;
    }
  }, ms);
}

const FRAMES = [0, 60, 140, 240, 360, 500, 650];

test('filmstrip: the pill grows into the stage, and shrinks back', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false, watchers: 1 });
  for (const ms of FRAMES) {
    await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
    await freezeAt(page, ms);
    await clearToasts(page);
    await page.screenshot({ path: path.join(OUT_DIR, `move-open-${String(ms).padStart(3, '0')}.png`) });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));
    await settled(page);
    await page.waitForTimeout(600);
    await stagePane(page).getByRole('button', { name: /Stop watching/ }).click();
    await freezeAt(page, ms);
    await clearToasts(page);
    await page.screenshot({ path: path.join(OUT_DIR, `move-close-${String(ms).padStart(3, '0')}.png`) });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));
    await settled(page);
    await page.waitForTimeout(400);
  }
});

test('filmstrip: side by side to theater, and back', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: true, watchers: 2 });
  await watchFromPill(page);
  await settled(page);
  for (const ms of FRAMES) {
    await page.keyboard.press('t');
    await freezeAt(page, ms);
    await clearToasts(page);
    await page.screenshot({ path: path.join(OUT_DIR, `move-theater-${String(ms).padStart(3, '0')}.png`) });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));
    await settled(page);
    await page.keyboard.press('t');
    await freezeAt(page, ms);
    await clearToasts(page);
    await page.screenshot({ path: path.join(OUT_DIR, `move-side-${String(ms).padStart(3, '0')}.png`) });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));
    await settled(page);
  }
});

test('filmstrip: browse in side by side', async ({ page }) => {
  await open(page);
  await fakeMedia(page, { joined: false });
  await watchFromPill(page);
  await settled(page);
  for (const ms of [0, 140, 300, 650]) {
    await page.keyboard.press('s');
    await freezeAt(page, ms);
    await clearToasts(page);
    await page.screenshot({ path: path.join(OUT_DIR, `move-browse-${String(ms).padStart(3, '0')}.png`) });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));
    await settled(page);
    await page.keyboard.press('s');
    await settled(page);
  }
});

test('reduced motion: a layout change is a 150ms crossfade, nothing travels', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await fakeMedia(page, { joined: true });
  const played = await page.evaluate(async () => {
    const seen: Array<{ id: string; duration: number; transform: boolean }> = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes: any, options: any) {
      const animation = original.call(this, keyframes, options);
      const frames = Array.isArray(keyframes) ? keyframes : [];
      const moves = frames.some((f: any) => typeof f.transform === 'string' && f.transform !== 'none' && !/^translate\(0px, 0px\) scale\(1, 1\)$/.test(f.transform));
      queueMicrotask(() => seen.push({ id: animation.id, duration: Number(options?.duration ?? 0), transform: moves }));
      return animation;
    };
    (window as any).__seen = seen;
    return true;
  });
  expect(played).toBe(true);
  await watchFromPill(page);
  await page.keyboard.press('t');
  await page.waitForTimeout(400);
  const seen = await page.evaluate(() => (window as any).__seen as Array<{ id: string; duration: number; transform: boolean }>);
  const morphs = seen.filter((s) => s.id.startsWith('glass-morph:'));
  expect(morphs.length).toBeGreaterThan(0);
  for (const s of morphs) {
    expect(s.duration).toBe(150);
    expect(s.transform).toBe(false);
  }
});
