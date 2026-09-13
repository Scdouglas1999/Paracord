import { waitFor } from '@testing-library/react';
import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadStateStore } from './readStateStore';
import { useServerListStore } from './serverListStore';
import { useAuthStore } from './authStore';
import { accountScopeKey, type AccountScope } from '../lib/serverScope';
import { computeGuildUnread } from '../hooks/useUnreadCounts';
import type { Channel, ReadState, User } from '../types';
const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
const a: AccountScope = { serverId: 'a', userId: '42' };
const b: AccountScope = { serverId: 'b', userId: '42' };
const rs = (channelId: string, lastMessageId: string, mentions = 0): ReadState => ({ channel_id: channelId, last_message_id: lastMessageId, mention_count: mentions });
const channel = (id: string, lastMessageId: string | null, type = 0) => ({ id, type, last_message_id: lastMessageId }) as Channel;
const toMap = (states: ReadState[]) => new Map(states.map(value => [value.channel_id, value]));
const store = () => useReadStateStore.getState();
const reply = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
function delay(serverId = 'a') {
  let finish!: (data: unknown) => void;
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => new Promise<AxiosResponse>(resolve => { finish = data => resolve(reply(config, data)); }));
  clients.get(serverId)!.defaults.adapter = adapter;
  return { adapter, finish: (data: unknown) => finish(data) };
}
beforeEach(() => {
  store().reset(); clients.clear(); useAuthStore.setState({ user: null, token: null });
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, url: `https://${id}.test`, name: id, token: 'token', userId: '42', user: { id: '42', username: id } as User, connected: true })) });
  for (const id of ['a', 'b']) clients.set(id, axios.create({ adapter: async config => reply(config, [rs('1', id === 'a' ? '100' : '200')]) }));
});
afterEach(() => { store().reset(); vi.useRealTimers(); vi.restoreAllMocks(); });
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

