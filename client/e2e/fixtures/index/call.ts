/**
 * What a media relay would do, put into the stores from the page, so the mocked
 * harness reaches "you are in a call" and "you are watching Vincent" through the
 * app's own controls with no media stack.
 *
 * `installFakeVoice(page, ids)` runs once per page load (stores reset on a
 * reload, so `IndexHarness.open` does it for you). It replaces the voice
 * store's ACTIONS (`joinChannel`, `listen`, `leaveChannel`, `startWatch`, ...)
 * with ones that only move state, then exposes `window.__ixVoice.hold(...)` so
 * a step can put you in a call without a click. After that:
 *
 *   - clicking Join in any card reaches "yours" (your row appears in the room,
 *     the call phase is `connected`, the engine paints the DEV fixture camera
 *     and stream into whatever canvas it is handed);
 *   - Leave, mute, camera, screen share, Watch and Stop watching all work on
 *     state alone;
 *   - the waveform's voice levels are published for whoever is talking.
 *
 * The same fakes the Glass specs use (`glass-calls.spec.ts`, `glass-pill.spec.ts`),
 * in one place. Real media is `scripts/index-scene.mjs`'s job (IX-3).
 *
 * THE FIXTURE FRAME SOURCE. Video is the DEV fixture (`FIXTURE_MODULE`): a
 * deterministic canvas stream and camera. If that module is ever moved, change
 * the constant, nothing else; if it is gone, `installFakeVoice` throws (pass
 * `video: false` for a spec that never shows a stream).
 */
import type { Page } from '@playwright/test';

export const FIXTURE_MODULE = '/src/lib/room/fixtureFrameSource.ts';

export interface FakeVoiceIds {
  /** Your user id. */
  you: string;
  /** Who has a camera and who shares a screen, by user id, for the fixture engine. */
  cameras: string[];
  streams: string[];
}

export interface FakeVoiceOptions {
  /** Paint video with the DEV fixture. Default true. */
  video?: boolean;
}

export interface HoldCallOptions {
  channelId: string;
  /** Null for a DM or group call. */
  guildId: string | null;
  mode?: 'joined' | 'listen';
}

declare global {
  interface Window {
    __ixVoice?: {
      hold(options: HoldCallOptions): void;
      release(): void;
    };
  }
}

