import { frames } from '../gateway';
import type { ChannelKey, PersonKey } from '../scene';
import { defineStep } from '../step';

/**
 * Small events for the motion gate (IX-18, `e2e/motion-gate.spec.ts`): one
 * thing happening at a time, so each §5 moment can be caught on its own.
 *
 *   h.step(voiceJoin, { who: 'nick', room: 'bcRoomWorkshop' })   // a room goes live elsewhere: the ping
 *   h.step(voiceLeave, { who: 'nick', room: 'bcRoomWorkshop' })  // ... and empties
 *   h.step(speak, { who: 'jeremy', room: 'fuelRoomGeneral', speaking: false })
 *   h.step(share, { who: 'jeremy', room: 'fuelRoomGeneral' })     // starts sharing their screen
 */

export const voiceJoin = defineStep<{ who: PersonKey; room: ChannelKey; speaking?: boolean }>('voiceJoin', async ({ world, emit, args }) => {
  world.joinVoice(args.who, args.room, { speaking: args.speaking ?? false });
  await emit(frames.voiceState(world, args.who, args.room));
});

export const voiceLeave = defineStep<{ who: PersonKey; room: ChannelKey }>('voiceLeave', async ({ world, emit, args }) => {
  world.leaveVoice(args.who);
  await emit(frames.voiceState(world, args.who, null, args.room));
});

export const speak = defineStep<{ who: PersonKey; room: ChannelKey; speaking: boolean }>('speak', async ({ world, emit, args }) => {
  world.setSpeaking(args.who, args.speaking);
  await emit(frames.speaking(world, args.who, args.room, args.speaking));
});

export const share = defineStep<{ who: PersonKey; room: ChannelKey }>('share', async ({ world, emit, args }) => {
  const row = world.voice.find((entry) => entry.who === args.who);
  world.joinVoice(args.who, args.room, {
    joined_at: row?.joined_at,
    speaking: row?.speaking ?? false,
    self_stream: true,
  });
  await emit(frames.voiceState(world, args.who, args.room));
});
