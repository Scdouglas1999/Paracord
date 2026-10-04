import { frames } from '../gateway';
import { at, CLOCK } from '../scene';
import { defineStep } from '../step';

/**
 * s0 → s1, "Someone arrives". Jeremy joins Fuel, posts twice in general, posts
 * a clip in clips (an unread dot appears on it), then hops into the General
 * room and talks: the live room card appears. Fuel is now 2 members, 2 here.
 *
 * The clock runs through the story: 9:41 PM for the messages (the sidebar's
 * "9:41 PM"), 9:42 PM for the clip, 9:44 PM for the room, so General reads
 * "just now" and, at CLOCK.busy, "live 18 min".
 */
export const arrive = defineStep('arrive', async ({ world, setClock, emit }) => {
  await setClock(at('21:40:50'));
  world.addMember('fuel', 'jeremy');
  await emit(frames.memberAdd(world, 'fuel', 'jeremy'), frames.presence('jeremy'));

  await setClock(at('21:41:30'));
  const hello = world.post('fuelGeneral', 'jeremy', 'hey! finally made it in', { at: at('21:41:00') });
  const run = world.post('fuelGeneral', 'jeremy', 'who’s up for a run tonight? I’m in General', { at: at('21:41:20') });
  await emit(frames.messageCreate(world, hello), frames.messageCreate(world, run));

  await setClock(at('21:42:10'));
  const clip = world.post('fuelClips', 'jeremy', '', { at: at('21:42:00'), attachments: ['clip'] });
  await emit(frames.messageCreate(world, clip));

  await setClock(CLOCK.arrive);
  world.joinVoice('jeremy', 'fuelRoomGeneral', { joined_at: at('21:44:10'), speaking: true });
  await emit(
    frames.voiceState(world, 'jeremy', 'fuelRoomGeneral'),
    frames.speaking(world, 'jeremy', 'fuelRoomGeneral', true),
  );
});
