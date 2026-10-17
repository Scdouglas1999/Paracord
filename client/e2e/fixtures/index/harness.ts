/**
 * `installIndexScene(page)`: the Index reference scene behind a Playwright
 * page, with no server and no media stack.
 *
 *   - every REST call is answered from the world (`routes.ts`);
 *   - the gateway is the realtime stub's real SSE stream (`gateway.ts`), so the
 *     page runs its real gateway and message pipeline;
 *   - the page's clock is pinned (`scene.ts` `CLOCK`) and its timezone is the
 *     scene's (set it in the config's `use`, `index-review.config.ts` does);
 *   - `harness.step('arrive')` etc. change the world and announce it.
 *
 *   const h = await installIndexScene(page);
 *   await h.open(h.routes.channel('fuelGeneral'));      // s0, quiet
 *   await h.step('arrive');                              // s1
 *   await h.step('join');                                // s2
 *
 * Call `installIndexScene` before the first `page.goto`. Routes are last-wins,
 * so a spec may add its own `page.route` after it.
 */
import { expect, type Page } from '@playwright/test';
import { installFakeVoice, holdCall, type FakeVoiceOptions } from './call';
import { drainMarker, heartbeatAck, RealtimeStub, type GatewayFrame } from './gateway';
import { installRoutes, type RouteOptions } from './routes';
import { CH, CLOCK, GUILDS, ME, PEOPLE, SCENE_TIMEZONE, type ChannelKey, type GuildKey } from './scene';
import { BUILT_IN_STEPS } from './steps';
import type { Step, StepContext } from './step';
import { IndexWorld } from './world';

export { SCENE_TIMEZONE };

interface IxProbe {
  presence: { getState(): { getPresence(id: string): unknown } };
  guilds: { getState(): { guilds: unknown[] } };
}
declare global {
  interface Window {
    /** The page's own stores, for the harness's synchronous waits. */
    __ixProbe?: IxProbe;
    /** Calls every `setInterval(fn, 60_000)` callback the page has registered. */
    __ixTick?: () => void;
  }
}

/** Ports of the review harness (docs/design/index-plan.md §5.2). Each package passes its own. */
export const DEFAULT_APP_PORT = 4513;
export const DEFAULT_RT_PORT = 4515;

export function indexPorts(): { app: number; rt: number } {
  return {
    app: Number(process.env.PARACORD_E2E_INDEX_PORT ?? DEFAULT_APP_PORT),
    rt: Number(process.env.PARACORD_E2E_INDEX_RT_PORT ?? DEFAULT_RT_PORT),
  };
}

export interface IndexSceneOptions {
  /** The realtime stub's port. Default `PARACORD_E2E_INDEX_RT_PORT` or 4515. */
  rtPort?: number;
  /** Where the scene's clock starts. Default `CLOCK.start` (Thursday 9:38 PM). */
  clock?: string;
  /** Replace the voice store's actions with state-only fakes after every `open` (`call.ts`). Default true. */
  fakeVoice?: boolean;
  /** Passed to `installFakeVoice`: paint video with the DEV fixture. Default true. */
  video?: boolean;
  /** Log every REST call no route answered (they get `[]` or 204). */
  onUnhandled?: RouteOptions['onUnhandled'];
}

/** The app's URLs for the scene's channels. */
export const routes = {
  channel: (key: ChannelKey): string => {
    const seed = CH[key];
    const guild = GUILDS.find((g) => g.key === guildKeyOf(key));
    if (!guild) throw new Error(`${key} is a direct message: use routes.dm`);
    return `/app/guilds/${guild.id}/channels/${seed}`;
  },
  dm: (key: ChannelKey): string => `/app/dms/${CH[key]}`,
  /** The place's first screen: a server's first channel, or People's first conversation. */
  place: (place: GuildKey | 'people'): string => (place === 'people' ? routes.dm('dmJeremy') : routes.channel(FIRST_CHANNEL[place])),
};

const FIRST_CHANNEL: Record<GuildKey, ChannelKey> = { fuel: 'fuelGeneral', gameNight: 'gnLounge', basecamp: 'bcGeneral' };

function guildKeyOf(key: ChannelKey): GuildKey | null {
  if (key.startsWith('fuel')) return 'fuel';
  if (key.startsWith('gn')) return 'gameNight';
  if (key.startsWith('bc')) return 'basecamp';
  return null;
}

