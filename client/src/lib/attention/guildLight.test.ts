import { describe, expect, it } from 'vitest';

import { EPOCH_MS } from './conversationModel';
import { guildLight, guildPeople, guildRooms, recentAuthorsOf, type GuildLightInput } from './guildLight';
import { createLitHistory } from './litHistory';
import { ChannelType, type Member, type VoiceState } from '../../types';

const SCOPE = { serverId: 'a', userId: 'viewer' };
const NOW = EPOCH_MS + 10 * 24 * 3_600_000;

function snowflakeAt(ms: number): string {
  return String((BigInt(ms) - BigInt(EPOCH_MS)) << 22n);
}

function member(id: string, username: string): Member {
  return {
    user: { id, username, discriminator: 0, bot: false, system: false, flags: 0, created_at: '' },
    roles: [],
    joined_at: '',
    deaf: false,
    mute: false,
  } as unknown as Member;
}

function voiceState(over: Partial<VoiceState> & { user_id: string }): VoiceState {
  return {
    session_id: 's',
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    guild_id: 'g1',
    ...over,
  };
}

function input(over: Partial<GuildLightInput> = {}): GuildLightInput {
  return {
    scope: SCOPE,
    guildId: 'g1',
    guildName: 'Kestrel Robotics',
    memberCount: 61,
    channels: [
      { id: 'v1', type: ChannelType.Voice, name: 'Shop floor', position: 0 },
      { id: 'v2', type: ChannelType.Voice, name: 'Lounge', position: 1 },
      { id: 'cat', type: ChannelType.Category, name: 'Rooms', position: 2 },
      { id: 't1', type: ChannelType.Text, name: 'build-log', position: 3 },
      { id: 't2', type: ChannelType.Text, name: 'general', position: 4 },
    ],
    members: [member('1', 'mara'), member('2', 'priya'), member('3', 'ren')],
    channelParticipants: new Map(),
    speakingUsers: new Set(),
    typingByChannel: {},
    messages: {},
    getStatus: () => 'online',
    selfUserId: '3',
    nowMs: NOW,
    litHistory: createLitHistory(),
    ...over,
  };
}

describe('guildLight — the store seam', () => {
  it('skips categories and keeps the building\'s own room order', () => {
    const building = guildLight(input());
    expect(building.windows.map((window) => window.name)).toEqual([
      'Shop floor',
      'Lounge',
      'build-log',
      'general',
    ]);
  });

  it('lights a voice room from the gateway voice states', () => {
    const building = guildLight(
      input({
        channelParticipants: new Map([
          ['v1', [voiceState({ user_id: '1' }), voiceState({ user_id: '2', self_stream: true })]],
        ]),
        speakingUsers: new Set(['1']),
      }),
    );
    const room = building.rooms.find((entry) => entry.channelId === 'v1')!;
    expect(room.level).toBe('white');
    expect(room.talkingCount).toBe(1);
    expect(room.screenSharer?.person.name).toBe('priya');
    expect(building.roomsLit).toBe(1);
    expect(building.caption).toBe('1 room lit');
  });

  it('refuses a voice state belonging to another building', () => {
    const building = guildLight(
      input({
        channelParticipants: new Map([['v1', [voiceState({ user_id: '1', guild_id: 'other' })]]]),
      }),
    );
    expect(building.rooms.find((room) => room.channelId === 'v1')!.lit).toBe(false);
  });

  it('lights a person from their voice state when the member list has not caught up', () => {
    const building = guildLight(
      input({
        members: [],
        channelParticipants: new Map([
          ['v1', [voiceState({ user_id: '9', username: 'late', display_name: 'Late Joiner' })]],
        ]),
      }),
    );
    const room = building.rooms.find((entry) => entry.channelId === 'v1')!;
    expect(room.occupants[0].person.name).toBe('Late Joiner');
  });

  it('lights a text room from typing and from a fresh author', () => {
    const building = guildLight(
      input({
        typingByChannel: { t1: ['1'] },
        messages: { t2: [{ id: snowflakeAt(NOW - 30_000), author: { id: '2' } }] },
      }),
    );
    expect(building.rooms.find((room) => room.channelId === 't1')!.readingCount).toBe(1);
    expect(building.rooms.find((room) => room.channelId === 't2')!.readingCount).toBe(1);
    expect(building.readingCount).toBe(2);
  });

  it('counts the local account as reading only when this window is visible', () => {
    const visible = guildLight(
      input({ selectedChannelId: 't1', windowVisible: true }),
    );
    expect(visible.rooms.find((room) => room.channelId === 't1')!.readingCount).toBe(1);
    const hidden = guildLight(input({ selectedChannelId: 't1', windowVisible: false }));
    expect(hidden.rooms.find((room) => room.channelId === 't1')!.readingCount).toBe(0);
  });

  it('records the call start so a duration counts from what this client saw', () => {
    const history = createLitHistory();
    const participants = new Map([['v1', [voiceState({ user_id: '1' })]]]);
    guildLight(input({ channelParticipants: participants, litHistory: history, nowMs: NOW }));
    const later = guildLight(
      input({ channelParticipants: participants, litHistory: history, nowMs: NOW + 90_000 }),
    );
    expect(later.rooms.find((room) => room.channelId === 'v1')!.durationMs).toBe(90_000);
  });

  it('counts only the members whose lights are on', () => {
    const building = guildLight(
      input({ getStatus: (userId) => (userId === '1' ? 'online' : 'offline') }),
    );
    expect(building.lightsOn).toBe(1);
    expect(building.memberCount).toBe(61);
  });

  it('scopes every key to the account', () => {
    const building = guildLight(input());
    expect(building.key).toBe(JSON.stringify(['a', 'viewer', 'g1']));
    expect(building.rooms[0].key).toBe(JSON.stringify(['a', 'viewer', 'v1']));
  });

  it('reads only the tail of a loaded timeline', () => {
    const messages = {
      t1: Array.from({ length: 60 }, (_, index) => ({
        id: snowflakeAt(NOW - index),
        author: { id: String(index) },
      })),
    };
    expect(recentAuthorsOf(messages, 't1')).toHaveLength(40);
    expect(recentAuthorsOf(messages, 'missing')).toEqual([]);
  });

  it('exposes people and rooms separately for callers that want one of them', () => {
    const built = input();
    const people = guildPeople(built);
    expect(people.map((person) => person.name)).toEqual(['mara', 'priya', 'ren']);
    expect(guildRooms(built, people)).toHaveLength(4);
  });
});
