import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadStateStore } from './readStateStore';
import { useServerListStore, type ServerEntry } from './serverListStore';
import { computeGuildUnread } from '../hooks/useUnreadCounts';
import type { Channel, ReadState } from '../types';

// Mock the per-server transport so refresh() fan-out is deterministic.
vi.mock('../api/auth', () => ({
  authApi: { getReadStates: vi.fn() },
}));
vi.mock('../lib/connectionManager', () => ({
  LOCAL_SERVER_ID: '__local__',
  connectionManager: { getApiClient: vi.fn() },
}));

// Imported after the mock so we get the mocked instances.
import { authApi } from '../api/auth';
import { connectionManager } from '../lib/connectionManager';

const mockGetReadStates = vi.mocked(authApi.getReadStates);
const mockGetApiClient = vi.mocked(connectionManager.getApiClient);

function channel(id: string, lastMessageId: string | null, type = 0): Channel {
  return { id, type, last_message_id: lastMessageId } as unknown as Channel;
}

function rs(channelId: string, lastMessageId: string, mentions = 0): ReadState {
  return { channel_id: channelId, last_message_id: lastMessageId, mention_count: mentions };
}

function server(id: string, connected = true): ServerEntry {
  return { id, url: `https://${id}`, name: id, token: 't', connected } as ServerEntry;
}

function toMap(states: ReadState[]): Map<string, ReadState> {
  return new Map(states.map((s) => [s.channel_id, s]));
}

// Point the active-server adapters at a known server.
function setActive(activeServerId: string | null, servers: ServerEntry[] = []) {
  useServerListStore.setState({ activeServerId, servers });
}

describe('computeGuildUnread', () => {
  it('counts channels whose latest message is past the read cursor', () => {
    const channels = [
      channel('c1', 'm5'),
      channel('c2', 'm9'),
      channel('cat', null, 4), // category is skipped
    ];
    const readStates = toMap([
      rs('c1', 'm5', 0), // read
      rs('c2', 'm7', 2), // unread + mentions
    ]);

    expect(computeGuildUnread(channels, readStates)).toEqual({
      unreadCount: 1,
      mentionCount: 2,
    });
  });

  it('treats a channel with no read state and messages as unread', () => {
    const channels = [channel('c1', 'm1')];
    expect(computeGuildUnread(channels, new Map())).toEqual({
      unreadCount: 1,
      mentionCount: 0,
    });
  });

  it('returns null when nothing is unread and there are no mentions', () => {
    const channels = [channel('c1', 'm1')];
    const readStates = toMap([rs('c1', 'm1', 0)]);
    expect(computeGuildUnread(channels, readStates)).toBeNull();
  });
});

describe('readStateStore — serverId-scoped byServer', () => {
  beforeEach(() => {
    useReadStateStore.getState().reset();
    setActive('srv-a', [server('srv-a')]);
    mockGetReadStates.mockReset();
    mockGetApiClient.mockReset();
  });

  it('setAll writes into the named server bucket; accessors read it back', () => {
    useReadStateStore.getState().setAll([rs('c1', 'm1'), rs('c2', 'm2')], 'srv-b');

    expect(useReadStateStore.getState().getReadStateMap('srv-b')).toEqual({
      c1: rs('c1', 'm1'),
      c2: rs('c2', 'm2'),
    });
    expect(useReadStateStore.getState().getReadState('srv-b', 'c1')).toEqual(rs('c1', 'm1'));
    // Unknown servers/channels resolve empty.
    expect(useReadStateStore.getState().getReadStateMap('srv-z')).toEqual({});
    expect(useReadStateStore.getState().getReadState('srv-b', 'nope')).toBeUndefined();
  });

  it('serverId mutators isolate each server bucket', () => {
    useReadStateStore.getState().markRead('srv-a', 'c1', 'm9');
    useReadStateStore.getState().incrementMention('srv-b', 'c1');

    expect(useReadStateStore.getState().getReadState('srv-a', 'c1')).toEqual(rs('c1', 'm9', 0));
    expect(useReadStateStore.getState().getReadState('srv-b', 'c1')).toEqual(rs('c1', '', 1));
    // srv-a's c1 is untouched by srv-b's mention.
    expect(useReadStateStore.getState().getReadStateMap('srv-a')).toEqual({ c1: rs('c1', 'm9', 0) });
  });

  it('legacy single-arg adapters target the active server and update the mirror', () => {
    // 1-arg setAll → active server (srv-a).
    useReadStateStore.getState().setAll([rs('c1', 'm4', 3)]);
    expect(useReadStateStore.getState().getReadStateMap('srv-a')).toEqual({ c1: rs('c1', 'm4', 3) });
    expect(useReadStateStore.getState().readStates).toEqual({ c1: rs('c1', 'm4', 3) });

    // 2-arg markRead → active server; clears mentions + advances cursor.
    useReadStateStore.getState().markRead('c1', 'm9');
    expect(useReadStateStore.getState().getReadState('srv-a', 'c1')).toEqual(rs('c1', 'm9', 0));
    expect(useReadStateStore.getState().readStates.c1).toEqual(rs('c1', 'm9', 0));

    // 1-arg incrementMention → active server (dispatch's legacy shape).
    useReadStateStore.getState().incrementMention('c2');
    expect(useReadStateStore.getState().getReadState('srv-a', 'c2')).toEqual(rs('c2', '', 1));
    expect(useReadStateStore.getState().readStates.c2).toEqual(rs('c2', '', 1));
  });

  it('markRead flips a channel to read (via computeGuildUnread over the per-server map)', () => {
    const channels = [channel('c1', 'm9')];
    useReadStateStore.getState().setAll([rs('c1', 'm4', 3)], 'srv-a');

    let map = toMap(Object.values(useReadStateStore.getState().getReadStateMap('srv-a')));
    expect(computeGuildUnread(channels, map)).toEqual({ unreadCount: 1, mentionCount: 3 });

    useReadStateStore.getState().markRead('srv-a', 'c1', 'm9');
    map = toMap(Object.values(useReadStateStore.getState().getReadStateMap('srv-a')));
    expect(computeGuildUnread(channels, map)).toBeNull();
  });

  it('active adapters fall back to the __local__ bucket when no server is active', () => {
    setActive(null);
    useReadStateStore.getState().incrementMention('c9');
    expect(useReadStateStore.getState().getReadState('__local__', 'c9')).toEqual(rs('c9', '', 1));
    expect(useReadStateStore.getState().readStates.c9).toEqual(rs('c9', '', 1));
  });

  it('reset clears every bucket and the mirror', () => {
    useReadStateStore.getState().setAll([rs('c1', 'm1')], 'srv-a');
    useReadStateStore.getState().setAll([rs('c2', 'm2')], 'srv-b');

    useReadStateStore.getState().reset();

    expect(useReadStateStore.getState().byServer).toEqual({});
    expect(useReadStateStore.getState().readStates).toEqual({});
  });
});

