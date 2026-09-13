import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, User } from '../types';

const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
import { useServerListStore } from './serverListStore';
import { useMemberStore } from './memberStore';
import { entityScopeKey, type AccountScope } from '../lib/serverScope';

const a: AccountScope = { serverId: 'a', userId: '42' };
const b: AccountScope = { serverId: 'b', userId: '42' };
const key = (scope = a) => entityScopeKey(scope, '1');
const member = (username: string, id = '7'): Member => ({
  user: { id, username, public_key: `${username}-key` }, roles: ['member'], joined_at: '2026-01-01',
}) as Member;
const reply = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
function delaySnapshot(serverId = 'a') {
  let finish!: (members: Member[]) => void;
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => new Promise<AxiosResponse>(resolve => {
    finish = members => resolve(reply(config, members));
  }));
  clients.get(serverId)!.defaults.adapter = adapter;
  return { adapter, finish: (members: Member[]) => finish(members) };
}

beforeEach(() => {
  useMemberStore.getState().reset();
  clients.clear();
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({
    id, url: `https://${id}.test`, name: id, connected: true, token: `${id}-token`, userId: '42', user: { id: '42', username: id } as User,
  })) });
  for (const id of ['a', 'b']) clients.set(id, axios.create({ adapter: async config => reply(config, [member(id)]) }));
});
afterEach(() => useMemberStore.getState().reset());

