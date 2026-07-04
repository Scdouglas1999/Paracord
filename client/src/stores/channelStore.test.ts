import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChannelStore } from './channelStore';
import { useServerListStore, type ServerEntry } from './serverListStore';
import type { Channel } from '../types';

// Mock the per-server transport so loadAllDmChannels() fan-out is deterministic.
vi.mock('../lib/connectionManager', () => ({
  LOCAL_SERVER_ID: '__local__',
  connectionManager: { getApiClient: vi.fn() },
}));

// Imported after the mock so we get the mocked instance.
import { connectionManager } from '../lib/connectionManager';

const mockGetApiClient = vi.mocked(connectionManager.getApiClient);

function server(id: string, connected = true): ServerEntry {
  return { id, url: `https://${id}`, name: id, token: 't', connected } as ServerEntry;
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: '1',
    type: 0,
    channel_type: 0,
    guild_id: 'g1',
    name: 'general',
    position: 0,
    nsfw: false,
    created_at: '2025-01-01T00:00:00Z',
    required_role_ids: [],
    thread_metadata: null,
    owner_id: null,
    message_count: null,
    attachments: [],
    ...overrides,
  } as Channel;
}

describe('channelStore', () => {
  beforeEach(() => {
    useChannelStore.setState({
      channelsByGuild: {},
      dmChannelsByServer: {},
      channelsById: {},
      channels: [],
      guildChannelsLoaded: {},
      selectedChannelId: null,
      selectedGuildId: null,
      isLoading: false,
    });
    useServerListStore.setState({ activeServerId: null, servers: [] });
    mockGetApiClient.mockReset();
  });

  it('has correct initial state', () => {
    const state = useChannelStore.getState();
    expect(state.channelsByGuild).toEqual({});
    expect(state.channelsById).toEqual({});
    expect(state.channels).toEqual([]);
    expect(state.guildChannelsLoaded).toEqual({});
    expect(state.selectedChannelId).toBeNull();
    expect(state.selectedGuildId).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it('selectChannel sets selected channel id', () => {
    useChannelStore.getState().selectChannel('ch1');
    expect(useChannelStore.getState().selectedChannelId).toBe('ch1');
  });

  it('selectChannel clears with null', () => {
    useChannelStore.getState().selectChannel('ch1');
    useChannelStore.getState().selectChannel(null);
    expect(useChannelStore.getState().selectedChannelId).toBeNull();
  });

  it('selectGuild sets guild and populates channels', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1' });
    useChannelStore.getState().setChannels([ch]);

    useChannelStore.getState().selectGuild('g1');
    expect(useChannelStore.getState().selectedGuildId).toBe('g1');
    expect(useChannelStore.getState().channels.map((c) => c.id)).toEqual(['c1']);
  });

  it('selectGuild with null clears channels', () => {
    useChannelStore.getState().selectGuild(null);
    expect(useChannelStore.getState().selectedGuildId).toBeNull();
    expect(useChannelStore.getState().channels).toEqual([]);
  });

  describe('setChannels', () => {
    it('builds correct byId index and flat array', () => {
      const a = makeChannel({ id: 'c1', guild_id: 'g1', position: 1 });
      const b = makeChannel({ id: 'c2', guild_id: 'g1', position: 0 });
      useChannelStore.getState().setChannels([a, b]);

      const state = useChannelStore.getState();
      // channelsByGuild sorted by position
      expect(state.channelsByGuild['g1'].map((c) => c.id)).toEqual(['c2', 'c1']);
      // byId indexes every channel
      expect(Object.keys(state.channelsById).sort()).toEqual(['c1', 'c2']);
      expect(state.channelsById['c1'].id).toBe('c1');
      expect(state.channelsById['c2'].id).toBe('c2');
      // flat array holds the normalized input
      expect(state.channels.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    });

    it('groups channels across guilds and reindexes each', () => {
      const a = makeChannel({ id: 'c1', guild_id: 'g1' });
      const b = makeChannel({ id: 'c2', guild_id: 'g2' });
      useChannelStore.getState().setChannels([a, b]);

      const state = useChannelStore.getState();
      expect(state.channelsByGuild['g1'].map((c) => c.id)).toEqual(['c1']);
      expect(state.channelsByGuild['g2'].map((c) => c.id)).toEqual(['c2']);
      expect(state.channelsById['c1'].guild_id).toBe('g1');
      expect(state.channelsById['c2'].guild_id).toBe('g2');
    });
  });

  it('addChannel adds a channel to the correct guild', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1', position: 0 });
    useChannelStore.getState().addChannel(ch);
    expect(useChannelStore.getState().channelsByGuild['g1']).toHaveLength(1);
    expect(useChannelStore.getState().channelsByGuild['g1'][0].id).toBe('c1');
  });

  it('addChannel does not duplicate', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1', position: 0 });
    useChannelStore.getState().addChannel(ch);
    useChannelStore.getState().addChannel(ch);
    expect(useChannelStore.getState().channelsByGuild['g1']).toHaveLength(1);
  });

  it('addChannel sorts by position', () => {
    const ch1 = makeChannel({ id: 'c1', guild_id: 'g1', position: 2 });
    const ch2 = makeChannel({ id: 'c2', guild_id: 'g1', position: 0 });
    useChannelStore.getState().addChannel(ch1);
    useChannelStore.getState().addChannel(ch2);
    const guild = useChannelStore.getState().channelsByGuild['g1'];
    expect(guild[0].id).toBe('c2');
    expect(guild[1].id).toBe('c1');
  });

  it('addChannel keeps byGuild, byId and flat in sync', () => {
    useChannelStore.getState().selectGuild('g1');
    const ch1 = makeChannel({ id: 'c1', guild_id: 'g1', position: 0 });
    const ch2 = makeChannel({ id: 'c2', guild_id: 'g1', position: 1 });
    useChannelStore.getState().addChannel(ch1);
    useChannelStore.getState().addChannel(ch2);

    const state = useChannelStore.getState();
    expect(state.channelsByGuild['g1'].map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(Object.keys(state.channelsById).sort()).toEqual(['c1', 'c2']);
    // byId points at the exact object stored in the guild bucket
    expect(state.channelsById['c1']).toBe(state.channelsByGuild['g1'][0]);
    expect(state.channelsById['c2']).toBe(state.channelsByGuild['g1'][1]);
    // flat view mirrors the selected guild
    expect(state.channels.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('updateChannel updates an existing channel', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1', name: 'old' });
    useChannelStore.getState().addChannel(ch);

    const updated = makeChannel({ id: 'c1', guild_id: 'g1', name: 'new' });
    useChannelStore.getState().updateChannel(updated);
    expect(useChannelStore.getState().channelsByGuild['g1'][0].name).toBe('new');
    expect(useChannelStore.getState().channelsById['c1'].name).toBe('new');
  });

  it('removeChannel removes a channel', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1' });
    useChannelStore.getState().addChannel(ch);
    expect(useChannelStore.getState().channelsByGuild['g1']).toHaveLength(1);

    useChannelStore.getState().removeChannel('g1', 'c1');
    expect(useChannelStore.getState().channelsByGuild['g1']).toHaveLength(0);
  });

  it('removeChannel keeps byGuild, byId and flat in sync', () => {
    useChannelStore.getState().selectGuild('g1');
    useChannelStore.getState().setChannels([
      makeChannel({ id: 'c1', guild_id: 'g1', position: 0 }),
      makeChannel({ id: 'c2', guild_id: 'g1', position: 1 }),
    ]);
    // flat view follows the selected guild after seeding
    useChannelStore.getState().selectGuild('g1');

    useChannelStore.getState().removeChannel('g1', 'c1');
    const state = useChannelStore.getState();
    expect(state.channelsByGuild['g1'].map((c) => c.id)).toEqual(['c2']);
    expect(Object.keys(state.channelsById)).toEqual(['c2']);
    expect(state.channelsById['c1']).toBeUndefined();
    expect(state.channels.map((c) => c.id)).toEqual(['c2']);
  });

  describe('updateLastMessageId', () => {
    it('updates the last message id on the target only', () => {
      const ch = makeChannel({ id: 'c1', guild_id: 'g1', last_message_id: 'old' });
      useChannelStore.getState().setChannels([ch]);

      useChannelStore.getState().updateLastMessageId('c1', 'new-msg-id');
      const state = useChannelStore.getState();
      expect(state.channelsByGuild['g1'][0].last_message_id).toBe('new-msg-id');
      expect(state.channelsById['c1'].last_message_id).toBe('new-msg-id');
    });

    it('does nothing for unknown channel (state reference unchanged)', () => {
      const ch = makeChannel({ id: 'c1', guild_id: 'g1' });
      useChannelStore.getState().setChannels([ch]);

      const before = useChannelStore.getState();
      useChannelStore.getState().updateLastMessageId('unknown', 'msg');
      expect(useChannelStore.getState().channelsByGuild).toBe(before.channelsByGuild);
      expect(useChannelStore.getState().channelsById).toBe(before.channelsById);
    });

    it('preserves === identity of untouched channel objects and array length', () => {
      useChannelStore.getState().selectGuild('g1');
      useChannelStore.getState().setChannels([
        makeChannel({ id: 'c1', guild_id: 'g1', position: 0 }),
        makeChannel({ id: 'c2', guild_id: 'g1', position: 1 }),
        makeChannel({ id: 'd1', guild_id: 'g2', position: 0 }),
      ]);
      useChannelStore.getState().selectGuild('g1');

      const before = useChannelStore.getState();
      const untouchedSameGuild = before.channelsByGuild['g1'][1]; // c2
      const untouchedGuildArray = before.channelsByGuild['g2'];
      const beforeLen = before.channelsByGuild['g1'].length;

      useChannelStore.getState().updateLastMessageId('c1', 'msg-99');
      const after = useChannelStore.getState();

      // target mutated to a new object
      expect(after.channelsByGuild['g1'][0]).not.toBe(before.channelsByGuild['g1'][0]);
      expect(after.channelsByGuild['g1'][0].last_message_id).toBe('msg-99');
      // sibling channel object identity preserved
      expect(after.channelsByGuild['g1'][1]).toBe(untouchedSameGuild);
      // untouched guild's array reference preserved
      expect(after.channelsByGuild['g2']).toBe(untouchedGuildArray);
      // array length unchanged
      expect(after.channelsByGuild['g1'].length).toBe(beforeLen);
      // flat view patched in place, identity of sibling preserved
      expect(after.channels).toHaveLength(before.channels.length);
      expect(after.channels[1]).toBe(untouchedSameGuild);
      expect(after.channels[0].last_message_id).toBe('msg-99');
    });
  });

  it('setDmChannels sets DMs under empty guild key', () => {
    const dm = makeChannel({ id: 'dm1', guild_id: undefined, name: 'DM' });
    useChannelStore.getState().setDmChannels([dm]);
    expect(useChannelStore.getState().channelsByGuild['']).toHaveLength(1);
    expect(useChannelStore.getState().channelsByGuild[''][0].id).toBe('dm1');
    expect(useChannelStore.getState().channelsById['dm1'].id).toBe('dm1');
  });

  it('addChannel updates flat channels when guild is selected', () => {
    useChannelStore.getState().selectGuild('g1');
    const ch = makeChannel({ id: 'c1', guild_id: 'g1' });
    useChannelStore.getState().addChannel(ch);
    expect(useChannelStore.getState().channels).toHaveLength(1);
  });

  describe('setDmChannelsForServer', () => {
    it('indexes DMs per server', () => {
      useServerListStore.setState({ activeServerId: 's1', servers: [] });
      const a = makeChannel({ id: 'dmA', guild_id: undefined, name: 'A' });
      const b = makeChannel({ id: 'dmB', guild_id: undefined, name: 'B' });
      useChannelStore.getState().setDmChannelsForServer('s1', [a]);
      useChannelStore.getState().setDmChannelsForServer('s2', [b]);

      const state = useChannelStore.getState();
      expect(state.dmChannelsByServer['s1'].map((c) => c.id)).toEqual(['dmA']);
      expect(state.dmChannelsByServer['s2'].map((c) => c.id)).toEqual(['dmB']);
    });

    it("mirrors channelsByGuild[''] + channelsById only for the active server", () => {
      useServerListStore.setState({ activeServerId: 's1', servers: [] });
      const active = makeChannel({ id: 'dmActive', guild_id: undefined });
      const background = makeChannel({ id: 'dmBg', guild_id: undefined });

      useChannelStore.getState().setDmChannelsForServer('s1', [active]);
      useChannelStore.getState().setDmChannelsForServer('s2', [background]);

      const state = useChannelStore.getState();
      // Active server mirrors into back-compat surfaces.
      expect(state.channelsByGuild[''].map((c) => c.id)).toEqual(['dmActive']);
      expect(state.channelsById['dmActive'].id).toBe('dmActive');
      // Background server does NOT touch back-compat surfaces.
      expect(state.channelsById['dmBg']).toBeUndefined();
    });
  });

  describe('loadAllDmChannels', () => {
    it('fans out over connected servers and writes each result', async () => {
      useServerListStore.setState({
        activeServerId: 's1',
        servers: [server('s1', true), server('s2', true), server('s3', false)],
      });
      const s1Dm = makeChannel({ id: 'dm-s1', guild_id: undefined });
      const s2Dm = makeChannel({ id: 'dm-s2', guild_id: undefined });
      mockGetApiClient.mockImplementation((id: string) => {
        if (id === 's1') return { get: vi.fn().mockResolvedValue({ data: [s1Dm] }) } as never;
        if (id === 's2') return { get: vi.fn().mockResolvedValue({ data: [s2Dm] }) } as never;
        return undefined;
      });

      await useChannelStore.getState().loadAllDmChannels();

      const state = useChannelStore.getState();
      expect(state.dmChannelsByServer['s1'].map((c) => c.id)).toEqual(['dm-s1']);
      expect(state.dmChannelsByServer['s2'].map((c) => c.id)).toEqual(['dm-s2']);
      // Disconnected server never queried.
      expect(state.dmChannelsByServer['s3']).toBeUndefined();
      expect(mockGetApiClient).not.toHaveBeenCalledWith('s3');
    });

    it('tolerates one server rejecting and still loads the others', async () => {
      useServerListStore.setState({
        activeServerId: 's1',
        servers: [server('s1', true), server('s2', true)],
      });
      const s2Dm = makeChannel({ id: 'dm-s2', guild_id: undefined });
      mockGetApiClient.mockImplementation((id: string) => {
        if (id === 's1') return { get: vi.fn().mockRejectedValue(new Error('down')) } as never;
        if (id === 's2') return { get: vi.fn().mockResolvedValue({ data: [s2Dm] }) } as never;
        return undefined;
      });

      await expect(useChannelStore.getState().loadAllDmChannels()).resolves.toBeUndefined();

      const state = useChannelStore.getState();
      expect(state.dmChannelsByServer['s1']).toBeUndefined();
      expect(state.dmChannelsByServer['s2'].map((c) => c.id)).toEqual(['dm-s2']);
    });
  });
});
