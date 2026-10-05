import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  useBuildingLight,
  useBuildingLights,
} from './useLights';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { scopeGuild, useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import { useTypingStore } from '../stores/typingStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useRemoteSpeakingStore } from '../stores/remoteSpeakingStore';
import { roomLitHistory } from '../lib/attention/light';
import { LOCAL_SERVER_ID, entityScopeKey } from '../lib/serverScope';
import { ChannelType, type Channel, type Member, type VoiceState } from '../types';

// The home server is an explicit scope — `useCurrentAccountScope` resolves to it
// when no remote server is selected, which is the signed-in-locally case.
const SERVER = LOCAL_SERVER_ID;
const SCOPE = { serverId: SERVER, userId: 'viewer' };
const GUILD = 'g1';

function chan(over: Partial<Channel> & { id: string; type: ChannelType }): Channel {
  return { position: 0, nsfw: false, created_at: '', guild_id: GUILD, ...over } as Channel;
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
    guild_id: GUILD,
    ...over,
  };
}

/** A whole signed-in account with one building, seeded into the real stores. */
function seed(): void {
  useAuthStore.setState({
    user: { id: 'viewer', username: 'viewer' } as never,
    token: 'token',
  });
  useServerListStore.setState({ servers: [], activeServerId: null });
  useGuildStore.setState({
    guilds: [
      scopeGuild(
        { id: GUILD, name: 'Kestrel Robotics', owner_id: 'viewer', member_count: 61, created_at: '' },
        SCOPE,
      ),
    ],
  });
  useChannelStore.getState().setChannels(
    GUILD,
    [
      chan({ id: 'v1', type: ChannelType.Voice, name: 'Shop floor', position: 0 }),
      chan({ id: 'v2', type: ChannelType.Voice, name: 'Lounge', position: 1 }),
      chan({ id: 't1', type: ChannelType.Text, name: 'build-log', position: 2 }),
    ],
    SCOPE,
  );
  useMemberStore.setState({
    members: new Map([
      [entityScopeKey(SCOPE, GUILD), [member('1', 'mara'), member('2', 'priya'), member('3', 'ren')]],
    ]),
    membersLoaded: { [entityScopeKey(SCOPE, GUILD)]: true },
  });
  usePresenceStore.getState().setPresences(
    [
      { user_id: '1', status: 'online', activities: [] },
      { user_id: '2', status: 'online', activities: [] },
      { user_id: '3', status: 'idle', activities: [] },
    ],
    SERVER,
  );
  useVoiceStore.setState({
    channelParticipants: new Map<string, VoiceState[]>(),
    speakingUsers: new Set<string>(),
    channelId: null,
    guildId: null,
    connected: false,
    callScope: null,
    selfMute: false,
    selfDeaf: false,
    selfStream: false,
  });
  useTypingStore.setState({ typingByChannel: {} });
  useRemoteSpeakingStore.getState().reset();
}

beforeEach(() => {
  roomLitHistory.clear();
  useGuildStore.getState().reset();
  useChannelStore.getState().reset();
  useMemberStore.getState().reset();
  usePresenceStore.getState().reset();
  useTypingStore.getState().reset();
  seed();
});

afterEach(() => {
  roomLitHistory.clear();
});

describe('useBuildingLight', () => {
  it('builds the window map, the counts and the caption from the live stores', () => {
    const { result } = renderHook(() => useBuildingLight(GUILD));
    expect(result.current?.name).toBe('Kestrel Robotics');
    expect(result.current?.windows.map((window) => window.name)).toEqual([
      'Shop floor',
      'Lounge',
      'build-log',
    ]);
    expect(result.current?.lightsOn).toBe(2);
    expect(result.current?.memberCount).toBe(61);
    expect(result.current?.caption).toBe('Nobody in voice');
  });

  it('is null for a guild this account does not have', () => {
    const { result } = renderHook(() => useBuildingLight('nope'));
    expect(result.current).toBeNull();
  });

  it('lights a room when a voice state arrives, and dims it when they leave', () => {
    const { result, rerender } = renderHook(() => useBuildingLight(GUILD));
    expect(result.current?.roomsLit).toBe(0);

    act(() => {
      useVoiceStore.setState({
        channelParticipants: new Map([['v1', [voiceState({ user_id: '1' })]]]),
      });
    });
    rerender();
    expect(result.current?.roomsLit).toBe(1);
    expect(result.current?.windows[0].state).toBe('on');
    expect(result.current?.caption).toBe('1 in voice');

    act(() => {
      useVoiceStore.setState({ channelParticipants: new Map() });
    });
    rerender();
    expect(result.current?.roomsLit).toBe(0);
    // The room remembers that it WAS lit, for "last active …".
    expect(result.current?.rooms.find((room) => room.channelId === 'v1')?.lastLitMs).not.toBeNull();
  });

  it('turns a text room amber when somebody types in it', () => {
    const { result, rerender } = renderHook(() => useBuildingLight(GUILD));
    act(() => {
      useTypingStore.setState({ typingByChannel: { t1: ['1'] } });
    });
    rerender();
    const room = result.current?.rooms.find((entry) => entry.channelId === 't1');
    expect(room?.level).toBe('amber');
    expect(room?.caption).toBe('1 here');
  });

  it('will not light a room for somebody who is away', () => {
    const { result, rerender } = renderHook(() => useBuildingLight(GUILD));
    act(() => {
      useTypingStore.setState({ typingByChannel: { t1: ['3'] } }); // ren is idle
    });
    rerender();
    expect(result.current?.rooms.find((entry) => entry.channelId === 't1')?.lit).toBe(false);
  });

  it('scopes every key to the account', () => {
    const { result } = renderHook(() => useBuildingLight(GUILD));
    expect(result.current?.key).toBe(entityScopeKey(SCOPE, GUILD));
    expect(result.current?.rooms[0].key).toBe(entityScopeKey(SCOPE, 'v1'));
  });
});

describe('useBuildingLights across servers', () => {
  it('orders servers brightest first', () => {
    act(() => {
      useGuildStore.getState().setGuilds(
        [
          { id: GUILD, name: 'Kestrel Robotics', owner_id: 'viewer', member_count: 61, created_at: '' },
          { id: 'g2', name: 'Saltmarsh Sailing', owner_id: 'viewer', member_count: 12, created_at: '' },
        ],
        SCOPE,
      );
      useVoiceStore.setState({
        channelParticipants: new Map([['v1', [voiceState({ user_id: '1' })]]]),
      });
    });
    const { result } = renderHook(() => useBuildingLights());
    expect(result.current.map((building) => building.name)).toEqual([
      'Kestrel Robotics',
      'Saltmarsh Sailing',
    ]);
  });

  it('says it has not looked rather than claiming a server is empty', () => {
    // Harbor Lights is a building you are not standing in: nobody has fetched
    // its rooms or its members. "0 online · Nobody in voice" would be two claims
    // and both would be false.
    act(() => {
      useGuildStore.getState().setGuilds(
        [
          { id: GUILD, name: 'Kestrel Robotics', owner_id: 'viewer', member_count: 61, created_at: '' },
          { id: 'g2', name: 'Harbor Lights', owner_id: 'viewer', member_count: 12, created_at: '' },
        ],
        SCOPE,
      );
    });
    const { result } = renderHook(() => useBuildingLights());
    const harbor = result.current.find((building) => building.name === 'Harbor Lights');
    expect(harbor?.rosterKnown).toBe(false);
    expect(harbor?.caption).toBe('Open to see channels');
    const kestrel = result.current.find((building) => building.name === 'Kestrel Robotics');
    expect(kestrel?.rosterKnown).toBe(true);
  });


});