describe('account-owned read state', () => {
  it('keeps colliding channel and user IDs separate across hosts', async () => {
    await store().refreshAll();
    expect(store().getReadState(a, '1')).toEqual(rs('1', '100'));
    expect(store().getReadState(b, '1')).toEqual(rs('1', '200'));
    store().incrementMention(a, '1'); expect(store().getReadState(a, '1')?.mention_count).toBe(1); expect(store().getReadState(b, '1')?.mention_count).toBe(0);
  });
  it('keeps different accounts on the same host separate', () => {
    const other = { serverId: 'a', userId: '99' };
    store().setAll([rs('1', '100', 2)], a); store().setAll([rs('1', '200', 4)], other);
    store().markRead(other, '1', '300');
    expect(store().getReadState(a, '1')).toEqual(rs('1', '100', 2)); expect(store().getReadState(other, '1')).toEqual(rs('1', '300'));
  });
  it('coalesces only requests owned by the same account', async () => {
    const pending = delay(); const first = store().refresh(a); const second = store().refresh(a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    await store().refresh(b); expect(store().loading[accountScopeKey(a)]).toBe(true);
    pending.finish([rs('1', '100')]); await Promise.all([first, second]); expect(store().loading[accountScopeKey(a)]).toBe(false);
  });
  it('preserves reads and mentions received during a delayed snapshot', async () => {
    store().setAll([rs('1', '100', 2)], a);
    const pending = delay(); const load = store().refresh(a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    store().markRead(a, '1', '200'); store().incrementMention(a, '1'); store().incrementMention(a, '2');
    pending.finish([rs('1', '100', 2)]); await load;
    expect(store().getReadState(a, '1')).toEqual(rs('1', '200', 1)); expect(store().getReadState(a, '2')).toEqual(rs('2', '', 1));
  });
  it('retains a failed account snapshot and reports its error while other hosts update', async () => {
    store().setAll([rs('1', '50')], a);
    clients.get('a')!.defaults.adapter = async () => { throw new Error('offline'); };
    await store().refreshAll();
    expect(store().getReadState(a, '1')).toEqual(rs('1', '50')); expect(store().errors[accountScopeKey(a)]).toContain('offline');
    expect(store().getReadState(b, '1')).toEqual(rs('1', '200'));
  });
  it('lets an explicit refresh caller display its failure', async () => {
    clients.get('a')!.defaults.adapter = async () => { throw new Error('permission revoked'); };
    await expect(store().refresh(a)).rejects.toThrow('permission revoked');
    expect(store().loading[accountScopeKey(a)]).toBe(false);
  });
  it('revokes an old snapshot without clearing replacement request ownership', async () => {
    const old = delay(); const oldLoad = store().refresh(a); const rejected = expect(oldLoad).rejects.toThrow();
    await vi.waitFor(() => expect(old.adapter).toHaveBeenCalledTimes(1));
    await useServerListStore.getState().clearSessions();
    expect(store().loading[accountScopeKey(a)]).toBe(false);
    useServerListStore.getState().updateToken('a', 'new'); useServerListStore.getState().setAuthenticatedUser('a', { id: '42' } as User);
    const fresh = delay(); const load = store().refresh(a);
    await vi.waitFor(() => expect(fresh.adapter).toHaveBeenCalledTimes(1));
    old.finish([rs('1', '100')]); await rejected;
    expect(store().loading[accountScopeKey(a)]).toBe(true); expect(store().getReadState(a, '1')).toBeUndefined();
    fresh.finish([rs('1', '200')]); await load; expect(store().getReadState(a, '1')?.last_message_id).toBe('200');
  });
  it('reset cancels pending snapshots and clears all accounts', async () => {
    const pending = delay(); const load = store().refresh(a); const rejected = expect(load).rejects.toThrow();
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    store().reset(); pending.finish([rs('1', '100')]); await rejected;
    expect(store().byAccount).toEqual({}); expect(store().loading).toEqual({});
  });
  it('coalesces many mutations per channel within the snapshot bound', async () => {
    const pending = delay(); const load = store().refresh(a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 12_000; i++) store().markRead(a, '1', String(i));
    pending.finish([rs('1', '0')]); await load; expect(store().getReadState(a, '1')?.last_message_id).toBe('11999');
  });
  it('captures the account before a read-position debounce', async () => {
    vi.useFakeTimers(); const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => reply(config, rs('1', '100'))); clients.get('a')!.defaults.adapter = adapter;
    const write = store().saveReadPosition(a, '1', '100', { delayMs: 300 }); useServerListStore.getState().setActive('b');
    await vi.advanceTimersByTimeAsync(301); await write;
    expect(adapter.mock.calls[0][0]).toMatchObject({ baseURL: 'https://a.test/api/v1', url: '/channels/1/read', method: 'put', data: '{"last_message_id":"100"}' });
  });
  it('logout cancels a debounced write before a replacement account can use it', async () => {
    vi.useFakeTimers(); const adapter = vi.fn(); clients.get('a')!.defaults.adapter = adapter;
    const write = store().saveReadPosition(a, '1', '100', { delayMs: 300 }); const rejected = expect(write).rejects.toThrow();
    await useServerListStore.getState().clearSessions(); await rejected; await vi.advanceTimersByTimeAsync(301);
    expect(adapter).not.toHaveBeenCalled();
  });
  it('cancels obsolete debounced writes without issuing their request', async () => {
    vi.useFakeTimers(); const adapter = vi.fn(); clients.get('a')!.defaults.adapter = adapter; const controller = new AbortController();
    const write = store().saveReadPosition(a, '1', '100', { delayMs: 300, signal: controller.signal }); const rejected = expect(write).rejects.toThrow();
    controller.abort(); await rejected; await vi.advanceTimersByTimeAsync(301); expect(adapter).not.toHaveBeenCalled();
  });
});

describe('authoritative mention event refresh', () => {
  it('coalesces replayed events and refetches after a snapshot that started before the event', async () => {
    const pending = delay();
    const old = store().refresh(a);
    await waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    store().refreshAfterEvent(a);
    store().refreshAfterEvent(a);
    pending.finish([rs('1', '100', 0)]);
    await old;
    await waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    pending.finish([rs('1', '100', 2)]);
    await waitFor(() => expect(store().getReadState(a, '1')?.mention_count).toBe(2));
    expect(pending.adapter).toHaveBeenCalledTimes(2);
  });

  it('keeps a queued refresh on its original server and stops queued work on reset', async () => {
    const pending = delay();
    store().refreshAfterEvent(a);
    await waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    useServerListStore.setState({ activeServerId: 'b' });
    pending.finish([rs('1', '100', 2)]);
    await waitFor(() => expect(store().getReadState(a, '1')?.mention_count).toBe(2));
    expect(store().getReadState(b, '1')).toBeUndefined();
    store().refreshAfterEvent(a);
    await waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(2));
    store().refreshAfterEvent(a);
    store().reset();
    pending.finish([rs('1', '100', 9)]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(store().getReadState(a, '1')).toBeUndefined();
    expect(pending.adapter).toHaveBeenCalledTimes(2);
  });
});
