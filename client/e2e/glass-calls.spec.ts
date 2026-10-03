import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installGlassScene } from './fixtures/glass/install';
import { CAST, CH, GAME_NIGHT_ID } from './fixtures/glass/scene';

/**
 * WP-G22 (Retire Lantern): the call surfaces that replaced the Lantern voice
 * page and the DM call's stream viewer, on the mocked Glass scene.
 *
 *   - A voice channel opened from the places panel is its CHAT, with the call
 *     pill for that channel in the header (even while nobody is in it).
 *   - Joined with nobody else's screen to watch, the pill's "Show the call"
 *     puts the call itself on the stage: the cameras big, the call's controls.
 *   - A DM call is the same: the pill, then the call on the stage, named for the
 *     person, with no server.
 *
 * What a relay would do is put into the stores from the page (as
 * glass-stage.spec.ts does): the call's engine paints the DEV fixture camera
 * for Brendan.
 *
 *   cd client
 *   PARACORD_E2E_GLASS_WP=g22 npx playwright test -c e2e/glass-calls.config.ts
 *
 * Output: output/design-reference/glass-build/<WP>/calls-*.png
 */
const WP = process.env.PARACORD_E2E_GLASS_WP || 'g22';
const OUT_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'glass-build', WP);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

const general = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
const lounge = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.lounge}`;
const dmBrendan = `/app/dms/${CH.dmBrendan}`;

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

async function open(page: Page, size: keyof typeof SIZES, route: string, quiet = true) {
  await page.setViewportSize(SIZES[size]);
  await installGlassScene(page, { quiet });
  await page.goto(route);
  await expect(page.getByRole('main')).toBeVisible();
}

async function shoot(page: Page, name: string) {
  const size = page.viewportSize();
  if (size) await page.mouse.move(size.width - 3, size.height - 3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
}

const stagePane = (page: Page) => page.getByRole('region', { name: 'Stage' });

/**
 * This client holds a call in `channelId` with Brendan (camera on, talking) and
 * Nick (muted): the store state a joined call has, and an engine that paints the
 * fixture camera for Brendan.
 */
async function holdCall(page: Page, target: { channelId: string; guildId: string | null }) {
  await page.evaluate(
    async ({ ids, target }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const fixture = (await import('/src/lib/room/fixtureFrameSource.ts' as string)) as any;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const scope = { serverId, userId: ids.sean };
      const store = voice.useVoiceStore;
      const camera = fixture.createFixtureFrameSource({ scene: 'camera', width: 1280, height: 720 });
      const engine = {
        subscribeVideo(userId: string, canvas: HTMLCanvasElement, onFrame?: () => void, opts?: { preferredTrackId?: string }) {
          if (userId !== ids.brendan || opts?.preferredTrackId !== 'camera') return () => {};
          const context = canvas.getContext('2d');
          return camera.subscribe((bitmap: ImageBitmap) => {
            const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
            const h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
            const scale = Math.max(w / bitmap.width, h / bitmap.height);
            context?.drawImage(bitmap, (w - bitmap.width * scale) / 2, (h - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
            bitmap.close();
            onFrame?.();
          }, 8);
        },
        tapVideoFrames: () => ({ route: Promise.resolve('no-track'), release: () => {} }),
        listPublishedTracks: async () => [],
        registerTrackSubscription: async () => {},
      };
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
        row(ids.brendan, 'Brendan', { self_video: true }),
        ...(target.guildId ? [row(ids.nick, 'Nick', { self_mute: true })] : []),
        row(ids.sean, 'Sean'),
      ];
      // The mocked gateway replays READY now and then; put the call back each time.
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
      ids: { sean: CAST.sean.id, brendan: CAST.brendan.id, nick: CAST.nick.id },
      target,
    },
  );
}

test('a voice channel opened from places is its chat, with its pill (desktop)', async ({ page }) => {
  await open(page, 'desktop', general);
  await page.getByRole('navigation', { name: 'Channels' }).getByRole('link', { name: /Lounge/ }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${CH.lounge}$`));
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('Lounge');
  const pill = main.getByRole('region', { name: 'Lounge, live voice channel' });
  await expect(pill.getByRole('button', { name: 'Join Lounge' })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Listen in to Lounge' })).toBeVisible();
  await expect(main.getByRole('textbox')).toBeVisible();
  await shoot(page, 'calls-voice-chat-desktop');
});

