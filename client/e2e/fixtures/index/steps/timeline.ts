import { frames } from '../gateway';
import { type AttachmentKey, type ChannelKey, type PersonKey } from '../scene';
import { defineStep } from '../step';
import type { Reaction } from '../world';

/**
 * IX-11's steps (the timeline, docs/index-spec.md §4.11). Not part of the
 * reference story: they give the timeline what the prototype never draws.
 *
 *   await h.step(say, { channel: 'fuelGeneral', who: 'nick', text: 'ok', reactions: [...] });
 *   await h.step(chatter, { channel: 'fuelGeneral', count: 40 });
 */

/** One message with the extras the plain `message` step has no room for: reactions, a reply, attachments. */
export const say = defineStep<{
  channel: ChannelKey;
  who: PersonKey;
  text: string;
  reactions?: Reaction[];
  replyTo?: string;
  attachments?: AttachmentKey[];
}>('say', async ({ world, emit, args }) => {
  const posted = world.post(args.channel, args.who, args.text, {
    reactions: args.reactions,
    reference_id: args.replyTo,
    attachments: args.attachments,
  });
  await emit(frames.messageCreate(world, posted));
});

const LINES = [
  'anyone still on?',
  'one more run then bed',
  'that boss took forever',
  'did you see the patch notes',
  'yeah the shotgun got nerfed',
  'rip',
  'queue is long tonight',
  'brb grabbing water',
  'back',
  'who has the spare key for friday',
];
const VOICES: PersonKey[] = ['jeremy', 'vincent', 'brendan', 'nick', 'maya'];

/**
 * A long stretch of conversation, a minute apart and ending at the scene clock:
 * enough history to scroll more than a screen up.
 */
export const chatter = defineStep<{ channel: ChannelKey; count?: number }>('chatter', async ({ world, emit, args }) => {
  const count = args.count ?? 40;
  const posted = [];
  for (let i = 0; i < count; i++) {
    const who = VOICES[Math.floor(i / 2) % VOICES.length];
    const at = new Date(world.nowMs - (count - i) * 60_000).toISOString();
    posted.push(world.post(args.channel, who, `${LINES[i % LINES.length]} (${i + 1})`, { at }));
  }
  await emit(...posted.map((message) => frames.messageCreate(world, message)));
});