describe('member cache account ownership', () => {
  it('keeps colliding server, guild and member IDs separate for snapshots and events', async () => {
    await Promise.all([useMemberStore.getState().fetchMembers('1', a), useMemberStore.getState().fetchMembers('1', b)]);
    useMemberStore.getState().updateUserIdentity({ id: '7', username: 'renamed-a' } as User, a);
    expect(useMemberStore.getState().members.get(key(a))![0].user.username).toBe('renamed-a');
    expect(useMemberStore.getState().members.get(key(b))![0].user.username).toBe('b');
    useMemberStore.getState().removeMember('1', '7', a);
    expect(useMemberStore.getState().members.get(key(a))).toEqual([]);
    expect(useMemberStore.getState().members.get(key(b))).toHaveLength(1);
  });

  it('keeps an in-flight request on the originating account after switching servers', async () => {
    const snapshot = delaySnapshot();
    const pending = useMemberStore.getState().fetchMembers('1', a);
    useServerListStore.getState().setActive('b');
    await vi.waitFor(() => expect(snapshot.adapter).toHaveBeenCalledTimes(1));
    expect(snapshot.adapter.mock.calls[0][0]).toMatchObject({ baseURL: 'https://a.test/api/v1', url: '/guilds/1/members' });
    snapshot.finish([member('a')]);
    await pending;
    expect(useMemberStore.getState().members.get(key(a))![0].user.username).toBe('a');
    expect(useMemberStore.getState().members.has(key(b))).toBe(false);
  });

  it('does not request data for an old account after the server signs in a different user', async () => {
    const snapshot = delaySnapshot();
    useServerListStore.getState().setAuthenticatedUser('a', { id: 'new', username: 'new' } as User);
    await useMemberStore.getState().fetchMembers('1', a);
    expect(snapshot.adapter).not.toHaveBeenCalled();
    expect(useMemberStore.getState().members.size).toBe(0);
  });

  it('cannot repopulate after reset or clear a replacement request loading state', async () => {
    const old = delaySnapshot();
    const oldFetch = useMemberStore.getState().fetchMembers('1', a);
    await vi.waitFor(() => expect(old.adapter).toHaveBeenCalledTimes(1));
    useMemberStore.getState().reset();
    const fresh = delaySnapshot();
    const freshFetch = useMemberStore.getState().fetchMembers('1', a);
    await vi.waitFor(() => expect(fresh.adapter).toHaveBeenCalledTimes(1));
    old.finish([member('old')]);
    await oldFetch;
    expect(useMemberStore.getState().members.size).toBe(0);
    expect(useMemberStore.getState().loading[key()]).toBe(true);
    fresh.finish([member('fresh')]);
    await freshFetch;
    expect(useMemberStore.getState().members.get(key())![0].user.username).toBe('fresh');
  });

  it('rejects a late result after credentials are revoked', async () => {
    const snapshot = delaySnapshot();
    const pending = useMemberStore.getState().fetchMembers('1', a);
    await vi.waitFor(() => expect(snapshot.adapter).toHaveBeenCalledTimes(1));
    await useServerListStore.getState().clearSessions();
    snapshot.finish([member('old')]);
    await pending;
    expect(useMemberStore.getState().members.size).toBe(0);
  });

  it('reconciles membership, role and identity events over a delayed snapshot', async () => {
    const snapshot = delaySnapshot();
    const pending = useMemberStore.getState().fetchMembers('1', a);
    await vi.waitFor(() => expect(snapshot.adapter).toHaveBeenCalledTimes(1));
    const store = useMemberStore.getState();
    store.removeMember('1', 'removed', a);
    store.updateMember('1', { user: { id: '7' }, roles: ['new-role'] }, a);
    store.updateUserIdentity({ id: '7', username: 'new-name' } as User, a);
    store.addMember('1', member('new-arrival', '8'), a);
    snapshot.finish([member('old'), member('removed', 'removed')]);
    await pending;
    const result = useMemberStore.getState().members.get(key())!;
    expect(result.map(entry => entry.user.id)).toEqual(['7', '8']);
    expect(result[0]).toMatchObject({ roles: ['new-role'], user: { username: 'new-name', public_key: 'old-key' } });
  });

  it('coalesces repeated patches without losing earlier changed fields or growing a call stack', async () => {
    const snapshot = delaySnapshot();
    const pending = useMemberStore.getState().fetchMembers('1', a);
    await vi.waitFor(() => expect(snapshot.adapter).toHaveBeenCalledTimes(1));
    useMemberStore.getState().updateMember('1', { user: { id: '7' }, roles: ['revoked'] }, a);
    for (let index = 0; index < 12_000; index++) {
      useMemberStore.getState().updateMember('1', { user: { id: '7' }, nick: `nick-${index}` }, a);
    }
    snapshot.finish([member('name')]);
    await pending;
    expect(useMemberStore.getState().members.get(key())![0]).toMatchObject({ roles: ['revoked'], nick: 'nick-11999' });
  });
  it('allows the next session to fetch even if the revoked transport has not settled', async () => {
    const old = delaySnapshot();
    const oldFetch = useMemberStore.getState().fetchMembers('1', a);
    await vi.waitFor(() => expect(old.adapter).toHaveBeenCalledTimes(1));
    await useServerListStore.getState().clearSessions();
    useServerListStore.getState().updateToken('a', 'fresh-token');
    useServerListStore.getState().setAuthenticatedUser('a', { id: '42', username: 'a' } as User);
    const fresh = delaySnapshot();
    const freshFetch = useMemberStore.getState().fetchMembers('1', a);
    await vi.waitFor(() => expect(fresh.adapter).toHaveBeenCalledTimes(1));
    fresh.finish([member('fresh')]);
    await freshFetch;
    old.finish([member('old')]);
    await oldFetch;
    expect(useMemberStore.getState().members.get(key())![0].user.username).toBe('fresh');
  });

  it('cancels an overflowing snapshot without publishing its stale members', async () => {
    const snapshot = delaySnapshot();
    const pending = useMemberStore.getState().fetchMembers('1', a);
    await vi.waitFor(() => expect(snapshot.adapter).toHaveBeenCalledTimes(1));
    for (let index = 0; index <= 10_000; index++) {
      useMemberStore.getState().updateMember('1', { user: { id: String(index) }, roles: [] }, a);
    }
    expect(useMemberStore.getState().loading[key()]).toBe(false);
    expect(useMemberStore.getState().membersLoaded[key()]).toBe(false);
    snapshot.finish([member('stale')]);
    await pending;
    expect(useMemberStore.getState().members.get(key())).toEqual([]);
  });

});
