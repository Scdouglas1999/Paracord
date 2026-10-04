import { renderHook } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { ENCRYPTED_DM_PLACEHOLDER } from '../../../stores/messageStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useNotificationPreferenceStore } from '../../../stores/notificationPreferenceStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType, type Channel, type Message, type VoiceState } from '../../../types';
import { roomOccupancy, useServerSidebar, withLocalDecryption } from './usePlacesData';

/**
 * What the Index sidebar reads from the stores for one server: the pane's own
 * server (never the route's), grouped channels with their lines, the rooms as
 * light, the calendar, and the one place a decrypted preview may come from. The
 * rules behind a row are sidebarRows.test.ts's; the stores here are real, and
 * previews, lights and the calendar (which are network or other hooks' work) are
 * stubbed.
 */

const SCOPE = { serverId: 'srv', userId: 'me' };
const GUILD_KEY = entityScopeKey(SCOPE, 'g1');
const NOW = new Date(2026, 9, 1, 21, 38).getTime();
const EPOCH_MS = 1704067200000;
const idAt = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();

const realGetPresence = usePresenceStore.getState().getPresence;

const hooks = vi.hoisted(() => ({
  previews: { status: 'ready', error: null, previews: new Map(), recentAuthors: new Map() } as unknown,
  messageApi: null as unknown,
  events: [] as unknown[],
}));

vi.mock('../../../hooks/useCurrentUser', () => ({ useCurrentAccountScope: () => SCOPE }));
vi.mock('../../../hooks/useChannelPreviews', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useChannelPreviews')>()),
  useChannelPreviews: () => hooks.previews,
}));
vi.mock('../../../hooks/useMessageStore', () => ({ useCurrentMessageStoreApi: () => hooks.messageApi }));
vi.mock('../../../hooks/useMutedGuilds', () => ({
  useMutedGuilds: () => ({ mutedGuildKeys: [], isMuted: () => false, toggleMute: vi.fn(), saving: {} }),
}));
vi.mock('../../rooms/lobby/useUpcomingEvents', () => ({
  useUpcomingEvents: () => ({ events: hooks.events, error: null, loaded: true, toggleRsvp: vi.fn() }),
}));

function channel(id: string, name: string, over: Partial<Channel> = {}): Channel {
  return { id, name, type: ChannelType.Text, position: 0, nsfw: false, guild_id: 'g1', created_at: '2026-01-01T00:00:00Z', ...over } as Channel;
}

function preview(over: Partial<ChannelPreviewEntry> & Pick<ChannelPreviewEntry, 'channelId'>): ChannelPreviewEntry {
  return {
    messageId: '1',
    messageType: 0,
    author: { id: 'u2', kind: 'user', name: 'Jeremy', avatar: null },
    content: 'hello',
    encrypted: false,
    createdAt: new Date(NOW - 60_000).toISOString(),
    media: null,
    attachmentCount: 0,
    hasSticker: false,
    ...over,
  };
}

