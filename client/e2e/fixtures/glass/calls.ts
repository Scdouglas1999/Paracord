import type { Page } from '@playwright/test';
import { CAST, CH, GAME_NIGHT_ID } from './scene';

/**
 * What a relay would do for the Glass reference scene, put into the stores from
 * the page, so the mocked review harness (glass-review.spec.ts) can reach the
 * pill's and the stage's states through their own controls with no media stack:
 *
 *   - `mode: 'listen' | 'joined'`: this client holds the Lounge's call (its row
 *     in the channel, the call's phase and mode), and Brendan talks.
 *   - a watch: `startWatch` goes live on an engine that paints the DEV fixture
 *     stream (`lib/room/fixtureFrameSource.ts`) into whatever canvas the stage
 *     hands it, and the call's engine paints Brendan's fixture camera.
 *
 * The same fakes the per-package specs use (glass-pill.spec.ts,
 * glass-stage.spec.ts), in one place for the harness.
 */
export interface SceneCall {
  /** Hold the Lounge's call in this mode; omitted, the client is not in it. */
  mode?: 'listen' | 'joined';
  /** The server's watcher count for Vincent's stream. */
  watchers?: number;
}

export async function fakeLoungeMedia(page: Page, call: SceneCall = {}): Promise<void> {
  await page.evaluate(
    async ({ ids, call: c }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const fixture = (await import('/src/lib/room/fixtureFrameSource.ts' as string)) as any;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const scope = { serverId, userId: ids.sean };
      const store = voice.useVoiceStore;

      const sources = new Map<string, any>();
      const source = (scene: string) => {
        if (!sources.has(scene)) sources.set(scene, fixture.createFixtureFrameSource({ scene, width: 1280, height: 720 }));
        return sources.get(scene);
      };
      /** An engine that paints a fixture scene into a canvas, like the WebCodecs route does. */
      const engineFor = (scenes: Record<string, string>) => ({
        subscribeVideo(userId: string, canvas: HTMLCanvasElement, onFrame?: () => void, opts?: { preferredTrackId?: string }) {
          const scene = scenes[`${userId}:${opts?.preferredTrackId ?? 'screen'}`];
          if (!scene) return () => {};
          const context = canvas.getContext('2d');
          return source(scene).subscribe((bitmap: ImageBitmap) => {
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
        tapVideoFrames(userId: string, trackId: string, onFrame: (frame: unknown) => void) {
          const scene = scenes[`${userId}:${trackId}`];
          if (!scene) return { route: Promise.resolve('no-track'), release: () => {} };
          const stop = source(scene).subscribe((bitmap: unknown) => onFrame(bitmap), 2);
          return { route: Promise.resolve('frames'), release: stop };
        },
        listPublishedTracks: async () => [],
        registerTrackSubscription: async () => {},
        setSourceVolume: () => {},
      });
      const watchEngine = engineFor({ [`${ids.vincent}:screen`]: 'stream' });
      const callEngine = engineFor({ [`${ids.brendan}:camera`]: 'camera', [`${ids.vincent}:screen`]: 'stream' });
      const joined = c.mode === 'joined';

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
          if (!c.watchers) return;
          store.getState().handleWatchersUpdate(
            { channel_id: ids.lounge, guild_id: ids.guild, streams: [{ user_id: ids.vincent, watchers: c.watchers }] },
            scope,
          );
        },
      });

      // Vincent went live 42 minutes before the scene's clock, as the server would say.
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
        self_mute: c.mode === 'listen',
        self_stream: false,
        self_video: false,
        suppress: false,
        mode: c.mode ?? 'joined',
      };
      // The mocked gateway replays READY now and then; put the call's rows back each time.
      const put = () => {
        const current = store.getState();
        const there = current.channelParticipants.get(ids.lounge) ?? [];
        const vincent = there.find((s: any) => s.user_id === ids.vincent);
        const settled = vincent?.self_stream_started_at && (!c.mode || there.some((s: any) => s.user_id === ids.sean && s.mode === c.mode));
        if (settled) return;
        const rows = there
          .filter((s: any) => s.user_id !== ids.sean)
          .map((s: any) => (s.user_id === ids.vincent ? { ...s, self_stream_started_at: startedAt } : s));
        if (c.mode) rows.push(me);
        const channelParticipants = new Map(current.channelParticipants);
        channelParticipants.set(ids.lounge, rows);
        store.setState({
          channelParticipants,
          ...(c.mode
            ? {
                callId: 'e2e-call',
                callScope: scope,
                callPhase: 'connected',
                callMode: c.mode,
                connected: true,
                joining: false,
                channelId: ids.lounge,
                guildId: ids.guild,
                selfMute: c.mode === 'listen',
                mediaEngine: joined ? callEngine : null,
                participants: new Map(rows.map((s: any) => [s.user_id, s])),
                speakingUsers: new Set([ids.brendan]),
              }
            : {}),
        });
      };
      put();
      store.subscribe(put);
      if (c.mode) {
        const levels = (await import('/src/lib/motion/voiceLevel.ts' as string)) as any;
        const speak = () => levels.publishVoiceLevels('room', new Map([[ids.brendan, 0.55 + 0.35 * Math.sin(Date.now() / 260)]]));
        speak();
        setInterval(speak, 250);
      }
    },
    {
      ids: { sean: CAST.sean.id, vincent: CAST.vincent.id, brendan: CAST.brendan.id, lounge: CH.lounge, guild: GAME_NIGHT_ID },
      call,
    },
  );
}
