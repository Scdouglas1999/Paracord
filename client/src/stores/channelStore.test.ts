import { describe, it, expect, beforeEach } from 'vitest';
import { useChannelStore } from './channelStore';
import type { Channel } from '../types';

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
      channels: [],
      guildChannelsLoaded: {},
      selectedChannelId: null,
      selectedGuildId: null,
      isLoading: false,
    });
  });

  it('has correct initial state', () => {
    const state = useChannelStore.getState();
    expect(state.channelsByGuild).toEqual({});
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
    useChannelStore.setState({ channelsByGuild: { g1: [ch] } });

    useChannelStore.getState().selectGuild('g1');
    expect(useChannelStore.getState().selectedGuildId).toBe('g1');
    expect(useChannelStore.getState().channels).toEqual([ch]);
  });

  it('selectGuild with null clears channels', () => {
    useChannelStore.getState().selectGuild(null);
    expect(useChannelStore.getState().selectedGuildId).toBeNull();
    expect(useChannelStore.getState().channels).toEqual([]);
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

  it('updateChannel updates an existing channel', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1', name: 'old' });
    useChannelStore.getState().addChannel(ch);

    const updated = makeChannel({ id: 'c1', guild_id: 'g1', name: 'new' });
    useChannelStore.getState().updateChannel(updated);
    expect(useChannelStore.getState().channelsByGuild['g1'][0].name).toBe('new');
  });

  it('removeChannel removes a channel', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1' });
    useChannelStore.getState().addChannel(ch);
    expect(useChannelStore.getState().channelsByGuild['g1']).toHaveLength(1);

    useChannelStore.getState().removeChannel('g1', 'c1');
    expect(useChannelStore.getState().channelsByGuild['g1']).toHaveLength(0);
  });

  it('updateLastMessageId updates the last message id', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1', last_message_id: 'old' });
    useChannelStore.setState({ channelsByGuild: { g1: [ch] } });

    useChannelStore.getState().updateLastMessageId('c1', 'new-msg-id');
    expect(useChannelStore.getState().channelsByGuild['g1'][0].last_message_id).toBe('new-msg-id');
  });

  it('updateLastMessageId does nothing for unknown channel', () => {
    const ch = makeChannel({ id: 'c1', guild_id: 'g1' });
    useChannelStore.setState({ channelsByGuild: { g1: [ch] } });

    const before = useChannelStore.getState();
    useChannelStore.getState().updateLastMessageId('unknown', 'msg');
    // State reference should be the same (no-op)
    expect(useChannelStore.getState().channelsByGuild).toBe(before.channelsByGuild);
  });

  it('setDmChannels sets DMs under empty guild key', () => {
    const dm = makeChannel({ id: 'dm1', guild_id: undefined, name: 'DM' });
    useChannelStore.getState().setDmChannels([dm]);
    expect(useChannelStore.getState().channelsByGuild['']).toHaveLength(1);
    expect(useChannelStore.getState().channelsByGuild[''][0].id).toBe('dm1');
  });

  it('addChannel updates flat channels when guild is selected', () => {
    useChannelStore.getState().selectGuild('g1');
    const ch = makeChannel({ id: 'c1', guild_id: 'g1' });
    useChannelStore.getState().addChannel(ch);
    expect(useChannelStore.getState().channels).toHaveLength(1);
  });
});
