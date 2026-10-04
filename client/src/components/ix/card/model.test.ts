import { describe, expect, it } from 'vitest';

import { ChannelType, type VoiceState } from '../../../types';
import {
  CARD_MAX_ROWS,
  DM_GUILD,
  cardLabel,
  cardRows,
  headLabel,
  heldBelongsTo,
  incomingLine,
  inlineCard,
  liveLabel,
  orderPeople,
  pinnedCard,
  rankRooms,
  roomStartedAt,
  rowName,
  type CardChannel,
  type CardPerson,
  type CardWorld,
  type HeldCall,
} from './model';

const SCOPE = { serverId: 's1', userId: 'me' };
const T0 = Date.parse('2026-10-01T21:12:50-05:00');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function state(userId: string, channelId: string, over: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId,
    channel_id: channelId,
    guild_id: 'g1',
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
    mode: 'joined',
    joined_at: at(0),
    ...over,
  };
}

const chan = (id: string, name: string, guildId: string | null, over: Partial<CardChannel> = {}): CardChannel => ({
  id,
  name,
  guildId,
  type: ChannelType.Voice,
  position: 0,
  ...over,
});

function world(over: Partial<CardWorld> = {}, speaking: Record<string, string[]> = {}): CardWorld {
  return {
    scope: SCOPE,
    held: null,
    channelParticipants: new Map(),
    channels: new Map([
      ['lounge', chan('lounge', 'Lounge', 'g1', { position: 1 })],
      ['ranked', chan('ranked', 'Ranked', 'g1', { position: 2 })],
      ['stage', chan('stage', 'Town hall', 'g1', { position: 3, type: ChannelType.Stage })],
      ['general', chan('general', 'General', 'g2')],
      ['dm1', chan('dm1', '', null, { type: ChannelType.DM })],
    ]),
    heldChannel: null,
    guildNames: new Map([
      ['g1', 'Game Night'],
      ['g2', 'Fuel'],
    ]),
    heldGuildName: null,
    dmTitle: null,
    people: new Map(),
    speakers: (_guild, channel) => new Set(speaking[channel] ?? []),
    watchers: () => undefined,
    selfUserId: 'me',
    ...over,
  };
}

const held = (channelId: string, guildId: string | null, over: Partial<HeldCall> = {}): HeldCall => ({
  scope: SCOPE,
  channelId,
  guildId,
  phase: 'connected',
  mode: 'joined',
  ...over,
});

const person = (userId: string, over: Partial<CardPerson> = {}): CardPerson => ({
  userId,
  name: userId,
  faceName: userId,
  avatar: null,
  self: false,
  listening: false,
  muted: false,
  sharing: false,
  streamStartedAt: null,
  talking: false,
  joinedAt: null,
  watchers: 0,
  ...over,
});

describe('which room a server shows (busiest room, §4.3)', () => {
  it('shows nothing when no room is live; listeners alone never make a room live', () => {
    expect(inlineCard(world(), { kind: 'server', guildId: 'g1' })).toBeNull();
    const w = world({ channelParticipants: new Map([['lounge', [state('ada', 'lounge', { mode: 'listen' })]]]) });
    expect(inlineCard(w, { kind: 'server', guildId: 'g1' })).toBeNull();
  });

  it('picks the room with the most people; a tie goes to the room that started first, then channel order', () => {
    const w = world({
      channelParticipants: new Map([
        ['lounge', [state('ada', 'lounge', { joined_at: at(10) })]],
        ['ranked', [state('bo', 'ranked', { joined_at: at(5) })]],
      ]),
    });
    expect(rankRooms(w, 'g1').map((room) => room.channel.id)).toEqual(['ranked', 'lounge']);
    w.channelParticipants = new Map([
      ['lounge', [state('ada', 'lounge'), state('cy', 'lounge')]],
      ['ranked', [state('bo', 'ranked', { joined_at: at(-30) })]],
    ]);
    expect(inlineCard(w, { kind: 'server', guildId: 'g1' })?.channelId).toBe('lounge');
    w.channelParticipants = new Map([
      ['ranked', [state('bo', 'ranked')]],
      ['lounge', [state('ada', 'lounge')]],
    ]);
    expect(inlineCard(w, { kind: 'server', guildId: 'g1' })?.channelId).toBe('lounge');
  });

  it('never shows another server’s room, nor a room it cannot name', () => {
    const w = world({
      channelParticipants: new Map([
        ['general', [state('ada', 'general', { guild_id: 'g2' })]],
        ['unknown', [state('bo', 'unknown')]],
      ]),
    });
    expect(inlineCard(w, { kind: 'server', guildId: 'g1' })).toBeNull();
    expect(inlineCard(w, { kind: 'server', guildId: 'g2' })?.title).toBe('General');
  });

  it('your call is this server’s card, even when another room is busier', () => {
    const w = world({
      held: held('ranked', 'g1'),
      channelParticipants: new Map([
        ['lounge', [state('ada', 'lounge'), state('bo', 'lounge'), state('cy', 'lounge')]],
        ['ranked', [state('me', 'ranked')]],
      ]),
    });
    const card = inlineCard(w, { kind: 'server', guildId: 'g1' });
    expect(card?.channelId).toBe('ranked');
    expect(card?.state).toBe('yours');
    expect(card?.serverLine).toBeNull();
    expect(pinnedCard(w, { kind: 'server', guildId: 'g1' })).toBeNull();
  });
});