describe('readStateStore.refresh — per-server fan-out', () => {
  beforeEach(() => {
    useReadStateStore.getState().reset();
    mockGetReadStates.mockReset();
    mockGetApiClient.mockReset();
  });

  it('fetches the active server via authApi and background servers via their clients', async () => {
    setActive('srv-a', [server('srv-a'), server('srv-b')]);
    mockGetReadStates.mockResolvedValue({ data: [rs('a1', 'm1')] } as never);
    const bClient = { get: vi.fn().mockResolvedValue({ data: [rs('b1', 'm2')] }) };
    mockGetApiClient.mockImplementation((id: string) =>
      id === 'srv-b' ? (bClient as never) : undefined,
    );

    await useReadStateStore.getState().refresh();

    expect(mockGetReadStates).toHaveBeenCalledTimes(1);
    expect(bClient.get).toHaveBeenCalledWith('/users/@me/read-states');
    expect(useReadStateStore.getState().getReadStateMap('srv-a')).toEqual({ a1: rs('a1', 'm1') });
    expect(useReadStateStore.getState().getReadStateMap('srv-b')).toEqual({ b1: rs('b1', 'm2') });
    // Mirror reflects the active server.
    expect(useReadStateStore.getState().readStates).toEqual({ a1: rs('a1', 'm1') });
  });

  it('keeps each server\'s prior snapshot when its fetch fails (graceful degrade)', async () => {
    setActive('srv-a', [server('srv-a'), server('srv-b')]);
    // Seed prior snapshots.
    useReadStateStore.getState().setAll([rs('a1', 'old')], 'srv-a');
    useReadStateStore.getState().setAll([rs('b1', 'old')], 'srv-b');

    mockGetReadStates.mockRejectedValue(new Error('offline'));
    const bClient = { get: vi.fn().mockRejectedValue(new Error('offline')) };
    mockGetApiClient.mockImplementation(() => bClient as never);

    await useReadStateStore.getState().refresh();

    expect(useReadStateStore.getState().getReadStateMap('srv-a')).toEqual({ a1: rs('a1', 'old') });
    expect(useReadStateStore.getState().getReadStateMap('srv-b')).toEqual({ b1: rs('b1', 'old') });
  });

  it('skips disconnected servers and servers without an API client', async () => {
    setActive('srv-a', [server('srv-a'), server('srv-b', false), server('srv-c')]);
    mockGetReadStates.mockResolvedValue({ data: [] } as never);
    const cClient = { get: vi.fn().mockResolvedValue({ data: [rs('c1', 'm1')] }) };
    // srv-c has a client; srv-b is disconnected (never reached).
    mockGetApiClient.mockImplementation((id: string) =>
      id === 'srv-c' ? (cClient as never) : undefined,
    );

    await useReadStateStore.getState().refresh();

    expect(mockGetApiClient).not.toHaveBeenCalledWith('srv-b');
    expect(cClient.get).toHaveBeenCalledTimes(1);
    expect(useReadStateStore.getState().getReadStateMap('srv-c')).toEqual({ c1: rs('c1', 'm1') });
  });
});
