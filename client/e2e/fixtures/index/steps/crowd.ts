import { frames } from '../gateway';
import { at, CLOCK } from '../scene';
import { defineStep } from '../step';

/**
 * Part of s4 → s5, "Back to a busy Fuel". Vincent, Brendan and Maya join Fuel
 * and come into General (five in the call, Vincent talking instead of Jeremy),
 * and Nick comes online in the server: 6 members, 6 here now.
 */
export const crowd = defineStep('crowd', async ({ world, setClock, emit }) => {
  await setClock(at('21:57:50'));
  for (const who of ['vincent', 'brendan', 'maya', 'nick'] as const) {
    world.addMember('fuel', who);
    await emit(frames.memberAdd(world, 'fuel', who), frames.presence(who));
  }

  const arrivals = [
    ['vincent', '21:58:00'],
    ['brendan', '21:58:10'],
    ['maya', '21:58:20'],
  ] as const;
  for (const [who, time] of arrivals) {
    await setClock(at(time));
    world.joinVoice(who, 'fuelRoomGeneral', { joined_at: at(time) });
    await emit(frames.voiceState(world, who, 'fuelRoomGeneral'));
  }

  await setClock(CLOCK.crowd);
  world.setSpeaking('jeremy', false);
  world.setSpeaking('vincent', true);
  await emit(
    frames.speaking(world, 'jeremy', 'fuelRoomGeneral', false),
    frames.speaking(world, 'vincent', 'fuelRoomGeneral', true),
  );
});
