import { describe, expect, it } from 'vitest';
import type { VoiceState } from '../../types';
import { ambientTargetFor, chooseRoomSource, pickRoomStream } from './sources';

const state = (user: string, guild: string, extra: Partial<VoiceState> = {}): VoiceState => ({
  user_id: user,
  guild_id: guild,
  session_id: `s-${user}`,
  deaf: false,
  mute: false,
  self_deaf: false,
  self_mute: false,
  self_stream: false,
  self_video: false,
  suppress: false,
  ...extra,
});

describe('pickRoomStream', () => {
  const participants = new Map<string, VoiceState[]>([
    ['lounge', [state('vincent', 'gn', { self_stream: true }), state('brendan', 'gn'), state('nick', 'gn')]],
    ['arena', [state('luke', 'gn', { self_stream: true }), state('eric', 'gn')]],
    ['quiet', [state('a', 'gn'), state('b', 'gn'), state('c', 'gn'), state('d', 'gn')]],
    // Same bare channel id on another server's guild never counts here.
    ['other', [state('x', 'bc', { self_stream: true }), state('y', 'bc'), state('z', 'bc'), state('w', 'bc')]],
  ]);

  it('takes the busiest channel that has a stream, not the busiest channel', () => {
    const pick = pickRoomStream({
      guildId: 'gn',
      voiceChannelIds: ['arena', 'quiet', 'lounge', 'other'],
      channelParticipants: participants,
      selfUserId: 'sean',
    });
    expect(pick).toEqual({ channelId: 'lounge', streamerId: 'vincent', occupants: 3 });
  });

  it('breaks ties by the listed order and never picks your own stream', () => {
    const tied = new Map<string, VoiceState[]>([
      ['one', [state('sean', 'gn', { self_stream: true }), state('p', 'gn')]],
      ['two', [state('q', 'gn', { self_stream: true }), state('r', 'gn')]],
      ['three', [state('s', 'gn', { self_stream: true }), state('t', 'gn')]],
    ]);
    const pick = pickRoomStream({ guildId: 'gn', voiceChannelIds: ['one', 'three', 'two'], channelParticipants: tied, selfUserId: 'sean' });
    expect(pick).toEqual({ channelId: 'three', streamerId: 's', occupants: 2 });
  });

  it('within a channel, takes the stream that started first', () => {
    const two = new Map<string, VoiceState[]>([
      ['lounge', [
        state('late', 'gn', { self_stream: true, self_stream_started_at: '2026-10-01T02:10:00Z' }),
        state('early', 'gn', { self_stream: true, self_stream_started_at: '2026-10-01T01:30:00Z' }),
      ]],
    ]);
    expect(pickRoomStream({ guildId: 'gn', voiceChannelIds: ['lounge'], channelParticipants: two, selfUserId: null })?.streamerId).toBe('early');
  });

  it('finds nothing in a server with nothing live', () => {
    expect(pickRoomStream({ guildId: 'bc', voiceChannelIds: ['quiet'], channelParticipants: participants, selfUserId: null })).toBeNull();
  });
});

describe('chooseRoomSource', () => {
  const base = { serverId: 'local', guildId: 'gn', stage: null, stream: null, bannerUrl: null, iconUrl: null };

  it('prefers the stage, then the live stream, then the banner, then the icon', () => {
    const stream = { channelId: 'lounge', streamerId: 'vincent', occupants: 3 };
    const stage = { serverId: 'local', guildId: 'gn', channelId: 'arena', streamerId: 'luke' };
    expect(chooseRoomSource({ ...base, stage, stream, bannerUrl: 'b', iconUrl: 'i' })).toMatchObject({ kind: 'stream', view: 'watch', streamerId: 'luke' });
    expect(chooseRoomSource({ ...base, stream, bannerUrl: 'b', iconUrl: 'i' })).toMatchObject({ kind: 'stream', view: 'ambient', streamerId: 'vincent' });
    expect(chooseRoomSource({ ...base, bannerUrl: 'b', iconUrl: 'i' })).toMatchObject({ kind: 'image', role: 'banner', url: 'b' });
    expect(chooseRoomSource({ ...base, iconUrl: 'i' })).toMatchObject({ kind: 'image', role: 'icon', url: 'i' });
    expect(chooseRoomSource(base)).toEqual({ kind: 'none', key: null });
  });

  it('waits for a declared banner rather than flashing the icon first', () => {
    expect(chooseRoomSource({ ...base, iconUrl: 'i', bannerDeclared: true }).kind).toBe('none');
    expect(chooseRoomSource({ ...base, iconUrl: 'i', bannerUrl: 'b', bannerDeclared: true })).toMatchObject({ role: 'banner' });
  });

  it('rests on nothing at Home, unless a stage is open', () => {
    expect(chooseRoomSource({ ...base, guildId: null, bannerUrl: 'b' }).kind).toBe('none');
    const stage = { serverId: 'local', guildId: 'gn', channelId: 'lounge', streamerId: 'vincent' };
    expect(chooseRoomSource({ ...base, guildId: null, stage }).kind).toBe('stream');
  });

  it('keys each source by what it is, so another server is another source', () => {
    const a = chooseRoomSource({ ...base, bannerUrl: 'same' });
    const b = chooseRoomSource({ ...base, guildId: 'bc', bannerUrl: 'same' });
    expect(a.key).not.toBe(b.key);
  });
});

describe('ambientTargetFor', () => {
  it('asks for the busiest stream of the current server and nothing at Home', () => {
    const stream = { channelId: 'lounge', streamerId: 'vincent', occupants: 3 };
    expect(ambientTargetFor({ serverId: 'local', guildId: 'gn', stream })).toEqual({
      serverId: 'local', guildId: 'gn', channelId: 'lounge', streamerId: 'vincent',
    });
    expect(ambientTargetFor({ serverId: 'local', guildId: null, stream })).toBeNull();
    expect(ambientTargetFor({ serverId: 'local', guildId: 'gn', stream: null })).toBeNull();
  });
});
