import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, User } from '../types';
const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
import { useChannelStore, refreshGuildChannelVisibility } from './channelStore';
import { useServerListStore } from './serverListStore';
import { entityScopeKey, type AccountScope } from '../lib/serverScope';
import { getAccountChannelView } from '../hooks/useChannels';
import { toast } from './toastStore';
const a: AccountScope = { serverId: 'a', userId: '42' };
const b: AccountScope = { serverId: 'b', userId: '42' };
const channel = (name = 'A', id = '1', guildId: string | null = 'g'): Channel => ({ id, guild_id: guildId, type: guildId ? 0 : 1, name, position: 0, nsfw: false, created_at: '2026-01-01' });
const reply = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
const state = () => useChannelStore.getState();
const cached = (scope = a, id = '1') => state().channelsById[entityScopeKey(scope, id)];
function delay(serverId = 'a') {
  const waiting = new Map<string, (data: unknown) => void>();
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => new Promise<AxiosResponse>(resolve => { waiting.set(config.url!, data => resolve(reply(config, data))); }));
  clients.get(serverId)!.defaults.adapter = adapter;
  return { adapter, finish: (url: string, data: unknown) => waiting.get(url)!(data), finishGuild: (data: Channel[], visible = data.map(c => c.id), guildId = 'g') => {
    waiting.get(`/guilds/${guildId}/channels`)!(data); waiting.get(`/guilds/${guildId}/channels/visible`)!({ channel_ids: visible });
  } };
}
beforeEach(() => {
  state().reset(); clients.clear();
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, url: `https://${id}.test`, name: id, token: `${id}-token`, userId: '42', user: { id: '42', username: id } as User, connected: true })) });
  for (const id of ['a', 'b']) clients.set(id, axios.create({ adapter: async config => reply(config, config.url?.endsWith('/visible') ? { channel_ids: ['1'] } : [channel(id)]) }));
});
afterEach(() => { state().reset(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('channel account ownership and snapshot reconciliation', () => {
  it('fetches colliding channel and guild IDs concurrently on separate servers', async () => {
    await Promise.all([state().fetchChannels('g', a), state().fetchChannels('g', b)]);
    expect(cached()?.name).toBe('a'); expect(cached(b)?.name).toBe('b');
    expect(Object.keys(state().channelsById)).toHaveLength(2);
  });
  it('does not cancel unrelated guild requests on the same server', async () => {
    const pending = delay(); const first = state().fetchChannels('g', a); const second = state().fetchChannels('other', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(4));
    pending.finishGuild([channel()]); await first;
    expect(state().loading[entityScopeKey(a, 'other')]).toBe(true);
    pending.finishGuild([channel('Other', '2', 'other')], ['2'], 'other'); await second;
    expect(cached(a, '2')?.name).toBe('Other'); expect(cached()?.name).toBe('A');
  });
  it('coalesces duplicate list fetches and exposes account-local views', async () => {
    const pending = delay(); const first = state().fetchChannels('g', a); const second = state().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    pending.finishGuild([channel()]); await Promise.all([first, second]);
    expect(getAccountChannelView(a).channelsById['1']?.name).toBe('A');
    expect(getAccountChannelView(b).channelsById['1']).toBeUndefined();
  });
  it('never substitutes the unfiltered list when visibility fails', async () => {
    vi.spyOn(toast, 'error').mockImplementation(() => 'toast');
    clients.get('a')!.defaults.adapter = async config => { if (config.url?.endsWith('/visible')) throw new Error('Visibility unavailable'); return reply(config, [channel('Hidden')]); };
    await state().fetchChannels('g', a);
    expect(cached()).toBeUndefined(); expect(state().errors[entityScopeKey(a, 'g')]).toContain('Visibility unavailable');
  });
  it('filters by the acknowledged visibility list and preserves sort order', async () => {
    const pending = delay(); const load = state().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    pending.finishGuild([{ ...channel('Later', '2'), position: 2 }, channel(), channel('Hidden', '3')], ['1', '2']); await load;
    expect(getAccountChannelView(a).channelsByGuild.g.map(c => c.name)).toEqual(['A', 'Later']);
  });
  it('reconciles creates, coalesced edits and deletes over a stale list', async () => {
    const pending = delay(); const load = state().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    state().updateChannel({ id: '1', guild_id: 'g', name: 'Renamed' }, a);
    state().updateChannel({ id: '1', guild_id: 'g', topic: 'Updated topic' }, a);
    state().removeChannel('g', 'removed', a); state().addChannel(channel('New', 'new'), a);
    pending.finishGuild([channel('Old'), channel('Removed', 'removed')]); await load;
    expect(cached()).toMatchObject({ name: 'Renamed', topic: 'Updated topic' });
    expect(cached(a, 'removed')).toBeUndefined(); expect(cached(a, 'new')?.name).toBe('New');
  });
  it('does not let stale edits resurrect a deleted channel', async () => {
    const pending = delay(); const load = state().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    state().removeChannel('g', '1', a); state().updateChannel({ id: '1', guild_id: 'g', name: 'Stale' }, a);
    pending.finishGuild([channel()]); await load; expect(cached()).toBeUndefined();
  });
  it('DM create, update, removal and last-message changes touch only their account', () => {
    state().addChannel(channel('A', '1', null), a); state().addChannel(channel('B', '1', null), b);
    state().updateChannel({ id: '1', name: 'Renamed' }, a); state().applyMessageActivity('1', { channel_id: '1', guild_id: null, last_message_id: '999', revision: '1' }, a);
    expect(cached()).toMatchObject({ name: 'Renamed', last_message_id: '999' });
    expect(cached(b)?.name).toBe('B'); expect(cached(b)?.last_message_id).toBeUndefined();
    state().selectChannel({ id: '1', scope: b }); state().removeChannel('', '1', a);
    expect(cached(b)?.name).toBe('B'); expect(state().selectedChannel?.scope).toEqual(b);
    state().removeChannel('', '1', b); expect(state().selectedChannel).toBeNull();
  });
  it('stores background DM lists in the index even when another server is selected', async () => {
    clients.get('b')!.defaults.adapter = async config => reply(config, [channel('Background DM', '1', null)]);
    await state().fetchDmChannels(b); expect(cached(b)?.name).toBe('Background DM'); expect(cached()).toBeUndefined();
  });
  it.each(['createDm', 'createGroupDm', 'createChannel'] as const)('%s keeps the origin through a selection switch', async action => {
    const pending = delay(); const promise = action === 'createDm' ? state().createDm('peer', a) : action === 'createGroupDm' ? state().createGroupDm(['peer'], 'Group', a) : state().createChannel('g', { name: 'Created', channel_type: 0 }, a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    useServerListStore.getState().setActive('b'); const request = pending.adapter.mock.calls[0][0];
    expect(request.baseURL).toBe('https://a.test/api/v1');
    pending.finish(request.url!, channel('Created', '1', action === 'createChannel' ? 'g' : null));
    expect(await promise).toMatchObject({ scope: a }); expect(cached(b)).toBeUndefined();
  });
  it('reorders only after acknowledgment without rolling back concurrent edits on failure', async () => {
    state().addChannel(channel(), a); const pending = delay(); const reorder = state().reorderChannels('g', [{ id: '1', position: 5 }], a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    state().updateChannel({ id: '1', name: 'New name' }, a); expect(cached()?.position).toBe(0);
    pending.finish('/guilds/g/channels', { updated: 1 }); await reorder;
    expect(cached()).toMatchObject({ position: 5, name: 'New name' });
    clients.get('a')!.defaults.adapter = async () => { throw new Error('offline'); };
    await expect(state().reorderChannels('g', [{ id: '1', position: 8 }], a)).rejects.toThrow('offline');
    expect(cached()).toMatchObject({ position: 5, name: 'New name' });
  });
  it('reset prevents delayed create or snapshot responses from repopulating the cache', async () => {
    const pending = delay(); const create = state().createDm('peer', a); const rejected = expect(create).rejects.toThrow(); const load = state().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(3));
    state().reset(); pending.finish('/users/@me/dms', channel()); pending.finishGuild([channel()]);
    await rejected; await load; expect(state().channelsById).toEqual({}); expect(state().loading).toEqual({});
  });
  it('revocation releases loading immediately and a late response cannot clear replacement loading', async () => {
    const old = delay(); const oldLoad = state().fetchDmChannels(a);
    await vi.waitFor(() => expect(old.adapter).toHaveBeenCalledTimes(1));
    await useServerListStore.getState().clearSessions();
    expect(state().loading[entityScopeKey(a, '')]).toBe(false);
    useServerListStore.getState().updateToken('a', 'fresh'); useServerListStore.getState().setAuthenticatedUser('a', { id: '42', username: 'fresh' } as User);
    const fresh = delay(); const newLoad = state().fetchDmChannels(a);
    await vi.waitFor(() => expect(fresh.adapter).toHaveBeenCalledTimes(1));
    old.finish('/users/@me/dms', [channel('Old', '1', null)]); await oldLoad;
    expect(state().loading[entityScopeKey(a, '')]).toBe(true); expect(cached()).toBeUndefined();
    fresh.finish('/users/@me/dms', [channel('Fresh', '1', null)]); await newLoad; expect(cached()?.name).toBe('Fresh');
  });
  it('debounced visibility refresh keeps its original account across switches', async () => {
    vi.useFakeTimers(); const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => reply(config, config.url?.endsWith('/visible') ? { channel_ids: ['1'] } : [channel()])); clients.get('a')!.defaults.adapter = adapter;
    refreshGuildChannelVisibility('g', a); useServerListStore.getState().setActive('b'); await vi.advanceTimersByTimeAsync(751);
    expect(adapter).toHaveBeenCalledTimes(2); expect(cached()?.name).toBe('A'); expect(cached(b)).toBeUndefined();
  });
  it('journals last-message activity even before its guild channel has loaded', async () => {
    const pending = delay(); const load = state().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    state().updateChannel({ id: '1', guild_id: 'g', last_message_id: '999', message_revision: '1' }, a);
    pending.finishGuild([{ ...channel(), last_message_id: '100' }]); await load;
    expect(cached()?.last_message_id).toBe('999');
  });
  it('coalesces repeated field updates without retaining an event per edit', async () => {
    const pending = delay(); const load = state().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 12_000; i++) state().updateChannel({ id: '1', guild_id: 'g', topic: String(i) }, a);
    pending.finishGuild([channel()]); await load; expect(cached()?.topic).toBe('11999');
  });
  it('invalidates an overflowing snapshot explicitly instead of applying an incomplete journal', async () => {
    vi.spyOn(toast, 'error').mockImplementation(() => 'toast');
    const pending = delay(); const load = state().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    for (let i = 0; i <= 10_000; i++) state().updateChannel({ id: String(i), guild_id: 'g', name: 'New' }, a);
    expect(state().loading[entityScopeKey(a, 'g')]).toBe(false);
    expect(state().guildChannelsLoaded[entityScopeKey(a, 'g')]).toBe(false);
    expect(state().errors[entityScopeKey(a, 'g')]).toContain('exceeded');
    pending.finishGuild([channel('Stale')]); await load; expect(cached()).toBeUndefined();
  });
  it('updates recipients and leaves a group only in the originating account', async () => {
    state().addChannel(channel('A', '1', null), a); state().addChannel(channel('B', '1', null), b);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => reply(config, config.method === 'get' ? [{ id: 'peer', username: 'Peer', discriminator: 0 }] : {}));
    clients.get('a')!.defaults.adapter = adapter;
    useServerListStore.getState().setActive('b');
    await state().changeDmRecipient('1', 'peer', true, a);
    expect(cached()?.recipients?.[0].username).toBe('Peer'); expect(cached(b)?.recipients).toBeUndefined();
    await state().changeDmRecipient('1', '42', false, a);
    expect(cached()).toBeUndefined(); expect(cached(b)?.name).toBe('B');
    expect(adapter.mock.calls.map(([config]) => [config.method, config.url])).toEqual([
      ['put', '/channels/1/recipients/peer'], ['get', '/channels/1/recipients'], ['delete', '/channels/1/recipients/42'],
    ]);
  });

});

describe('ordered channel message activity', () => {
  const row = (revision: string, tail: string | null): Channel => ({ ...channel('Activity', '1', '100'), message_revision: revision, last_message_id: tail });
  const activity = (revision: string, tail: string | null, scope = a) => state().applyMessageActivity('1', { channel_id: '1', guild_id: '100', revision, last_message_id: tail }, scope);

  it('keeps deletion across old creation events and snapshots while applying ordinary metadata', () => {
    state().addChannel(row('1', '999'), a);
    activity('2', null);
    activity('1', '999');
    state().setChannels('100', [{ ...row('1', '999'), name: 'Renamed' }], a);
    expect(cached()).toMatchObject({ name: 'Renamed', message_revision: '2', last_message_id: null });
    state().updateChannel({ id: '1', topic: 'New topic', last_message_id: '999' }, a);
    expect(cached()).toMatchObject({ topic: 'New topic', message_revision: '2', last_message_id: null });
    activity('3', '1000');
    activity('2', null);
    expect(cached()).toMatchObject({ message_revision: '3', last_message_id: '1000' });
  });

  it('coalesces revisions before an initial collection arrives and accepts a newer snapshot', async () => {
    const pending = delay();
    const first = state().fetchChannels('100', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    activity('4', null);
    activity('3', '999');
    pending.finishGuild([row('2', '888')], ['1'], '100');
    await first;
    expect(cached()).toMatchObject({ message_revision: '4', last_message_id: null });
    const second = state().fetchChannels('100', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(4));
    activity('5', null);
    pending.finishGuild([row('6', '1001')], ['1'], '100');
    await second;
    expect(cached()).toMatchObject({ message_revision: '6', last_message_id: '1001' });
  });

  it('compares full-width revisions and rejects equal-revision conflicting tails', () => {
    state().addChannel(row('9007199254740992', '900'), a);
    activity('9007199254740993', null);
    activity('9007199254740992', '900');
    activity('9007199254740993', '900');
    expect(cached()).toMatchObject({ message_revision: '9007199254740993', last_message_id: null });
  });

  it('owns revisions by server/account and rejects malformed or mismatched envelopes', () => {
    state().addChannel(row('1', '900'), a); state().addChannel(row('1', '901'), b);
    activity('2', null, b);
    expect(cached()).toMatchObject({ message_revision: '1', last_message_id: '900' });
    expect(cached(b)).toMatchObject({ message_revision: '2', last_message_id: null });
    for (const bad of [undefined, {}, { channel_id: '2', guild_id: '100', revision: '3', last_message_id: null }, { channel_id: '1', guild_id: '101', revision: '3', last_message_id: null }, { channel_id: '1', guild_id: '100', revision: 3, last_message_id: null }, { channel_id: '1', guild_id: '100', revision: '9223372036854775808', last_message_id: null }, { channel_id: '1', guild_id: '100', revision: '03', last_message_id: null }]) state().applyMessageActivity('1', bad, a);
    expect(cached()).toMatchObject({ message_revision: '1', last_message_id: '900' });
  });
});


it('retains early activity until an authorized channel arrives and clears it on removal or reset', () => {
  const early = { channel_id: '1', guild_id: '100', revision: '2', last_message_id: null };
  state().applyMessageActivity('1', early, a);
  state().applyMessageActivity('1', { ...early, revision: '1', last_message_id: '999' }, a);
  expect(cached()).toBeUndefined();
  state().addChannel({ ...channel('Arrived', '1', '100'), message_revision: '1', last_message_id: '999' }, a);
  expect(cached()).toMatchObject({ message_revision: '2', last_message_id: null });
  state().applyMessageActivity('2', { ...early, channel_id: '2' }, a);
  state().removeChannel('100', '2', a);
  state().addChannel({ ...channel('Removed then fetched', '2', '100'), message_revision: '0', last_message_id: null }, a);
  expect(cached(a, '2')?.message_revision).toBe('0');
  state().applyMessageActivity('3', { ...early, channel_id: '3' }, a);
  state().reset();
  state().addChannel({ ...channel('New session', '3', '100'), message_revision: '0', last_message_id: null }, a);
  expect(cached(a, '3')?.message_revision).toBe('0');
});

it('retains activity arriving during an older list that omits its channel', async () => {
  const pending = delay();
  const load = state().fetchChannels('100', a);
  await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
  state().applyMessageActivity('1', { channel_id: '1', guild_id: '100', revision: '2', last_message_id: null }, a);
  pending.finishGuild([], [], '100');
  await load;
  expect(cached()).toBeUndefined();
  state().addChannel({ ...channel('Arrived', '1', '100'), message_revision: '1', last_message_id: '999' }, a);
  expect(cached()).toMatchObject({ message_revision: '2', last_message_id: null });
});

it('releases absent early activity after a newer authorized list, within its account and guild', async () => {
  for (const [scope, id, guildId] of [[a, '1', '100'], [a, '2', '101'], [b, '1', '100']] as const) {
    state().applyMessageActivity(id, { channel_id: id, guild_id: guildId, revision: '2', last_message_id: null }, scope);
  }
  const pending = delay();
  const load = state().fetchChannels('100', a);
  await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
  pending.finishGuild([], [], '100');
  await load;
  for (const [scope, id, guildId] of [[a, '1', '100'], [a, '2', '101'], [b, '1', '100']] as const) {
    state().addChannel({ ...channel('Metadata', id, guildId), message_revision: '1', last_message_id: '999' }, scope);
  }
  expect(cached()).toMatchObject({ message_revision: '1', last_message_id: '999' });
  expect(cached(a, '2')).toMatchObject({ message_revision: '2', last_message_id: null });
  expect(cached(b)).toMatchObject({ message_revision: '2', last_message_id: null });
});

it('cancels an older list on early-activity overflow without consuming another account capacity', async () => {
  for (let id = 1; id <= 10_000; id++) {
    state().applyMessageActivity(String(id), { channel_id: String(id), guild_id: '100', revision: '2', last_message_id: null }, a);
  }
  const pending = delay();
  const load = state().fetchChannels('100', a);
  await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
  state().applyMessageActivity('10001', { channel_id: '10001', guild_id: '100', revision: '2', last_message_id: null }, a);
  expect(state().loading[entityScopeKey(a, '100')]).toBe(false);
  expect(state().guildChannelsLoaded[entityScopeKey(a, '100')]).toBe(false);
  expect(state().errors[entityScopeKey(a, '100')]).toContain('exceeded');
  state().applyMessageActivity('1', { channel_id: '1', guild_id: '100', revision: '2', last_message_id: null }, b);
  state().addChannel({ ...channel('Other account', '1', '100'), message_revision: '1', last_message_id: '999' }, b);
  expect(cached(b)).toMatchObject({ message_revision: '2', last_message_id: null });
  pending.finishGuild([channel('Old', '1', '100')], ['1'], '100');
  await load;
  expect(cached()).toBeUndefined();
  expect(state().guildChannelsLoaded[entityScopeKey(a, '100')]).toBe(false);
  expect(state().errors[entityScopeKey(a, '100')]).toContain('exceeded');

  // A replacement full list reclaims absent entries and permits new activity.
  const refresh = state().fetchChannels('100', a);
  await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(4));
  pending.finishGuild([], [], '100');
  await refresh;
  expect(state().guildChannelsLoaded[entityScopeKey(a, '100')]).toBe(true);
  expect(state().errors[entityScopeKey(a, '100')]).toBeUndefined();
  state().applyMessageActivity('10002', { channel_id: '10002', guild_id: '100', revision: '2', last_message_id: null }, a);
  state().addChannel({ ...channel('Reconciled', '10002', '100'), message_revision: '1', last_message_id: '999' }, a);
  expect(cached(a, '10002')).toMatchObject({ message_revision: '2', last_message_id: null });
});
