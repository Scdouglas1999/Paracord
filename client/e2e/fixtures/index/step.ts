/**
 * A scenario step: something that happens to the mocked world while the page is
 * open (someone arrives, joins, the channel gets busy). A step changes the
 * world (`ctx.world`), moves the clock (`ctx.setClock`) and announces the
 * change the way a server does (`ctx.emit`), so the page's own gateway code
 * does the rest and a reload lands in the same world.
 *
 * Later packages add steps in new files under `fixtures/index/steps/` and pass
 * the step object itself to `harness.step(step)`; nothing needs registering.
 *
 *   // steps/lateNight.ts
 *   export const lateNight = defineStep('lateNight', async (ctx) => {
 *     ctx.world.joinVoice('nick', 'fuelRoomLateNight');
 *     await ctx.emit(frames.voiceState(ctx.world, 'nick', 'fuelRoomLateNight'));
 *   });
 */
import type { Page } from '@playwright/test';
import type { HoldCallOptions } from './call';
import type { GatewayFrame } from './gateway';
import type { IndexHarness } from './harness';
import type { IndexWorld } from './world';

export interface StepContext<Args = void> {
  harness: IndexHarness;
  world: IndexWorld;
  page: Page;
  args: Args;
  /** Move the scene clock (an RFC 3339 time, e.g. `CLOCK.join` or `at('21:41')`). The page's Date follows. */
  setClock(iso: string): Promise<void>;
  /** Make the world's current state what READY carries, then write frames, in order, to the page's gateway stream. */
  emit(...frames: Array<GatewayFrame | GatewayFrame[]>): Promise<void>;
  /** Wait a beat (real time), for a step that wants its events spread out the way a server spreads them. */
  pause(ms: number): Promise<void>;
  /** Put this client in a call, without a click. */
  hold(options: HoldCallOptions): Promise<void>;
}

export interface Step<Args = void> {
  readonly name: string;
  run(ctx: StepContext<Args>): Promise<void>;
}

export function defineStep<Args = void>(name: string, run: (ctx: StepContext<Args>) => Promise<void>): Step<Args> {
  return { name, run };
}
