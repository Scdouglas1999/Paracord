import { frames } from '../gateway';
import { type ChannelKey, type PersonKey } from '../scene';
import { defineStep } from '../step';

/** Someone starts typing in a channel: `harness.step('typing', { channel, who })`. The client shows it for a few seconds. */
export const typing = defineStep<{ channel: ChannelKey; who: PersonKey }>('typing', async ({ world, emit, args }) => {
  await emit(frames.typing(world, args.channel, args.who));
});
