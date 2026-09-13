import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Guild, Member, ReadState, User } from '../types';
const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
import { useChannelStore } from './channelStore';
import { useReadStateStore } from './readStateStore';
import { useGuildStore } from './guildStore';
import { useMemberStore } from './memberStore';
import { useServerListStore } from './serverListStore';
import { useAuthStore } from './authStore';
import { acceptDatabaseHistoryEpoch, clearDatabaseHistoryMemory, DATABASE_HISTORY_HEADER, getDatabaseHistoryEpoch } from '../lib/databaseHistory';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../lib/serverScope';

const a: AccountScope = { serverId: 'a', userId: '42' };
const b: AccountScope = { serverId: 'b', userId: '42' };
const oldHistory = '7257b8f7-610e-4a8b-a20c-5a94a7b98428';
const restoredHistory = '31349d45-0b51-4c83-b41b-49ac76d648ce';
const user = (id: string): User => ({ id, username: `user-${id}`, discriminator: 0, bot: false, system: false, flags: 0, created_at: '2026-01-01' });
const channel = (name: string, id: string, revision?: string, guildId: string | null = 'g'): Channel => ({ id, guild_id: guildId, type: guildId ? 0 : 1, name, position: 0, nsfw: false, created_at: '2026-01-01', ...(revision ? { message_revision: revision } : {}) });
const guild = (id: string, name: string): Guild => ({ id, name, owner_id: '7', member_count: 1, created_at: '2026-01-01' });
const member = (id: string): Member => ({ user: user(id), roles: [], joined_at: '2026-01-01', deaf: false, mute: false });
const rs = (channelId: string, lastMessageId: string, mentions = 0): ReadState => ({ channel_id: channelId, last_message_id: lastMessageId, mention_count: mentions });
const channels = () => useChannelStore.getState();
const readStates = () => useReadStateStore.getState();
const guilds = () => useGuildStore.getState();
const members = () => useMemberStore.getState();
const cached = (scope: AccountScope, id: string) => channels().channelsById[entityScopeKey(scope, id)];
// A healthy server proves the history it served; controlled replies echo the pinned epoch.
const reply = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => {
  const headers = new AxiosHeaders();
  const epoch = AxiosHeaders.from(config.headers).get(DATABASE_HISTORY_HEADER);
  if (typeof epoch === 'string') headers.set(DATABASE_HISTORY_HEADER, epoch);
  return { config, data, headers, status: 200, statusText: 'OK' };
};
function delay(serverId = 'a') {
  const waiting = new Map<string, (data: unknown) => void>();
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => new Promise<AxiosResponse>(resolve => { waiting.set(config.url!, data => resolve(reply(config, data))); }));
  clients.get(serverId)!.defaults.adapter = adapter;
  return {
    adapter,
    finish: (url: string, data: unknown) => waiting.get(url)!(data),
    epochs: () => adapter.mock.calls.map(([config]) => config.headers.get(DATABASE_HISTORY_HEADER)),
  };
}
const finishGuild = (pending: ReturnType<typeof delay>, list: Channel[], guildId: string, visible = list.map(item => item.id)) => {
  pending.finish(`/guilds/${guildId}/channels`, list);
  pending.finish(`/guilds/${guildId}/channels/visible`, { channel_ids: visible });
};
beforeEach(() => {
  localStorage.clear(); clearDatabaseHistoryMemory();
  channels().reset(); readStates().reset(); guilds().reset(); members().reset();
  clients.clear(); useAuthStore.setState({ user: null, token: null });
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, url: `https://${id}.test`, name: id, token: `${id}-token`, userId: '42', user: user('42'), connected: true })) });
  for (const id of ['a', 'b']) clients.set(id, axios.create({ adapter: async config => reply(config, []) }));
});
afterEach(() => {
  channels().reset(); readStates().reset(); guilds().reset(); members().reset();
  localStorage.clear(); clearDatabaseHistoryMemory(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('database history reset across account stores', () => {
  it('replaces the restored account while the peer keeps colliding IDs at revision 9', async () => {
    acceptDatabaseHistoryEpoch(a, oldHistory);
    acceptDatabaseHistoryEpoch(b, oldHistory);
    channels().setChannels('g', [channel('A channel', '1', '9'), channel('A removed', '2', '9')], a);
    channels().setChannels('g', [channel('B channel', '1', '9'), channel('B kept', '2', '9')], b);
    readStates().setAll([rs('1', '900', 2)], a);
    readStates().setAll([rs('1', '900', 4)], b);
    expect(acceptDatabaseHistoryEpoch(a, restoredHistory)).toBe(true);
    expect(cached(a, '1')).toBeUndefined();
    expect(cached(a, '2')).toBeUndefined();
    expect(readStates().getReadState(a, '1')).toBeUndefined();
    expect(cached(b, '1')).toMatchObject({ name: 'B channel', message_revision: '9' });
    expect(cached(b, '2')).toMatchObject({ name: 'B kept', message_revision: '9' });
    expect(readStates().getReadState(b, '1')).toEqual(rs('1', '900', 4));
    expect(getDatabaseHistoryEpoch(a)).toBe(restoredHistory);
    expect(getDatabaseHistoryEpoch(b)).toBe(oldHistory);
    const pending = delay();
    const load = channels().fetchChannels('g', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    expect(pending.epochs()).toEqual([restoredHistory, restoredHistory]);
    finishGuild(pending, [channel('Restored', '1', '2')], 'g');
    await load;
    // The restored snapshot wins: revision 2 must not inherit the discarded revision 9,
    // and a channel absent from the replacement stays cleared.
    expect(cached(a, '1')).toMatchObject({ name: 'Restored', message_revision: '2' });
    expect(cached(a, '2')).toBeUndefined();
    expect(cached(b, '1')).toMatchObject({ name: 'B channel', message_revision: '9' });
  });

  it('clears queued early activity and old snapshot journals with the history', async () => {
    acceptDatabaseHistoryEpoch(a, oldHistory);
    const pending = delay();
    const load = channels().fetchChannels('100', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    channels().applyMessageActivity('1', { channel_id: '1', guild_id: '100', revision: '9', last_message_id: '900' }, a);
    channels().updateChannel({ id: '1', guild_id: '100', name: 'Journaled rename' }, a);
    channels().applyMessageActivity('2', { channel_id: '2', guild_id: '100', revision: '9', last_message_id: '901' }, a);
    expect(acceptDatabaseHistoryEpoch(a, restoredHistory)).toBe(true);
    finishGuild(pending, [channel('Stale', '1', '1', '100'), channel('Stale extra', '2', '1', '100')], '100');
    await load;
    expect(channels().channelsById).toEqual({});
    expect(channels().loading).toEqual({});
    const fresh = delay();
    const reload = channels().fetchChannels('100', a);
    await vi.waitFor(() => expect(fresh.adapter).toHaveBeenCalledTimes(2));
    finishGuild(fresh, [channel('Restored', '1', '2', '100')], '100');
    await reload;
    expect(cached(a, '1')).toMatchObject({ name: 'Restored', message_revision: '2' });
    expect(cached(a, '1')?.last_message_id ?? null).toBeNull();
    // A channel arriving under the new history must not resurrect the discarded queue.
    channels().addChannel(channel('Arrived', '2', '0', '100'), a);
    expect(cached(a, '2')).toMatchObject({ message_revision: '0' });
    expect(cached(a, '2')?.last_message_id ?? null).toBeNull();
  });

  it('late old channel and read-state snapshots can neither repopulate nor clear replacement loading', async () => {
    acceptDatabaseHistoryEpoch(a, oldHistory);
    const old = delay();
    const oldChannelLoad = channels().fetchChannels('g', a);
    const oldReadLoad = readStates().refresh(a);
    const oldReadRejected = expect(oldReadLoad).rejects.toThrow();
    await vi.waitFor(() => expect(old.adapter).toHaveBeenCalledTimes(3));
    expect(old.epochs()).toEqual([oldHistory, oldHistory, oldHistory]);
    readStates().markRead(a, '1', '950');
    expect(acceptDatabaseHistoryEpoch(a, restoredHistory)).toBe(true);
    const fresh = delay();
    const newChannelLoad = channels().fetchChannels('g', a);
    const newReadLoad = readStates().refresh(a);
    await vi.waitFor(() => expect(fresh.adapter).toHaveBeenCalledTimes(3));
    expect(fresh.epochs()).toEqual([restoredHistory, restoredHistory, restoredHistory]);
    finishGuild(old, [channel('Stale', '1', '9')], 'g');
    old.finish('/users/@me/read-states', [rs('1', '900')]);
    await oldChannelLoad;
    await oldReadRejected;
    expect(channels().loading[entityScopeKey(a, 'g')]).toBe(true);
    expect(readStates().loading[accountScopeKey(a)]).toBe(true);
    expect(channels().channelsById).toEqual({});
    expect(readStates().getReadState(a, '1')).toBeUndefined();
    finishGuild(fresh, [channel('Restored', '1', '2')], 'g');
    fresh.finish('/users/@me/read-states', [rs('1', '50')]);
    await newChannelLoad;
    await newReadLoad;
    expect(cached(a, '1')).toMatchObject({ name: 'Restored', message_revision: '2' });
    expect(readStates().getReadState(a, '1')).toEqual(rs('1', '50'));
  });

  it('keeps cache and in-flight snapshots when the same history resumes', async () => {
    acceptDatabaseHistoryEpoch(a, oldHistory);
    channels().setChannels('g', [channel('A channel', '1', '9')], a);
    readStates().setAll([rs('1', '900', 3)], a);
    guilds().setGuilds([guild('g', 'A guild')], a);
    const pending = delay();
    const load = channels().fetchChannels('other', a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    expect(acceptDatabaseHistoryEpoch(a, oldHistory)).toBe(false);
    expect(channels().loading[entityScopeKey(a, 'other')]).toBe(true);
    expect(cached(a, '1')).toMatchObject({ name: 'A channel', message_revision: '9' });
    expect(readStates().getReadState(a, '1')).toEqual(rs('1', '900', 3));
    expect(guilds().guilds.map(entry => entry.name)).toEqual(['A guild']);
    finishGuild(pending, [channel('Other', '2', '2', 'other')], 'other');
    await load;
    expect(cached(a, '2')).toMatchObject({ name: 'Other', message_revision: '2' });
    expect(channels().loading[entityScopeKey(a, 'other')]).toBe(false);
  });

  it('clears guild and member projections only for the restored account', () => {
    acceptDatabaseHistoryEpoch(a, oldHistory);
    acceptDatabaseHistoryEpoch(b, oldHistory);
    guilds().setGuilds([guild('g', 'A guild')], a);
    guilds().setGuilds([guild('g', 'B guild')], b);
    guilds().selectGuild({ id: 'g', scope: a });
    members().addMember('g', member('m1'), a);
    members().addMember('g', member('m1'), b);
    expect(acceptDatabaseHistoryEpoch(a, restoredHistory)).toBe(true);
    expect(guilds().guilds.map(entry => entry.name)).toEqual(['B guild']);
    expect(guilds().selectedGuild).toBeNull();
    expect(members().members.get(entityScopeKey(a, 'g'))).toBeUndefined();
    expect(members().members.get(entityScopeKey(b, 'g'))?.[0].user.id).toBe('m1');
  });
});
