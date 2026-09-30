import { describe, expect, it } from 'vitest';

import { ChannelType, type VoiceState } from '../../../types';
import {
  DM_GUILD,
  collapseLevelFor,
  occupantOf,
  orderOccupants,
  pickPillTarget,
  pillLine,
  rankLiveChannels,
  rosterState,
  streamLabel,
  type PillChannel,
  type PillInput,
  type PillOccupant,
  type PillTarget,
} from './model';

const SCOPE = { serverId: 's1', userId: 'me' };

function state(userId: string, over: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId,
    session_id: `session-${userId}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    username: userId,
    display_name: userId[0].toUpperCase() + userId.slice(1),
    ...over,
  };
}

const chan = (id: string, name: string, guildId: string | null, over: Partial<PillChannel> = {}): PillChannel => ({
  id,
  name,
  guildId,
  type: ChannelType.Voice,
  position: 0,
  ...over,
});

const NO_SPEAKERS: PillInput['speakers'] = () => new Set();

function input(over: Partial<PillInput> = {}): PillInput {
  return {
    scope: SCOPE,
    routeGuildId: 'g1',
    held: null,
    channelParticipants: new Map(),
    channels: new Map(),
    heldChannel: null,
    guildNames: new Map([
      ['g1', 'Game Night'],
      ['g2', 'Basecamp'],
    ]),
    heldGuildName: null,
    speakers: NO_SPEAKERS,
    selfUserId: 'me',
    ...over,
  };
}

const lounge = chan('lounge', 'Lounge', 'g1');
const camp = chan('camp', 'Fire pit', 'g2');

describe('which channel the pill shows', () => {
  it('shows nothing when nothing is live and there is no call', () => {
    expect(pickPillTarget(input())).toBeNull();
  });

  it("shows this server's live voice channel, named plainly", () => {
    const target = pickPillTarget(
      input({
        channels: new Map([['lounge', lounge]]),
        channelParticipants: new Map([['lounge', [state('vincent'), state('brendan')]]]),
      }),
    );
    expect(target).toMatchObject({ channelId: 'lounge', title: 'Lounge', crossServer: false, relation: 'idle', guildId: 'g1' });
    expect(target?.occupants.map((person) => person.userId)).toEqual(['vincent', 'brendan']);
  });

  it('names a live channel in another server with its server (screens/02)', () => {
    const target = pickPillTarget(
      input({
        routeGuildId: 'g2',
        channels: new Map([['lounge', lounge]]),
        channelParticipants: new Map([['lounge', [state('vincent')]]]),
      }),
    );
    expect(target).toMatchObject({ title: 'Game Night Lounge', crossServer: true, channelName: 'Lounge' });
  });

  it('shows a live channel in a DM or another page, with its server', () => {
    const target = pickPillTarget(
      input({
        routeGuildId: null,
        channels: new Map([['lounge', lounge]]),
        channelParticipants: new Map([['lounge', [state('vincent')]]]),
      }),
    );
    expect(target?.title).toBe('Game Night Lounge');
  });

  it('prefers this server over a busier one elsewhere', () => {
    const target = pickPillTarget(
      input({
        channels: new Map([['lounge', lounge], ['camp', camp]]),
        channelParticipants: new Map([
          ['camp', [state('a'), state('b'), state('c')]],
          ['lounge', [state('vincent')]],
        ]),
      }),
    );
    expect(target?.channelId).toBe('lounge');
  });

  it('never counts people who only listen as making a channel live', () => {
    const target = pickPillTarget(
      input({
        channels: new Map([['lounge', lounge]]),
        channelParticipants: new Map([['lounge', [state('a', { mode: 'listen' })]]]),
      }),
    );
    expect(target).toBeNull();
  });

  it('skips a channel it cannot name, one that is not voice, and a server it does not know', () => {
    expect(
      pickPillTarget(input({ channelParticipants: new Map([['lounge', [state('a')]]]) })),
    ).toBeNull();
    expect(
      pickPillTarget(
        input({
          channels: new Map([['lounge', chan('lounge', 'Lounge', 'g1', { type: ChannelType.Text })]]),
          channelParticipants: new Map([['lounge', [state('a')]]]),
        }),
      ),
    ).toBeNull();
    expect(
      pickPillTarget(
        input({
          channels: new Map([['x', chan('x', 'Elsewhere', 'gX')]]),
          channelParticipants: new Map([['x', [state('a')]]]),
        }),
      ),
    ).toBeNull();
  });

  it("ranks a stream first, then the most people, then talking, then the server's order", () => {
    const channels = new Map([
      ['one', chan('one', 'One', 'g1', { position: 2 })],
      ['two', chan('two', 'Two', 'g1', { position: 1 })],
      ['three', chan('three', 'Three', 'g1', { position: 0 })],
      ['four', chan('four', 'Four', 'g1', { position: 3 })],
      ['five', chan('five', 'Five', 'g1', { position: 4 })],
    ]);
    const base = {
      channels,
      guildNames: new Map([['g1', 'Game Night']]),
      selfUserId: 'me',
      speakers: (_guild: string, channelId: string) => (channelId === 'two' ? new Set(['t1']) : new Set<string>()),
    };
    const ranked = rankLiveChannels(
      {
        ...base,
        channelParticipants: new Map([
          ['one', [state('o1'), state('o2')]],
          ['two', [state('t1'), state('t2')]],
          ['three', [state('h1')]],
          ['four', [state('f1', { self_stream: true })]],
          // Your own stream does not make a channel the one to watch.
          ['five', [state('me', { self_stream: true })]],
        ]),
      },
      'g1',
    );
    // `four` has somebody else's stream, so it leads the busier `one` and `two`.
    // `two` has somebody talking; `three` and `five` are one person each, and
    // `three` is listed first.
    expect(ranked.map((entry) => entry.channel.id)).toEqual(['four', 'two', 'one', 'three', 'five']);
  });

  it('counts a listener as a person in the channel, but never as making it live', () => {
    const channels = new Map([['a', chan('a', 'A', 'g1')], ['b', chan('b', 'B', 'g1', { position: 1 })]]);
    const ranked = rankLiveChannels(
      {
        channels,
        guildNames: new Map([['g1', 'Game Night']]),
        selfUserId: 'me',
        speakers: NO_SPEAKERS,
        channelParticipants: new Map([
          ['a', [state('a1')]],
          ['b', [state('b1'), state('b2', { mode: 'listen' }), state('b3', { mode: 'listen' })]],
        ]),
      },
      'g1',
    );
    expect(ranked.map((entry) => entry.channel.id)).toEqual(['b', 'a']);
  });

  it('shows the call you hold, whatever else is live, and names it when it is not the one you read', () => {
    const held = { scope: SCOPE, channelId: 'camp', guildId: 'g2', phase: 'connected' as const, mode: 'joined' as const };
    const base = input({
      channels: new Map([['lounge', lounge], ['camp', camp]]),
      channelParticipants: new Map([
        ['lounge', [state('vincent'), state('brendan')]],
        ['camp', [state('me')]],
      ]),
      held,
    });
    expect(pickPillTarget(base)).toMatchObject({ channelId: 'camp', title: 'Basecamp Fire pit', relation: 'joined', crossServer: true });
    expect(pickPillTarget({ ...base, routeGuildId: 'g2' })).toMatchObject({ title: 'Fire pit', crossServer: false });
  });

  it('reads a listen and a join in progress', () => {
    const held = { scope: SCOPE, channelId: 'lounge', guildId: 'g1', phase: 'connected' as const, mode: 'listen' as const };
    const base = input({ channels: new Map([['lounge', lounge]]), channelParticipants: new Map([['lounge', [state('vincent')]]]), held });
    expect(pickPillTarget(base)?.relation).toBe('listening');
    expect(pickPillTarget({ ...base, held: { ...held, phase: 'joining' } })).toMatchObject({ relation: 'joining', mode: 'listen' });
  });

  it('ignores a call that is closing, closed or failed', () => {
    for (const phase of ['closing', 'closed', 'failed', 'idle'] as const) {
      const held = { scope: SCOPE, channelId: 'lounge', guildId: 'g1', phase, mode: 'joined' as const };
      expect(pickPillTarget(input({ held }))).toBeNull();
    }
  });

  it("names a call in another account with that account's channel and server", () => {
    const other = { serverId: 's2', userId: 'me2' };
    const target = pickPillTarget(
      input({
        held: { scope: other, channelId: 'remote', guildId: 'rg', phase: 'connected', mode: 'joined' },
        heldChannel: chan('remote', 'Studio', 'rg'),
        heldGuildName: 'Other Place',
        channelParticipants: new Map([['remote', [state('a')]]]),
      }),
    );
    expect(target).toMatchObject({ serverId: 's2', title: 'Other Place Studio', crossServer: true });
  });

  it('carries a DM call by the person, with no server', () => {
    const target = pickPillTarget(
      input({
        routeGuildId: null,
        held: { scope: SCOPE, channelId: 'dm1', guildId: DM_GUILD, phase: 'connected', mode: 'joined' },
        channels: new Map([['dm1', chan('dm1', 'Mara', null, { type: ChannelType.DM })]]),
        channelParticipants: new Map([['dm1', [state('me'), state('mara', { username: undefined, display_name: undefined })]]]),
        people: new Map([['mara', { name: 'Mara', avatar: 'hash-mara' }]]),
      }),
    );
    expect(target).toMatchObject({ isDm: true, title: 'Mara', crossServer: false });
    expect(target?.occupants.map((person) => person.name)).toEqual(['You', 'Mara']);
    expect(target?.occupants[1].avatar).toBe('hash-mara');
  });

  it('finds the guild of a call that was started without one', () => {
    const target = pickPillTarget(
      input({
        held: { scope: SCOPE, channelId: 'lounge', guildId: null, phase: 'connected', mode: 'joined' },
        channels: new Map([['lounge', lounge]]),
      }),
    );
    expect(target).toMatchObject({ guildId: 'g1', title: 'Lounge' });
  });
});

describe('who is in the channel', () => {
  const ctx = { selfUserId: 'me', people: undefined };

  it('marks talking, sharing, muted and listening; you are "You"', () => {
    const talking = occupantOf(state('brendan'), ctx, true);
    expect(talking).toMatchObject({ name: 'Brendan', talking: true, sharing: false, muted: false });
    expect(occupantOf(state('vincent', { self_stream: true }), ctx, false).sharing).toBe(true);
    expect(occupantOf(state('nick', { self_mute: true }), ctx, true)).toMatchObject({ muted: true, talking: false });
    expect(occupantOf(state('me', { mode: 'listen' }), ctx, true)).toMatchObject({ name: 'You', listening: true, talking: false, self: true });
    // A listener sends nothing, so it is never sharing.
    expect(occupantOf(state('x', { mode: 'listen', self_stream: true }), ctx, false).sharing).toBe(false);
  });

  it("prefers the roster's name for a person (a voice state carries a username)", () => {
    const people = new Map([['brendan', { name: 'Brendan', avatar: 'hash-b' }]]);
    const person = occupantOf(state('brendan', { username: 'brendan', display_name: undefined, avatar_hash: null }), { selfUserId: 'me', people }, false);
    expect(person).toMatchObject({ name: 'Brendan', avatar: 'hash-b' });
    // Nobody in the roster: the voice state's own name.
    expect(occupantOf(state('luke', { display_name: null, username: 'luke' }), { selfUserId: 'me', people }, false).name).toBe('luke');
  });

  it('puts people who joined first and listeners after, each in the order given', () => {
    const list = ['a', 'b', 'c', 'd'].map((id, index) => occupantOf(state(id, index % 2 ? { mode: 'listen' } : {}), ctx, false));
    expect(orderOccupants(list).map((person) => person.userId)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('picks the stream that began first, the way the room light does', () => {
    const target = pickPillTarget(
      input({
        channels: new Map([['lounge', lounge]]),
        channelParticipants: new Map([
          [
            'lounge',
            [
              state('late', { self_stream: true, self_stream_started_at: '2026-10-01T21:00:00Z' }),
              state('early', { self_stream: true, self_stream_started_at: '2026-10-01T20:00:00Z' }),
              state('unstamped', { self_stream: true }),
            ],
          ],
        ]),
      }),
    ) as PillTarget;
    expect(target.streamer?.userId).toBe('early');
  });

  it('draws the faces of people who joined, and the streamer is somebody else', () => {
    const target = pickPillTarget(
      input({
        channels: new Map([['lounge', lounge]]),
        channelParticipants: new Map([
          ['lounge', [state('me', { self_stream: true }), state('vincent', { self_stream: true }), state('nick', { mode: 'listen' })]],
        ]),
      }),
    ) as PillTarget;
    expect(target.faces.map((person) => person.userId)).toEqual(['me', 'vincent']);
    expect(target.streamer?.userId).toBe('vincent');
  });

  it('says what each person is doing (§5)', () => {
    const person = (over: Partial<PillOccupant>): PillOccupant => ({
      userId: 'u',
      name: 'U',
      avatar: null,
      self: false,
      listening: false,
      muted: false,
      sharing: false,
      streamStartedAt: null,
      talking: false,
      ...over,
    });
    expect(rosterState(person({ sharing: true }))).toEqual({ text: 'Sharing screen', tone: 'amber' });
    expect(rosterState(person({ talking: true }))).toEqual({ text: 'Talking', tone: 'amber' });
    expect(rosterState(person({ muted: true }))).toEqual({ text: 'Muted', tone: 'dim' });
    expect(rosterState(person({ listening: true, muted: true }))).toEqual({ text: 'Listening in', tone: 'dim' });
    expect(rosterState(person({ self: true }))).toEqual({ text: 'Mic on', tone: 'ink' });
    expect(rosterState(person({}))).toEqual({ text: 'Mic on', tone: 'dim' });
    // Sharing wins over talking: the ring is amber for both.
    expect(rosterState(person({ sharing: true, talking: true })).text).toBe('Sharing screen');
  });
});

describe('the line under the name', () => {
  const make = (over: Partial<PillTarget>): PillTarget => ({
    serverId: 's1',
    guildId: 'g1',
    channelId: 'c',
    channelName: 'Lounge',
    title: 'Lounge',
    crossServer: false,
    isDm: false,
    relation: 'idle',
    mode: null,
    occupants: [],
    faces: [],
    talkers: [],
    streamer: null,
    ...over,
  });
  const p = (name: string, over: Partial<PillOccupant> = {}): PillOccupant => ({
    userId: name,
    name,
    avatar: null,
    self: false,
    listening: false,
    muted: false,
    sharing: false,
    streamStartedAt: null,
    talking: true,
    ...over,
  });

  it('says who is talking', () => {
    expect(pillLine(make({ talkers: [p('Brendan')] }), false)).toBe('Brendan is talking');
    expect(pillLine(make({ talkers: [p('Brendan'), p('Nick')] }), false)).toBe('Brendan and Nick are talking');
    expect(pillLine(make({ talkers: [p('A'), p('B'), p('C')] }), false)).toBe('3 people are talking');
  });

  it('says you are listening, or muted, before it says who talks', () => {
    expect(pillLine(make({ relation: 'listening', talkers: [p('Brendan')] }), true)).toBe('Listening in quietly');
    expect(pillLine(make({ relation: 'joined', talkers: [p('Brendan')] }), true)).toBe("You're muted");
    expect(pillLine(make({ relation: 'joined', talkers: [p('Brendan')] }), false)).toBe('Brendan is talking');
  });

  it('falls back to the stream, and to nothing', () => {
    expect(pillLine(make({ streamer: p('Vincent', { talking: false, sharing: true }) }), false)).toBe('Vincent is streaming');
    expect(pillLine(make({}), false)).toBeNull();
    expect(pillLine(make({ relation: 'joined', talkers: [p('You', { self: true })] }), false)).toBe("You're talking");
  });

  it('labels a screen', () => {
    expect(streamLabel({ name: 'Vincent', self: false })).toBe("Vincent's screen");
    expect(streamLabel({ name: 'You', self: true })).toBe('Your screen');
  });
});

describe('what fits (§5)', () => {
  // The pill drawn at each level: everything, no talking name, icons, faces and Join.
  const widths = [452, 452, 380, 124] as const;
  const widthAt = (level: 0 | 1 | 2 | 3) => widths[level];

  it('draws everything when it fits, and when nothing was measured', () => {
    expect(collapseLevelFor(500, widthAt)).toBe(0);
    expect(collapseLevelFor(452, widthAt)).toBe(0);
    expect(collapseLevelFor(0, widthAt)).toBe(0);
  });

  it('gives up the talking name, then the labels, then all but faces and Join, in that order', () => {
    // Level 1 only differs from 0 where the talking name is drawn.
    expect(collapseLevelFor(450, (level) => [500, 440, 380, 124][level])).toBe(1);
    expect(collapseLevelFor(400, widthAt)).toBe(2);
    expect(collapseLevelFor(200, widthAt)).toBe(3);
  });

  it('stops at faces and Join however short the room is', () => {
    expect(collapseLevelFor(40, widthAt)).toBe(3);
  });
});
