// The story the reference renders are cut from, as real events on a real
// instance: Fuel is new and quiet while Game Night's Lounge is live; Jeremy
// arrives; you join; (you look at Game Night); it gets busy.
//
// Positions, in order: quiet -> arrived -> joined -> busy. A step moves the
// scene one position on; `reset` moves it back to quiet. A shot states the
// position it needs (shots.mjs) and `ensure` gets there, stepping forward, or
// resetting first when the scene is already past it.

import { LOUNGE, ARRIVE_MESSAGES, BUSY_MESSAGES } from './scene.mjs';
import { fuelIsQuiet, movieNightStart, publish, resetFuel } from './seed.mjs';
import { makeClip, uploadAttachment } from './assets.mjs';

export const POSITIONS = ['quiet', 'arrived', 'joined', 'busy'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Story {
  constructor({ api, people, ids, cast, viewer, lounge = true, log = () => {} }) {
    this.lounge = lounge;
    this.api = api;
    this.people = people;
    this.ids = ids;
    this.cast = cast;
    this.viewer = viewer;
    this.log = log;
    this.position = 'quiet';
    this.clip = null;
    /** Serializes steps and shots: one thing at a time touches the scene. */
    this.queue = Promise.resolve();
  }

  /** Run `fn` after everything queued before it; returns its result. */
  run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  get fuel() { return this.ids.servers.fuel; }
  indexOf(position) { return POSITIONS.indexOf(position); }

  // ---------------------------------------------------------------- start

  /**
   * Bring the scene to the quiet start: Fuel as new, Game Night's Lounge held
   * by real browsers (Vincent sharing and talking, Brendan, Nick muted), the
   * viewer signed in and looking at Fuel's general.
   */
  async start() {
    if (!(await fuelIsQuiet(this.api, this.people, this.ids))) {
      this.log('\nFuel is not as the quiet start wants it; putting it back');
      await resetFuel(this.api, this.people, this.ids, { log: this.log });
    }
    if (this.lounge) await this.bringUpLounge();
    else this.log('\nLounge: not brought up (--no-lounge); steps that need a call will fail');
    await this.viewer.open();
    await this.viewer.go('fuel', 'general');
    this.position = 'quiet';
  }

  async bringUpLounge() {
    this.log('\nLounge (Game Night)');
    for (const spec of LOUNGE.members) {
      await this.cast.start(spec.who, spec);
      await this.cast.join(spec.who, LOUNGE.server, LOUNGE.room);
      if (spec.share) await this.cast.share(spec.who);
    }
    const room = await this.cast.untilPublishing(LOUNGE.server, LOUNGE.room, LOUNGE.members.map(m => m.who));
    this.log(`  relay: ${room.connected_participants} connected over ${[...new Set(room.participants.map(p => p.transport))].join('/')}`);
  }

  // ---------------------------------------------------------------- steps

  async step(name) {
    switch (name) {
      case 'arrive': return this.arrive();
      case 'join': return this.join();
      case 'busy': return this.busy();
      case 'reset': return this.reset();
      default: throw new Error(`no step named "${name}" (arrive, join, busy, reset)`);
    }
  }

  expect(position, step) {
    if (this.position !== position) {
      throw new Error(`"${step}" runs from "${position}" but the scene is at "${this.position}"; run --step reset first (or ask for a state with --shot, which gets there itself)`);
    }
  }

  /** Jeremy joins Fuel, says hello, posts a clip, and joins General, talking. */
  async arrive() {
    this.expect('quiet', 'arrive');
    const { api, people, fuel, cast } = this;
    this.log('\narrive: Jeremy joins Fuel');
    await this.viewer.go('fuel', 'general', { settleMs: 300 });
    await api.request(people.jeremy.token, 'POST', `/invites/${fuel.invite}`, {});
    // Planning Movie night (the busy step) needs Manage Server.
    await api.request(people.sean.token, 'PATCH', `/guilds/${fuel.id}/members/${people.jeremy.id}`, { roles: [fuel.id, fuel.roles.Hosts] });
    await cast.start('jeremy', { voice: 'talking' });

    for (const message of ARRIVE_MESSAGES) {
      await publish(api, people, fuel.channels.general, message);
      await sleep(450);
    }
    this.clip ??= await makeClip();
    const attachment = await uploadAttachment(api, people.jeremy.token, fuel.channels.clips, 'clip.webm', this.clip, 'video/webm');
    await api.request(people.jeremy.token, 'POST', `/channels/${fuel.channels.clips}/messages`, { content: '', attachment_ids: [attachment] });
    this.log('  Jeremy said hello in general and posted a clip in clips');

    await cast.join('jeremy', 'fuel', 'generalRoom');
    await cast.untilPublishing('fuel', 'generalRoom', ['jeremy']);
    this.position = 'arrived';
    return 'Jeremy is in Fuel › General, talking';
  }

  /** The viewer joins General from the room card. */
  async join() {
    this.expect('arrived', 'join');
    this.log('\njoin: the viewer joins General');
    await this.viewer.go('fuel', 'general', { settleMs: 300 });
    await this.viewer.join('fuel', 'generalRoom');
    this.position = 'joined';
    return 'you are in Fuel › General with Jeremy';
  }

  /** Vincent and Brendan move over from Lounge, Maya comes online and joins; the channel moves. */
  async busy() {
    this.expect('joined', 'busy');
    const { api, people, fuel, cast } = this;
    this.log('\nbusy: Vincent, Brendan and Maya join General; the channel fills up');
    for (const key of ['vincent', 'brendan', 'maya', 'nick']) {
      await api.request(people[key].token, 'POST', `/invites/${fuel.invite}`, {}).catch(error => {
        if (error.status !== 409 && error.status !== 400) throw error; // already a member
      });
    }
    // Vincent talks: a person cannot be in two rooms, so he and Brendan leave
    // Lounge for General; Nick stays, muted, with nobody to talk to.
    await cast.move('vincent', 'fuel', 'generalRoom');
    await cast.move('brendan', 'fuel', 'generalRoom');
    await cast.start('maya', { voice: 'quiet' });
    await cast.join('maya', 'fuel', 'generalRoom');
    // Jeremy stops talking, so Vincent is the one the card shows talking.
    await cast.setMic('jeremy', false);
    await cast.untilPublishing('fuel', 'generalRoom', ['jeremy', 'vincent', 'brendan', 'maya']);

    await this.viewer.go('fuel', 'general', { settleMs: 300 });
    for (const message of BUSY_MESSAGES) {
      await publish(api, people, fuel.channels.general, message);
      await sleep(450);
    }
    await this.planMovieNight();
    this.position = 'busy';
    return 'five in Fuel › General (Jeremy, you, Vincent, Brendan, Maya), the channel moving, plans unread';
  }

  /** Jeremy plans Movie night for Friday and shares it in plans. */
  async planMovieNight() {
    const { api, people, fuel } = this;
    const start = movieNightStart();
    const event = await api.request(people.jeremy.token, 'POST', `/guilds/${fuel.id}/events`, {
      name: 'Movie night',
      description: 'Projector in the big room.',
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 2.5 * 3600e3).toISOString(),
      entity_type: 1,
      channel_id: fuel.channels.generalRoom,
    });
    await api.request(people.jeremy.token, 'POST', `/channels/${fuel.channels.plans}/messages`, { content: `<event:${event.id}>` });
    this.log(`  Jeremy planned Movie night (${start.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}) in plans`);
  }

  /** Back to the quiet start. */
  async reset() {
    const { cast, api, people } = this;
    this.log('\nreset: back to the quiet start');
    if (await this.viewer.joined()) await this.viewer.leave();
    // Everyone who was in Fuel's General: Vincent and Brendan go back to Lounge,
    // Jeremy and Maya go offline.
    for (const key of ['jeremy', 'maya']) if (cast.has(key)) await cast.stop(key);
    const inLounge = await cast.occupants(LOUNGE.server, LOUNGE.room);
    for (const spec of LOUNGE.members) {
      if (!cast.has(spec.who)) continue;
      const member = cast.get(spec.who);
      if (member.room?.server === LOUNGE.server && inLounge.has(member.person.id)) continue;
      await cast.move(spec.who, LOUNGE.server, LOUNGE.room);
      if (spec.share) await cast.share(spec.who);
    }
    await cast.untilPublishing(LOUNGE.server, LOUNGE.room, LOUNGE.members.map(m => m.who));
    await resetFuel(api, people, this.ids, { log: this.log });
    await this.viewer.go('fuel', 'general', { settleMs: 300 });
    this.position = 'quiet';
    return 'Fuel is new again; Lounge is held by Vincent (sharing), Brendan and Nick';
  }

  /** Get to a position, stepping forward, or resetting first when past it. */
  async ensure(position) {
    const want = this.indexOf(position);
    if (want < 0) throw new Error(`no position "${position}"`);
    if (this.indexOf(this.position) > want) await this.reset();
    while (this.indexOf(this.position) < want) {
      await this.step({ quiet: 'arrive', arrived: 'join', joined: 'busy' }[this.position]);
    }
  }

  async status() {
    const rooms = await this.cast.statusLine();
    return `scene at "${this.position}" · ${rooms} · you ${await this.viewer.joined() ? 'are in a call' : 'are not in a call'}`;
  }
}
