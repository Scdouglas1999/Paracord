import { frames } from '../gateway';
import { type AttachmentKey, type ChannelKey, type PersonKey } from '../scene';
import { defineStep } from '../step';

/** One message from someone, now (the scene clock): `harness.step('message', { channel, who, text })`. */
export const message = defineStep<{
  channel: ChannelKey;
  who: PersonKey;
  text: string;
  attachments?: AttachmentKey[];
}>('message', async ({ world, emit, args }) => {
  const posted = world.post(args.channel, args.who, args.text, { attachments: args.attachments });
  await emit(frames.messageCreate(world, posted));
});