describe('your call pinned elsewhere (§4.3, §5.4)', () => {
  const w = world({
    held: held('general', 'g2'),
    channelParticipants: new Map([['general', [state('jeremy', 'general', { guild_id: 'g2' }), state('me', 'general', { guild_id: 'g2' })]]]),
  });

  it('is pinned in every other place with its server line, and inline in its own', () => {
    expect(heldBelongsTo(w, { kind: 'server', guildId: 'g2' })).toBe(true);
    expect(pinnedCard(w, { kind: 'server', guildId: 'g2' })).toBeNull();
    const pinned = pinnedCard(w, { kind: 'server', guildId: 'g1' });
    expect(pinned).toMatchObject({ state: 'yours', title: 'General', serverLine: 'Fuel' });
    expect(pinnedCard(w, { kind: 'people' })?.serverLine).toBe('Fuel');
  });

  it('a DM call belongs to People and reads "Direct call" elsewhere', () => {
    const dm = world({
      held: held('dm1', DM_GUILD),
      dmTitle: 'Jeremy',
      channelParticipants: new Map([['dm1', [state('jeremy', 'dm1', { guild_id: undefined }), state('me', 'dm1', { guild_id: undefined })]]]),
    });
    expect(inlineCard(dm, { kind: 'people' })).toMatchObject({ title: 'Jeremy', isDm: true, state: 'yours' });
    expect(pinnedCard(dm, { kind: 'server', guildId: 'g1' })).toMatchObject({ title: 'Jeremy', serverLine: 'Direct call' });
  });

  it('a call held in another account is pinned everywhere', () => {
    const other = world({
      held: held('x9', 'g7', { scope: { serverId: 's2', userId: 'me2' } }),
      heldChannel: chan('x9', 'Den', 'g7'),
      heldGuildName: 'Elsewhere',
      selfUserId: 'me',
    });
    expect(pinnedCard(other, { kind: 'server', guildId: 'g7' })).toMatchObject({ title: 'Den', serverLine: 'Elsewhere' });
  });

  it('a call that is closing or failed is no card', () => {
    for (const phase of ['closing', 'closed', 'failed', 'idle'] as const) {
      const closing = world({ held: held('general', 'g2', { phase }) });
      expect(pinnedCard(closing, { kind: 'server', guildId: 'g1' })).toBeNull();
    }
  });
});