export class IndexHarness {
  readonly routes = routes;
  readonly stub: RealtimeStub;
  private readonly fakeVoiceOptions: FakeVoiceOptions;
  /** True once the page's gateway stream has been seen open (frames can reach it). */
  private live = false;
  private drains = 0;

  constructor(
    readonly page: Page,
    readonly world: IndexWorld,
    private readonly options: Required<Pick<IndexSceneOptions, 'fakeVoice'>> & IndexSceneOptions,
  ) {
    this.stub = new RealtimeStub(options.rtPort ?? indexPorts().rt);
    this.fakeVoiceOptions = { video: options.video };
  }

  /** Make the world's current state what every READY (and so every reload) carries. */
  async syncWorld(): Promise<void> {
    await this.stub.setStanding(this.world.readyWorld());
  }

  /**
   * Move the scene clock. The page's Date follows; timers keep running. A page
   * that is connected gets a heartbeat right after, because its liveness
   * watchdog reads the same clock and would take a jump for a dead stream.
   */
  async setClock(iso: string | number): Promise<void> {
    this.world.nowMs = typeof iso === 'number' ? iso : Date.parse(iso);
    await this.page.clock.setFixedTime(this.world.nowMs);
    if (this.live) {
      await this.stub.emit(heartbeatAck());
      await this.tick();
    }
  }

  /**
   * Fire the page's minute tick now. Labels that read the clock ("live 34 min",
   * "9:41 PM") refresh on a 60-second interval, and the scene clock jumps
   * minutes at a time; the harness wraps every `setInterval(fn, 60_000)` the
   * page makes so a jump does not wait a real minute to show. `setClock` calls
   * this for you.
   */
  async tick(): Promise<void> {
    await this.page.evaluate(() => window.__ixTick?.());
  }

  /**
   * Sync READY, write frames, in order, to the page's gateway stream, and wait
   * until the page has processed every one of them (the stream is a queue: a
   * marker sent last is seen last).
   */
  async emit(...batch: Array<GatewayFrame | GatewayFrame[]>): Promise<void> {
    await this.syncWorld();
    const flat = batch.flat();
    if (flat.length === 0) return;
    // A page that is still connecting (a slow machine) would miss these frames:
    // give it a moment to open its stream. Scenes that are offline on purpose
    // still emit into nothing after that, as before.
    const deadline = Date.now() + 5_000;
    while ((await this.stub.streamCount()) === 0 && Date.now() < deadline) {
      await this.page.waitForTimeout(100);
    }
    const marker = drainMarker((this.drains += 1));
    const streams = await this.stub.emit([...flat, marker]);
    if (streams === 0) return;
    const id = (marker.d as { user_id: string }).user_id;
    // A synchronous predicate: `waitForFunction` does not poll an async one.
    await this.page.waitForFunction((userId) => Boolean(window.__ixProbe?.presence.getState().getPresence(userId)), id);
  }

  /** A beat of real time for the page to take what was just delivered. */
  async flush(ms = 120): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /**
   * Run a scenario step: a built-in by name (`'arrive'`, `'join'`, `'crowd'`,
   * `'busy'`, `'message'`, `'typing'`) or a step object from a package's own
   * file. Resolves once the page has processed every frame the step sent (React
   * may still be rendering the last one: assert on what you expect to see).
   */
  async step(name: string, args?: unknown): Promise<void>;
  async step<Args>(step: Step<Args>, args?: Args): Promise<void>;
  async step(stepOrName: string | Step<never>, args?: unknown): Promise<void> {
    const step = typeof stepOrName === 'string' ? BUILT_IN_STEPS[stepOrName] : stepOrName;
    if (!step) throw new Error(`No step named "${String(stepOrName)}". Built in: ${Object.keys(BUILT_IN_STEPS).join(', ')}`);
    const ctx: StepContext<unknown> = {
      harness: this,
      world: this.world,
      page: this.page,
      args,
      setClock: (iso) => this.setClock(iso),
      emit: (...batch) => this.emit(...batch),
      pause: (ms) => this.page.waitForTimeout(ms),
      hold: async (options) => {
        await this.ensureFakeVoice();
        await holdCall(this.page, options);
      },
    };
    await (step as Step<unknown>).run(ctx);
    await this.syncWorld();
  }