test('a live voice channel keeps its pill in its chat: Listen, Watch, Join (desktop)', async ({ page }) => {
  await open(page, 'desktop', lounge, false);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('Lounge');
  const pill = main.getByRole('region', { name: 'Lounge, live voice channel' });
  await expect(pill.getByRole('button', { name: "Watch Vincent's screen" })).toBeVisible();
  await expect(pill.getByRole('button', { name: 'Join Lounge' })).toBeVisible();
  await shoot(page, 'calls-voice-chat-live-desktop');
});

test('a voice channel opened from places on a phone', async ({ page }) => {
  await open(page, 'phone', general);
  await page.getByRole('button', { name: 'Back to places' }).click();
  await page.getByRole('navigation', { name: 'Channels' }).getByRole('link', { name: /Lounge/ }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${CH.lounge}$`));
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('Lounge');
  await expect(main.getByRole('region', { name: 'Lounge, live voice channel' }).getByRole('button', { name: 'Join Lounge' })).toBeVisible();
  await shoot(page, 'calls-voice-chat-phone');
});

test('joined with no stream: Show the call puts the call on the stage (desktop)', async ({ page }) => {
  await open(page, 'desktop', lounge);
  await holdCall(page, { channelId: CH.lounge, guildId: GAME_NIGHT_ID });
  const pill = page.getByRole('main').getByRole('region', { name: 'Lounge, live voice channel' });
  await expect(pill.getByRole('button', { name: 'Leave Lounge' })).toBeVisible();
  await pill.getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  await expect(stage).toBeVisible();
  await expect(stage.getByText('Game Night Lounge')).toBeVisible();
  await expect(stage.getByText('3 in the call')).toBeVisible();
  await expect(stage.locator('.glass-stage__tile[data-talking="true"]')).toContainText('Brendan');
  const row = stage.getByRole('group', { name: 'Call controls' });
  await expect(row.getByRole('button', { name: 'Camera' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Share your screen' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Clip' })).toHaveCount(0);
  // The conversation stays beside it and keeps working.
  await expect(page.getByRole('main').getByRole('textbox')).toBeVisible();
  await shoot(page, 'calls-call-stage-desktop');

  await row.getByRole('button', { name: 'More call actions' }).click();
  await expect(page.getByRole('menu', { name: 'More call actions' })).toBeVisible();
  await shoot(page, 'calls-call-stage-more-desktop');
  await page.keyboard.press('Escape');

  // Close (Esc) keeps the call.
  await page.keyboard.press('Escape');
  await expect(stagePane(page)).toHaveCount(0);
  await expect(pill.getByRole('button', { name: 'Leave Lounge' })).toBeVisible();
});

test('joined with no stream, on a phone: the call card, then full screen', async ({ page }) => {
  await open(page, 'phone', lounge);
  await holdCall(page, { channelId: CH.lounge, guildId: GAME_NIGHT_ID });
  await page.getByRole('main').getByRole('button', { name: 'Show the call' }).click();
  await expect(stagePane(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close the call view' })).toBeVisible();
  await shoot(page, 'calls-call-stage-phone');
  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect(page.getByRole('group', { name: 'Call controls' })).toBeVisible();
  await shoot(page, 'calls-call-stage-phone-fullscreen');
});

test('a DM call: the pill, then the call on the stage, named for the person (desktop)', async ({ page }) => {
  await open(page, 'desktop', dmBrendan);
  await holdCall(page, { channelId: CH.dmBrendan, guildId: null });
  const pill = page.getByRole('main').getByRole('region', { name: 'Brendan, voice call' });
  await expect(pill.getByRole('button', { name: 'Leave Brendan' })).toBeVisible();
  await expect(pill.getByRole('button', { name: /Listen in/ })).toHaveCount(0);
  await pill.getByRole('button', { name: 'Show the call' }).click();
  const stage = stagePane(page);
  // The fixture's DM names Brendan by his username only, as the header does.
  await expect(stage.locator('.glass-stage__title')).toHaveText(/^brendan$/i);
  await expect(stage.locator('.glass-stage__tile')).toContainText(/brendan/i);
  const row = stage.getByRole('group', { name: 'Call controls' });
  // A DM call takes screen shares too (docs/design/glass-fix-dm-calls.md).
  await expect(row.getByRole('button', { name: 'Share your screen' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Leave Brendan' })).toBeVisible();
  await shoot(page, 'calls-dm-call-stage-desktop');
});
