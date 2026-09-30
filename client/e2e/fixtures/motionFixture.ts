import type { Page } from '@playwright/test';

import { installGlassScene } from './glass/install';
import { CAST, CH, GAME_NIGHT_ID } from './glass/scene';

/**
 * The mocked world the motion gate drives (`e2e/motion-gate.spec.ts`): the Glass
 * reference scene (fixtures/glass), with no server and no media stack, so every
 * Glass moment can be measured on the same page a person would see it on.
 *
 *   - `installMotionMocks` is `installGlassScene`: Game Night with its live
 *     Lounge (Vincent sharing, Brendan on camera), Basecamp behind it, and the
 *     DEV fixture stream lighting the room;
 *   - `fakeMedia` puts the media a relay would deliver into the stores, so a
 *     stream exists for the stage to draw (the same fake the stage, theater and
 *     pill specs use, through the DEV fixture frame source);
 *   - `readMotionConstants` reads, from the running app, every number the gate
 *     holds a moment to: each package's own constant and the `--glass-ms*`
 *     tokens. The gate cites them; it never hard-codes a duration of its own.
 */

export const GENERAL = `/app/guilds/${GAME_NIGHT_ID}/channels/${CH.general}`;
export const BASECAMP = 'Basecamp';

const IDS = {
  sean: CAST.sean.id,
  vincent: CAST.vincent.id,
  brendan: CAST.brendan.id,
  lounge: CH.lounge,
  guild: GAME_NIGHT_ID,
};

export async function installMotionMocks(page: Page): Promise<void> {
  await installGlassScene(page);
}

/** Every duration the gate measures against, read from the app itself. */
export interface MotionConstants {
  /** `pill/pillMotion.ts`: the pill's grow and shrink ("spring, 550ms", §5). */
  PILL_SPRING_MS: number;
  /** `pill/pillMotion.ts`: the words fading before the capsule shrinks, and its reduced-motion twin. */
  PILL_FADE_MS: number;
  PILL_FADE_REDUCED_MS: number;
  /** `stage/stageTransition.ts`: pill -> stage, side by side <-> theater, browse, H (§6, §9). */
  STAGE_MOVE_MS: number;
  /** `stage/stageTransition.ts`: what every one of those becomes under reduced motion (§9). */
  STAGE_CROSSFADE_MS: number;
  /** `shell/phoneMotion.ts`: the phone's screen change, and its reduced-motion crossfade. */
  PHONE_SLIDE_MS: number;
  PHONE_FADE_MS: number;
  /** `styles/tokens.css` §9: hover and press. */
  glassMs: number;
  /** `--glass-ms-layout`: the CSS side of the layout moves (the conversation stepping aside). */
  glassMsLayout: number;
  /** `--glass-ms-room`: the room's crossfade on a server switch. */
  glassMsRoom: number;
  /** `--glass-ms-reduced`: the crossfade that replaces a move. */
  glassMsReduced: number;
  /** `--duration-slow`: the engine's content swap, a route change's 4px rise (`lib/motion/animate.ts`, `contentIn`). */
  durationSlow: number;
  /** `--duration-move`: the shared element (`lib/motion/sharedElement.ts`, `transitionWith`). */
  durationMove: number;
}

export async function readMotionConstants(page: Page): Promise<MotionConstants> {
  return page.evaluate(async () => {
    const pill = (await import('/src/components/glass/pill/pillMotion.ts' as string)) as Record<string, number>;
    const stage = (await import('/src/components/glass/stage/stageTransition.ts' as string)) as Record<string, number>;
    const phone = (await import('/src/components/glass/shell/phoneMotion.ts' as string)) as Record<string, number>;
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => Number.parseFloat(css.getPropertyValue(name));
    return {
      PILL_SPRING_MS: pill.PILL_SPRING_MS,
      PILL_FADE_MS: pill.PILL_FADE_MS,
      PILL_FADE_REDUCED_MS: pill.PILL_FADE_REDUCED_MS,
      STAGE_MOVE_MS: stage.STAGE_MOVE_MS,
      STAGE_CROSSFADE_MS: stage.STAGE_CROSSFADE_MS,
      PHONE_SLIDE_MS: phone.PHONE_SLIDE_MS,
      PHONE_FADE_MS: phone.PHONE_FADE_MS,
      glassMs: token('--glass-ms'),
      glassMsLayout: token('--glass-ms-layout'),
      glassMsRoom: token('--glass-ms-room'),
      glassMsReduced: token('--glass-ms-reduced'),
      durationSlow: token('--duration-slow'),
      durationMove: token('--duration-move'),
    };
  });
}

/**
 * The media a relay would deliver, faked in the page: `startWatch` goes live on
 * an engine that paints the fixture stream into whatever canvas it is given (and
 * taps it for the glow), `stopWatch` clears it, and the watcher count and the
 * stream's start time are what the server would say. `joined` also puts this
 * client in the Lounge's call, with Brendan's camera and voice level.
 */
export async function fakeMedia(page: Page, options: { joined: boolean; watchers?: number }): Promise<void> {
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
          // Half the stage specs' size and a slower beat: the gate measures the page's frames, and a
          // fixture that paints 1280x720 eight times a second would be the heaviest thing on the main
          // thread (createImageBitmap alone was a tenth of it). A real stream is decoded off it.
          if (!sources.has(scene)) sources.set(scene, fixture.createFixtureFrameSource({ scene, width: 320, height: 180 }));
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
            }, 2);
            return stop;
          },
          tapVideoFrames(userId: string, trackId: string, onFrame: (frame: unknown) => void) {
            const scene = scenes[`${userId}:${trackId}`];
            if (!scene) return { route: Promise.resolve('no-track'), release: () => {} };
            const stop = source(scene).subscribe((bitmap: unknown) => onFrame(bitmap), 1);
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