  /** Make sure the voice store's actions are the state-only fakes (a reload resets them). */
  async ensureFakeVoice(): Promise<void> {
    const installed = await this.page.evaluate(() => Boolean(window.__ixVoice));
    if (installed) return;
    await installFakeVoice(
      this.page,
      {
        you: ME.id,
        // Brendan is on camera and Vincent shares a screen wherever the fixture is asked to paint them.
        cameras: [PEOPLE.brendan.id],
        streams: [PEOPLE.vincent.id],
      },
      this.fakeVoiceOptions,
    );
  }

  /**
   * Load a route and wait until the scene is up: the app has rendered, the
   * page's gateway stream is open, and READY has put the three servers in the
   * store. Then the fake voice backend goes in (unless turned off).
   */
  async open(route: string): Promise<void> {
    this.live = false;
    await this.syncWorld();
    await this.page.goto(route);
    await expect(this.page.getByRole('main')).toBeVisible();
    await this.waitForGateway();
    if (this.options.fakeVoice) await this.ensureFakeVoice();
  }

  /** Reload the current route into the current world (the call, if any, is gone, as after a real reload). */
  async reload(): Promise<void> {
    this.live = false;
    await this.syncWorld();
    await this.page.reload();
    await expect(this.page.getByRole('main')).toBeVisible();
    await this.waitForGateway();
    if (this.options.fakeVoice) await this.ensureFakeVoice();
  }

  /** Wait for the page's gateway stream to open and READY to land. */
  async waitForGateway(): Promise<void> {
    await expect.poll(() => this.stub.openStreams(), { message: 'the page never opened its gateway stream (is the realtime stub up?)' }).toBeGreaterThan(0);
    this.live = true;
    await this.installProbes();
    await this.page.waitForFunction((expected) => (window.__ixProbe?.guilds.getState().guilds.length ?? 0) >= expected, GUILDS.length);
  }

  /** Hand the page's stores to synchronous predicates (`waitForFunction` cannot await an import). */
  private async installProbes(): Promise<void> {
    await this.page.evaluate(async () => {
      if (window.__ixProbe) return;
      const presence = (await import('/src/stores/presenceStore.ts' as string)) as { usePresenceStore: IxProbe['presence'] };
      const guilds = (await import('/src/stores/guildStore.ts' as string)) as { useGuildStore: IxProbe['guilds'] };
      window.__ixProbe = { presence: presence.usePresenceStore, guilds: guilds.useGuildStore };
    });
  }
}

/** Install the scene. Call before the first `page.goto`. */
export async function installIndexScene(page: Page, options: IndexSceneOptions = {}): Promise<IndexHarness> {
  const world = new IndexWorld();
  const harness = new IndexHarness(page, world, { fakeVoice: true, ...options });

  await harness.setClock(options.clock ?? CLOCK.start);
  await harness.syncWorld();

  const guildIds = GUILDS.map((g) => g.id);
  await page.addInitScript((ids) => {
    try {
      window.localStorage.setItem('paracord:auth:session-seen', '1');
      window.localStorage.setItem('paracord:v2:layout-tour-shell', 'done');
      window.localStorage.setItem('paracord:v2:layout-tour-guild-home', 'done');
      window.localStorage.setItem('paracord:v2:onboarding-complete', '1');
      // The legacy per-server welcome screen is not part of this scene.
      for (const id of ids) window.localStorage.setItem(`paracord:v2:guild-welcomed:${id}`, '1');
    } catch {
      /* storage unavailable: the tour simply shows */
    }
  }, guildIds);

  // The minute tick: remember the callback of every 60-second interval so a clock jump can fire them.
  await page.addInitScript(() => {
    const ticks = new Map<number, () => void>();
    const nativeSet = window.setInterval.bind(window);
    const nativeClear = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id = nativeSet(handler, ms, ...args);
      if (ms === 60_000 && typeof handler === 'function') ticks.set(id, () => (handler as (...a: unknown[]) => void)(...args));
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) ticks.delete(id);
      nativeClear(id);
    }) as typeof window.clearInterval;
    window.__ixTick = () => {
      for (const tick of [...ticks.values()]) tick();
    };
  });

  await installRoutes(page, world, { stub: harness.stub, onUnhandled: options.onUnhandled });
  return harness;
}