describe('states (§4.3)', () => {
  it('live, streaming (Watch the busiest stream), listening, yours; a stage channel', () => {
    const base = new Map([['lounge', [state('vincent', 'lounge'), state('bo', 'lounge')]]]);
    expect(inlineCard(world({ channelParticipants: base }), { kind: 'server', guildId: 'g1' })?.state).toBe('live');

    const streaming = world({
      channelParticipants: new Map([
        [
          'lounge',
          [
            state('bo', 'lounge', { self_stream: true, self_stream_started_at: at(3) }),
            state('vincent', 'lounge', { self_stream: true, self_stream_started_at: at(1) }),
          ],
        ],
      ]),
      watchers: () => new Map([['bo', 4]]),
    });
    const card = inlineCard(streaming, { kind: 'server', guildId: 'g1' });
    expect(card?.state).toBe('streaming');
    // The busiest stream: most watchers first, then the earliest started.
    expect(card?.watchTarget?.userId).toBe('bo');
    expect(card?.streams.map((p) => p.userId)).toEqual(['bo', 'vincent']);

    const listening = world({
      held: held('lounge', 'g1', { mode: 'listen' }),
      channelParticipants: new Map([['lounge', [state('vincent', 'lounge'), state('me', 'lounge', { mode: 'listen' })]]]),
    });
    const heard = inlineCard(listening, { kind: 'server', guildId: 'g1' });
    expect(heard?.state).toBe('listening');
    expect(heard?.heard).toBe(true);
    expect(heard?.people.map((p) => rowName(p))).toEqual(['Vincent', 'You — listening']);

    const joining = world({ held: held('lounge', 'g1', { phase: 'joining' }), channelParticipants: base });
    expect(inlineCard(joining, { kind: 'server', guildId: 'g1' })).toMatchObject({ state: 'yours', relation: 'joining' });

    const stage = world({ channelParticipants: new Map([['stage', [state('ada', 'stage')]]]) });
    expect(inlineCard(stage, { kind: 'server', guildId: 'g1' })).toMatchObject({ stage: true, title: 'Town hall' });
  });

  it('talking follows the speakers; a muted person is never talking', () => {
    const w = world(
      { channelParticipants: new Map([['lounge', [state('ada', 'lounge'), state('bo', 'lounge', { self_mute: true })]]]) },
      { lounge: ['ada', 'bo'] },
    );
    const card = inlineCard(w, { kind: 'server', guildId: 'g1' });
    expect(card?.talkers.map((p) => p.userId)).toEqual(['ada']);
    expect(card?.heard).toBe(false);
  });

  it('your face is your own name, your row is "You"', () => {
    const w = world({
      held: held('lounge', 'g1'),
      people: new Map([['me', { name: 'Sean', avatar: null }]]),
      channelParticipants: new Map([['lounge', [state('me', 'lounge')]]]),
    });
    const me = inlineCard(w, { kind: 'server', guildId: 'g1' })?.people[0];
    expect(me).toMatchObject({ name: 'You', faceName: 'Sean', self: true });
  });
});

describe('the stable order (§4.3)', () => {
  it('streamers first (in the order they started), then join order, then listeners', () => {
    const ordered = orderPeople([
      person('late', { joinedAt: 30 }),
      person('listener', { joinedAt: 1, listening: true }),
      person('early', { joinedAt: 10 }),
      person('streamer2', { joinedAt: 20, sharing: true, streamStartedAt: 200 }),
      person('streamer1', { joinedAt: 25, sharing: true, streamStartedAt: 100 }),
    ]);
    expect(ordered.map((p) => p.userId)).toEqual(['streamer1', 'streamer2', 'early', 'late', 'listener']);
  });

  it('does not follow the store’s order (a state change re-appends a person)', () => {
    const a = orderPeople([person('jeremy', { joinedAt: 1 }), person('me', { joinedAt: 2 })]);
    const b = orderPeople([person('me', { joinedAt: 2 }), person('jeremy', { joinedAt: 1 })]);
    expect(a.map((p) => p.userId)).toEqual(b.map((p) => p.userId));
  });

  it('a state without joined_at keeps its place after those with one', () => {
    const ordered = orderPeople([person('x'), person('a', { joinedAt: 5 }), person('y')]);
    expect(ordered.map((p) => p.userId)).toEqual(['a', 'x', 'y']);
  });
});