export async function installFakeVoice(page: Page, ids: FakeVoiceIds, options: FakeVoiceOptions = {}): Promise<void> {
  await page.evaluate(
    async ({ ids, fixtureModule, video }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const list = (await import('/src/stores/serverListStore.ts' as string)) as any;
      const scopeModule = (await import('/src/lib/serverScope.ts' as string)) as any;
      const remote = (await import('/src/stores/remoteSpeakingStore.ts' as string)) as any;
      const levels = (await import('/src/lib/motion/voiceLevel.ts' as string)) as any;
      const fixture = video ? ((await import(/* @vite-ignore */ fixtureModule as string)) as any) : null;
      const store = voice.useVoiceStore;
      const serverId = list.useServerListStore.getState().activeServerId ?? scopeModule.LOCAL_SERVER_ID;
      const scope = { serverId, userId: ids.you };

      /** An engine that paints a fixture scene into a canvas, like the WebCodecs route does. */
      const sources = new Map<string, any>();
      const source = (scene: string) => {
        if (!sources.has(scene)) sources.set(scene, fixture.createFixtureFrameSource({ scene, width: 1280, height: 720 }));
        return sources.get(scene);
      };
      const sceneFor = (userId: string, track: string): string | null => {
        if (track === 'camera' && ids.cameras.includes(userId)) return 'camera';
        if (track === 'screen' && ids.streams.includes(userId)) return 'stream';
        return null;
      };
      const engine = {
        subscribeVideo(userId: string, canvas: HTMLCanvasElement, onFrame?: () => void, opts?: { preferredTrackId?: string }) {
          const scene = fixture ? sceneFor(userId, opts?.preferredTrackId ?? 'screen') : null;
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
          const scene = fixture ? sceneFor(userId, trackId) : null;
          if (!scene) return { route: Promise.resolve('no-track'), release: () => {} };
          const stop = source(scene).subscribe((bitmap: unknown) => onFrame(bitmap), 2);
          return { route: Promise.resolve('frames'), release: stop };
        },
        listPublishedTracks: async () => [],
        registerTrackSubscription: async () => {},
        setSourceVolume: () => {},
      };

      const row = (channelId: string, guildId: string | null, mode: string, over: Record<string, unknown> = {}) => ({
        user_id: ids.you,
        channel_id: channelId,
        guild_id: guildId ?? undefined,
        session_id: 'ix-session',
        username: 'sean',
        display_name: 'Sean',
        avatar_hash: null,
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: mode === 'listen',
        self_stream: false,
        self_video: false,
        suppress: false,
        mode,
        joined_at: new Date().toISOString(),
        ...over,
      });

      const withoutMe = (channelParticipants: Map<string, any[]>) => {
        const next = new Map(channelParticipants);
        for (const [channelId, members] of next) {
          const rest = members.filter((s: any) => s.user_id !== ids.you);
          if (rest.length === 0) next.delete(channelId);
          else if (rest.length !== members.length) next.set(channelId, rest);
        }
        return next;
      };

      let levelTimer: ReturnType<typeof setInterval> | null = null;
      const publishLevels = () => {
        const state = store.getState();
        if (!state.channelId) return;
        const talking = new Set<string>(state.speakingUsers ?? []);
        const speakers = remote.useRemoteSpeakingStore.getState().byChannel.get(`${state.guildId}:${state.channelId}`);
        for (const id of speakers ?? []) talking.add(id);
        // performance.now, not Date: the scene pins Date.
        const level = 0.55 + 0.35 * Math.sin(performance.now() / 260);
        levels.publishVoiceLevels('room', new Map([...talking].map((id) => [id, level])));
      };

      const hold = ({ channelId, guildId, mode = 'joined' }: { channelId: string; guildId: string | null; mode?: string }) => {
        const current = store.getState();
        const there = (current.channelParticipants.get(channelId) ?? []).filter((s: any) => s.user_id !== ids.you);
        const me = row(channelId, guildId, mode);
        const members = [...there, me];
        const channelParticipants = withoutMe(current.channelParticipants);
        channelParticipants.set(channelId, members);
        store.setState({
          channelParticipants,
          callId: 'ix-call',
          callScope: scope,
          callPhase: 'connected',
          callMode: mode,
          connected: true,
          joining: false,
          joiningChannelId: null,
          connectionError: null,
          channelId,
          guildId: guildId ?? 'dm',
          selfMute: mode === 'listen',
          selfVideo: false,
          selfStream: false,
          mediaEngine: mode === 'joined' ? engine : null,
          participants: new Map(members.map((s: any) => [s.user_id, s])),
          speakingUsers: new Set(members.filter((s: any) => s.speaking).map((s: any) => s.user_id)),
        });
        if (!levelTimer) levelTimer = setInterval(publishLevels, 250);
        publishLevels();
      };

      const release = () => {
        const current = store.getState();
        const watching = current.watchView?.route === 'call';
        store.setState({
          channelParticipants: withoutMe(current.channelParticipants),
          callId: null,
          callScope: null,
          callPhase: 'idle',
          callMode: null,
          connected: false,
          channelId: null,
          guildId: null,
          selfMute: false,
          selfVideo: false,
          selfStream: false,
          mediaEngine: null,
          participants: new Map(),
          speakingUsers: new Set(),
          ...(watching ? { watchView: null } : {}),
        });
        if (levelTimer) clearInterval(levelTimer);
        levelTimer = null;
      };

      const updateMe = (patch: Record<string, unknown>) => {
        const current = store.getState();
        const channelId = current.channelId;
        if (!channelId) return;
        const members = (current.channelParticipants.get(channelId) ?? []).map((s: any) => (s.user_id === ids.you ? { ...s, ...patch } : s));
        const channelParticipants = new Map(current.channelParticipants);
        channelParticipants.set(channelId, members);
        store.setState({ channelParticipants, participants: new Map(members.map((s: any) => [s.user_id, s])) });
      };

      store.setState({
        joinChannel: async (channelId: string, guildId?: string) => hold({ channelId, guildId: guildId && guildId !== 'dm' ? guildId : null }),
        listen: async (channelId: string, guildId: string) => hold({ channelId, guildId, mode: 'listen' }),
        joinFromListen: async () => {
          const s = store.getState();
          if (s.channelId) hold({ channelId: s.channelId, guildId: s.guildId === 'dm' ? null : s.guildId });
        },
        leaveChannel: async () => release(),
        toggleMute: async () => {
          const selfMute = !store.getState().selfMute;
          store.setState({ selfMute });
          updateMe({ self_mute: selfMute });
        },
        toggleDeaf: async () => {
          const selfDeaf = !store.getState().selfDeaf;
          store.setState({ selfDeaf });
          updateMe({ self_deaf: selfDeaf });
        },
        toggleVideo: async () => {
          const selfVideo = !store.getState().selfVideo;
          store.setState({ selfVideo });
          updateMe({ self_video: selfVideo });
        },
        startStream: async () => {
          store.setState({ selfStream: true });
          updateMe({ self_stream: true, self_stream_started_at: new Date().toISOString() });
        },
        stopStream: () => {
          store.setState({ selfStream: false });
          updateMe({ self_stream: false, self_stream_started_at: null });
        },
        startWatch: async (target: any) => {
          const joined = store.getState().callMode === 'joined';
          store.setState({
            watchView: {
              id: 'ix-watch',
              kind: 'watch',
              scope,
              guildId: target.guildId,
              channelId: target.channelId,
              streamerId: target.streamerId,
              // In the call the watch rides the call; otherwise it is its own lightweight session.
              route: joined && store.getState().channelId === target.channelId ? 'call' : 'session',
              phase: 'live',
              engine,
              sessionId: 'ix-view',
              endReason: null,
              pauseReason: null,
              error: null,
            },
          });
        },
        stopWatch: async () => store.setState({ watchView: null }),
        fetchWatchers: async () => {},
      });

      window.__ixVoice = { hold: (options) => hold(options), release };
    },
    { ids, fixtureModule: FIXTURE_MODULE, video: options.video ?? true },
  );
}

/** Put this client in a call, without a click (what the Join step does). */
export async function holdCall(page: Page, options: HoldCallOptions): Promise<void> {
  const installed = await page.evaluate(() => Boolean(window.__ixVoice));
  if (!installed) throw new Error('holdCall: installFakeVoice has not run on this page (IndexHarness.open does it).');
  await page.evaluate((o) => window.__ixVoice!.hold(o), options);
}

/** Leave the fake call, without a click. */
export async function releaseCall(page: Page): Promise<void> {
  await page.evaluate(() => window.__ixVoice?.release());
}