function seed(channels: Channel[]) {
  useChannelStore.setState({
    channelsByGuild: { [GUILD_KEY]: channels },
    guildChannelsLoaded: { [GUILD_KEY]: true },
    errors: {},
    loading: {},
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
  hooks.previews = { status: 'ready', error: null, previews: new Map(), recentAuthors: new Map() };
  hooks.messageApi = createStore(() => ({ messages: {}, deletedMessageIds: {} }));
  hooks.events = [];
  useReadStateStore.setState({ byAccount: {} } as never);
  useVoiceStore.setState({ channelParticipants: new Map() } as never);
  usePresenceStore.setState({ getPresence: realGetPresence } as never);
  useMemberStore.setState({ members: new Map(), membersLoaded: {} } as never);
  useNotificationPreferenceStore.setState({ byAccount: {}, channelsByAccount: {} } as never);
  seed([channel('general', 'general', { last_message_id: idAt(NOW - 60_000) }), channel('lounge', 'Lounge', { type: ChannelType.Voice, position: 2 })]);
});

describe('useServerSidebar', () => {
  it('builds the groups from the channel store, marks the open channel, and lists voice channels as rooms', () => {
    hooks.previews = { status: 'ready', error: null, previews: new Map([['general', preview({ channelId: 'general', content: 'who is up' })]]), recentAuthors: new Map() };
    const { result } = renderHook(() => useServerSidebar('g1', 'general'));
    expect(result.current.listStatus).toBe('ready');
    expect(result.current.groups.map((group) => [group.label, group.channels.map((row) => [row.name, row.selected, row.line])])).toEqual([
      ['Channels', [['general', true, 'Jeremy: who is up']]],
    ]);
    expect(result.current.rooms.map((room) => [room.name, room.tail])).toEqual([['Lounge', 'Empty']]);
  });

  it('reads the server it is given, not the one on screen', () => {
    const other = entityScopeKey(SCOPE, 'g2');
    useChannelStore.setState({
      channelsByGuild: { [GUILD_KEY]: [channel('a', 'a')], [other]: [channel('b', 'b', { guild_id: 'g2' })] },
      guildChannelsLoaded: { [GUILD_KEY]: true, [other]: true },
    } as never);
    const { result } = renderHook(() => useServerSidebar('g2', null));
    expect(result.current.groups[0].channels.map((row) => row.name)).toEqual(['b']);
  });

  it('turns a read position into unread and a mention count, and a muted channel into silence', () => {
    seed([
      channel('a', 'a', { last_message_id: idAt(NOW - 60_000) }),
      channel('b', 'b', { position: 1, last_message_id: idAt(NOW - 60_000) }),
    ]);
    useReadStateStore.setState({
      byAccount: {
        [JSON.stringify([SCOPE.serverId, SCOPE.userId])]: {
          a: { channel_id: 'a', last_message_id: idAt(NOW - 3600_000), mention_count: 2 },
          b: { channel_id: 'b', last_message_id: idAt(NOW - 3600_000), mention_count: 0 },
        },
      },
    } as never);
    const first = renderHook(() => useServerSidebar('g1', null));
    expect(first.result.current.groups[0].channels.map((row) => [row.name, row.unread, row.mentions])).toEqual([['a', true, 2], ['b', true, 0]]);
  });

  const voiceState = (userId: string, channelId: string, over: Partial<VoiceState> = {}): VoiceState =>
    ({
      user_id: userId,
      channel_id: channelId,
      guild_id: 'g1',
      session_id: `s-${userId}`,
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: false,
      self_stream: false,
      self_video: false,
      suppress: false,
      username: userId,
      display_name: userId.toUpperCase(),
      avatar_hash: null,
      ...over,
    }) as VoiceState;

  it('shows who is in the rooms from the voice store: the streamer first, then in the order they came', () => {
    useVoiceStore.setState({
      channelParticipants: new Map([
        ['lounge', [voiceState('brendan', 'lounge', { joined_at: '2026-10-01T21:13:10Z' }), voiceState('vincent', 'lounge', { joined_at: '2026-10-01T21:12:50Z', self_stream: true }), voiceState('nick', 'lounge', { joined_at: '2026-10-01T21:20:00Z' })]],
      ]),
    } as never);
    const { result } = renderHook(() => useServerSidebar('g1', null));
    expect(result.current.rooms[0]).toMatchObject({ name: 'Lounge', busy: true, count: 3, tail: '3 here', streaming: true });
    expect(result.current.rooms[0].faces.map((face) => face.name)).toEqual(['VINCENT', 'BRENDAN', 'NICK']);
  });

  it('counts who is here now from presence: online only, not idle, away or offline', () => {
    const member = (id: string) => ({ user: { id, username: id, display_name: id.toUpperCase() }, roles: [] });
    useMemberStore.setState({ members: new Map([[GUILD_KEY, [member('a'), member('b'), member('c'), member('d')]]]), membersLoaded: { [GUILD_KEY]: true } } as never);
    const getPresence = vi.fn((id: string) => ({ a: { status: 'online' }, b: { status: 'idle' }, c: { status: 'dnd' } })[id as 'a' | 'b' | 'c']);
    usePresenceStore.setState({ getPresence } as never);
    const { result } = renderHook(() => useServerSidebar('g1', null));
    expect(result.current.roster).toEqual({ known: true, size: 4, here: 1 });
    expect(getPresence).toHaveBeenCalledWith('a', SCOPE.serverId);
  });

  it('knows nothing about who is here until the roster has arrived', () => {
    useMemberStore.setState({ members: new Map(), membersLoaded: {} } as never);
    const { result } = renderHook(() => useServerSidebar('g1', null));
    expect(result.current.roster).toEqual({ known: false, size: 0, here: 0 });
  });

  it('reads a message that is only an event as the event and its time, from the calendar', () => {
    seed([channel('plans', 'plans', { last_message_id: idAt(NOW - 60_000) })]);
    hooks.previews = { status: 'ready', error: null, previews: new Map([['plans', preview({ channelId: 'plans', content: '<event:7002>' })]]), recentAuthors: new Map() };
    hooks.events = [
      { id: '7002', name: 'Movie night', startsAt: new Date(2026, 9, 2, 21, 0), endsAt: null, channelId: null, location: null, creatorId: null, going: 0, youAreGoing: false, happeningNow: false },
    ];
    const { result } = renderHook(() => useServerSidebar('g1', null));
    expect(result.current.groups[0].channels[0].line).toBe('Movie night · Fri 9 PM');
    expect(result.current.events).toHaveLength(1);
  });

  it('says the list is loading, empty, or could not load', () => {
    useChannelStore.setState({ channelsByGuild: {}, guildChannelsLoaded: {}, errors: {} } as never);
    expect(renderHook(() => useServerSidebar('g1', null)).result.current.listStatus).toBe('loading');
    useChannelStore.setState({ guildChannelsLoaded: { [GUILD_KEY]: true } } as never);
    expect(renderHook(() => useServerSidebar('g1', null)).result.current.listStatus).toBe('empty');
    useChannelStore.setState({ guildChannelsLoaded: {}, errors: { [GUILD_KEY]: 'Network down' } } as never);
    const failed = renderHook(() => useServerSidebar('g1', null)).result.current;
    expect(failed.listStatus).toBe('error');
    expect(failed.listError).toBe('Network down');
  });

  it('is ready with only rooms in the server', () => {
    seed([channel('lounge', 'Lounge', { type: ChannelType.Voice })]);
    const { result } = renderHook(() => useServerSidebar('g1', null));
    expect(result.current.listStatus).toBe('ready');
    expect(result.current.groups).toEqual([]);
    expect(result.current.rooms).toHaveLength(1);
  });
});

describe('roomOccupancy', () => {
  const voice = (id: string): Channel => channel(id, id, { type: ChannelType.Voice });
  const state = (userId: string, channelId: string, over: Partial<VoiceState> = {}): VoiceState =>
    ({ user_id: userId, channel_id: channelId, guild_id: 'g1', self_stream: false, username: userId, display_name: null, avatar_hash: null, ...over }) as VoiceState;

  it('leaves out a listener (not in the room), another server’s state on the same channel id, and an empty room', () => {
    const map = new Map<string, VoiceState[]>([
      ['a', [state('u1', 'a'), state('u2', 'a', { mode: 'listen' }), state('u3', 'a', { guild_id: 'other' })]],
      ['b', [state('u4', 'b', { mode: 'listen' })]],
    ]);
    const result = roomOccupancy([voice('a'), voice('b'), voice('c')], map, 'g1', () => undefined);
    expect([...result.keys()]).toEqual(['a']);
    expect(result.get('a')?.map((who) => who.userId)).toEqual(['u1']);
  });

  it('names a person from the member list, else from their voice state, and ignores text channels', () => {
    const map = new Map<string, VoiceState[]>([['a', [state('u1', 'a', { username: 'jeremy', display_name: 'Jeremy V' }), state('u2', 'a', { username: 'nick' })]], ['text', [state('u9', 'text')]]]);
    const result = roomOccupancy([voice('a'), channel('text', 'general')], map, 'g1', (id) => (id === 'u2' ? 'Nick (nickname)' : undefined));
    expect(result.get('a')?.map((who) => who.name)).toEqual(['Jeremy V', 'Nick (nickname)']);
    expect(result.has('text')).toBe(false);
  });
});

describe('withLocalDecryption', () => {
  const encrypted = preview({ channelId: 'c', messageId: 'm1', encrypted: true, content: null });
  const message = (over: Partial<Message> = {}): Message =>
    ({
      id: 'm1',
      channel_id: 'c',
      content: 'meet at nine',
      author: { id: 'u2', username: 'jeremy', display_name: 'Jeremy' },
      created_at: new Date(NOW).toISOString(),
      e2ee: { ciphertext: 'x' },
      ...over,
    }) as unknown as Message;

  it('replaces an encrypted preview with what this client already read of that message', () => {
    const result = withLocalDecryption(new Map([['c', encrypted]]), { c: [message()] });
    expect(result.get('c')).toMatchObject({ encrypted: false, content: 'meet at nine', messageId: 'm1' });
  });

  it('leaves it encrypted when the store holds only the placeholder, nothing, or another message', () => {
    for (const messages of [
      { c: [message({ content: ENCRYPTED_DM_PLACEHOLDER })] },
      { c: [message({ content: '   ' })] },
      { c: [message({ id: 'other' })] },
      { c: [message({ e2ee: undefined })] },
      {},
    ]) {
      expect(withLocalDecryption(new Map([['c', encrypted]]), messages as never).get('c')?.encrypted).toBe(true);
    }
  });

  it('touches nothing that is not encrypted, and returns the same map when nothing changed', () => {
    const plain = new Map([['c', preview({ channelId: 'c' })]]);
    expect(withLocalDecryption(plain, { c: [message()] })).toBe(plain);
  });
});