describe('rows and the overflow row', () => {
  it('six people are six rows; seven are five rows and "and 2 more" with their faces', () => {
    const six = Array.from({ length: 6 }, (_, i) => person(`p${i}`));
    expect(cardRows(six)).toEqual({ rows: six, overflow: null });
    const twelve = Array.from({ length: 12 }, (_, i) => person(`p${i}`));
    const { rows, overflow } = cardRows(twelve);
    expect(rows).toHaveLength(CARD_MAX_ROWS - 1);
    expect(overflow?.count).toBe(7);
    expect(overflow?.faces.map((p) => p.userId)).toEqual(['p5', 'p6', 'p7', 'p8', 'p9']);
  });
});

describe('words', () => {
  it('"just now", "live N min", hours', () => {
    expect(liveLabel(T0, T0 + 30_000)).toBe('just now');
    expect(liveLabel(T0, T0 + 34 * 60_000 + 59_000)).toBe('live 34 min');
    expect(liveLabel(T0, T0 + 60 * 60_000)).toBe('live 1 hr');
    expect(liveLabel(T0, T0 + 125 * 60_000)).toBe('live 2 hr 5 min');
    // A clock behind the server never reads negative.
    expect(liveLabel(T0, T0 - 90_000)).toBe('just now');
    expect(liveLabel(null, T0)).toBe('live');
  });

  it('the room’s start is the earliest joined_at among the people in it', () => {
    expect(roomStartedAt([state('a', 'x', { joined_at: at(5) }), state('b', 'x', { joined_at: at(1) }), state('c', 'x', { joined_at: null })])).toBe(
      T0 + 60_000,
    );
    expect(roomStartedAt([state('a', 'x', { joined_at: null })])).toBeNull();
  });

  it('head: "You’re in", "Listening", "Joining…", "Reconnecting…", else the live label', () => {
    const now = T0 + 34 * 60_000;
    expect(headLabel({ state: 'yours', relation: 'joined', reconnecting: false, startedAt: T0 }, now)).toBe('You’re in');
    expect(headLabel({ state: 'yours', relation: 'joining', reconnecting: false, startedAt: T0 }, now)).toBe('Joining…');
    expect(headLabel({ state: 'listening', relation: 'listening', reconnecting: false, startedAt: T0 }, now)).toBe('Listening');
    expect(headLabel({ state: 'yours', relation: 'joined', reconnecting: true, startedAt: T0 }, now)).toBe('Reconnecting…');
    expect(headLabel({ state: 'streaming', relation: 'idle', reconnecting: false, startedAt: T0 }, now)).toBe('live 34 min');
  });

  it('the accessible name: "General, live, 3 people, Vincent talking"', () => {
    const w = world(
      {
        channelParticipants: new Map([
          [
            'lounge',
            [
              state('vincent', 'lounge', { self_stream: true, joined_at: at(0) }),
              state('brendan', 'lounge', { joined_at: at(1) }),
              state('nick', 'lounge', { joined_at: at(2) }),
            ],
          ],
        ]),
        people: new Map([
          ['vincent', { name: 'Vincent', avatar: null }],
          ['brendan', { name: 'Brendan', avatar: null }],
          ['nick', { name: 'Nick', avatar: null }],
        ]),
      },
      { lounge: ['vincent'] },
    );
    const card = inlineCard(w, { kind: 'server', guildId: 'g1' })!;
    expect(cardLabel(card, T0 + 34 * 60_000)).toBe('Lounge, live 34 min, 3 people, Vincent sharing a screen, Vincent talking');
    const general = world(
      { channelParticipants: new Map([['lounge', [state('jeremy', 'lounge')]]]), people: new Map([['jeremy', { name: 'Jeremy', avatar: null }]]) },
      { lounge: ['jeremy'] },
    );
    expect(cardLabel(inlineCard(general, { kind: 'server', guildId: 'g1' })!, T0 + 10_000)).toBe('Lounge, just now, 1 person, Jeremy talking');
  });

  it('incoming: "Jeremy is calling"; a group already talking says who is in it', () => {
    expect(incomingLine({ callerName: 'Jeremy', participantCount: 1 })).toBe('Jeremy is calling');
    expect(incomingLine({ callerName: 'Ada, Bo', participantCount: 3 })).toBe('Ada, Bo are in a call');
  });
});
