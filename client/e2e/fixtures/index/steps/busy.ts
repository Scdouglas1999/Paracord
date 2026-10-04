import { frames } from '../gateway';
import { at, CLOCK, type ChannelKey, type PersonKey } from '../scene';
import { defineStep } from '../step';

interface Line {
  channel: ChannelKey;
  who: PersonKey;
  time: string;
  text: string;
  event?: 'movieNight';
}

/** The channel moves: what the prototype's last step says, with times that run in order. */
const LINES: Line[] = [
  { channel: 'fuelGeneral', who: 'vincent', time: '21:58:40', text: 'already in, come heckle' },
  { channel: 'fuelGeneral', who: 'brendan', time: '21:59:10', text: 'need two more for a haz 5 run' },
  { channel: 'fuelGeneral', who: 'brendan', time: '21:59:20', text: 'Nick you in?' },
  { channel: 'fuelGeneral', who: 'nick', time: '21:59:50', text: 'new personal best btw. 41 minutes, nobody went down' },
  { channel: 'fuelGeneral', who: 'you', time: '22:00:20', text: 'that’s actually insane' },
  { channel: 'fuelGeneral', who: 'maya', time: '22:00:50', text: 'clip it next time' },
  { channel: 'fuelGeneral', who: 'jeremy', time: '22:01:20', text: 'movie night still on friday?' },
  // The plans channel: an event post. Its preview reads "Movie night · Fri 9 PM".
  { channel: 'fuelPlans', who: 'jeremy', time: '22:01:30', text: '', event: 'movieNight' },
  { channel: 'fuelGeneral', who: 'nick', time: '22:02:00', text: 'yep, bringing the projector' },
];

/**
 * Part of s4 → s5. The messages that make Fuel's general busy, one at a time
 * (`args.pace` ms apart in real time, 150 by default, like the prototype; 0 for
 * a screenshot that should not wait). Run `crowd` first. Ends at CLOCK.busy.
 *
 * Jeremy's post in plans shares Movie night, an event that does not exist
 * before this step: it is created (GUILD_SCHEDULED_EVENT_CREATE) just ahead of
 * the post, so "Coming up" appears in Fuel's sidebar here and not before. (The
 * prototype has no Coming up row; index-spec §4.7 requires one for an event
 * inside seven days.)
 */
export const busy = defineStep<{ pace?: number } | void>('busy', async ({ world, setClock, emit, pause, args }) => {
  const pace = (args && args.pace) ?? 150;
  for (const line of LINES) {
    await setClock(at(line.time));
    if (line.event) {
      // The event exists before the post that shares it, as it does when someone plans one.
      world.addEvent(line.event);
      await emit(frames.eventCreate(world, line.event));
    }
    const message = world.post(line.channel, line.who, line.text, { at: at(line.time), event: line.event });
    await emit(frames.messageCreate(world, message));
    if (pace > 0) await pause(pace);
  }
  await setClock(CLOCK.busy);
});
