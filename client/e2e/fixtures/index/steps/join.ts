import { CH, CLOCK, GUILD } from '../scene';
import { defineStep } from '../step';

/**
 * s1 → s2, "Join General". You join Fuel's General room: your row appears in it,
 * the call phase is connected (the card becomes "yours"). Done in the page's
 * stores (`call.ts`), exactly what clicking Join does against the fake voice
 * backend, so the step works before any card exists to click.
 */
export const join = defineStep('join', async ({ world, setClock, hold }) => {
  await setClock(CLOCK.join);
  world.myCall = { room: 'fuelRoomGeneral', mode: 'joined', joined_at: world.nowIso };
  await hold({ channelId: CH.fuelRoomGeneral, guildId: GUILD.fuel.id, mode: 'joined' });
});
