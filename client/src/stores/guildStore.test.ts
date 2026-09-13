import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild, User } from '../types';
const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.get(id) } }));
vi.mock('../lib/secureStorage', () => ({ secureSet: vi.fn(), secureDelete: vi.fn(), secureGet: vi.fn() }));
import { useGuildStore, scopeGuild } from './guildStore';
import { guildDetailFixture } from '../test/guildContractFixtures';
import { useServerListStore } from './serverListStore';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../lib/serverScope';
import { toast } from './toastStore';
const a: AccountScope = { serverId: 'a', userId: '42' };
const b: AccountScope = { serverId: 'b', userId: '42' };
const guild = (name = 'A', id = '1'): Guild => guildDetailFixture({ id, name, owner_id: '42', member_count: 10 });
const reply = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
const snapshot = () => useGuildStore.getState();
const cached = (scope = a, id = '1') => snapshot().guilds.find(entry => entry.key === entityScopeKey(scope, id));
function delay(serverId = 'a') {
  let finish!: (data: unknown) => void;
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => new Promise<AxiosResponse>(resolve => { finish = data => resolve(reply(config, data)); }));
  clients.get(serverId)!.defaults.adapter = adapter;
  return { adapter, finish: (data: unknown) => finish(data) };
}
beforeEach(() => {
  snapshot().reset(); clients.clear();
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({
    id, url: `https://${id}.test`, name: id, token: `${id}-token`, userId: '42', user: { id: '42', username: id } as User, connected: true,
  })) });
  for (const id of ['a', 'b']) clients.set(id, axios.create({ adapter: async config => reply(config, [guild(id)]) }));
});
afterEach(() => { snapshot().reset(); vi.restoreAllMocks(); });

describe('guild account ownership', () => {
  it('starts empty and clears selection and loading on reset', () => {
    expect(snapshot().guilds).toEqual([]);
    expect(snapshot().selectedGuild).toBeNull();
    expect(snapshot().loading).toEqual({});
  });
  it('fetches independently for colliding user and guild IDs', async () => {
    await Promise.all([snapshot().fetchGuilds(a), snapshot().fetchGuilds(b)]);
    expect(cached(a)?.name).toBe('a'); expect(cached(b)?.name).toBe('b');
    expect(snapshot().guilds).toHaveLength(2);
  });
  it('coalesces requests and clears only the owning loading marker', async () => {
    const pending = delay(); const first = snapshot().fetchGuilds(a); const second = snapshot().fetchGuilds(a);
    expect(snapshot().loading[accountScopeKey(a)]).toBe(true);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    pending.finish([guild()]); await Promise.all([first, second]);
    expect(snapshot().loading[accountScopeKey(a)]).toBe(false);
  });
  it('reports a fetch failure without replacing cached buildings', async () => {
    snapshot().addGuild(guild(), a);
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 'toast');
    clients.get('a')!.defaults.adapter = async () => { throw new Error('offline'); };
    await snapshot().fetchGuilds(a);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('offline'));
    expect(cached()?.name).toBe('A');
  });
  it('rejects a malformed HTTP snapshot without replacing valid cached buildings', async () => {
    snapshot().addGuild(guild('Cached'), a);
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 'toast');
    clients.get('a')!.defaults.adapter = async config => reply(config, [
      { ...guild('Invalid'), member_count: undefined },
    ]);
    await snapshot().fetchGuilds(a);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('invalid GuildSummaryList'));
    expect(cached()?.name).toBe('Cached');
    expect(snapshot().loading[accountScopeKey(a)]).toBe(false);
  });
  it('sets snapshots for one account without replacing another account', () => {
    snapshot().setGuilds([guild('A')], a); snapshot().setGuilds([guild('B')], b);
    snapshot().setGuilds([], a);
    expect(snapshot().guilds.map(entry => entry.name)).toEqual(['B']);
  });
  it('stamps transport ownership instead of trusting forged origin fields', () => {
    snapshot().addGuild({ ...guild(), originServerId: 'b', server_url: 'https://evil.test' }, a);
    expect(cached()).toMatchObject({ originServerId: 'a', server_url: 'https://a.test/api/v1', scope: a });
  });
  it('upserts a gateway guild within its own account', () => {
    snapshot().addGuild(guild(), a); snapshot().addGuild(guild('B'), b); snapshot().addGuild(guild('Renamed'), a);
    expect(snapshot().guilds).toHaveLength(2); expect(cached()?.name).toBe('Renamed'); expect(cached(b)?.name).toBe('B');
  });
  it('merges partial changes while retaining origin and unaffected fields', () => {
    snapshot().addGuild(guild(), a); snapshot().updateGuildData('1', { name: 'Renamed', originServerId: 'b' }, a);
    expect(cached()).toMatchObject({ name: 'Renamed', owner_id: '42', originServerId: 'a' });
  });
  it('keeps a colliding selection when another server removes the same ID', () => {
    snapshot().addGuild(guild(), a); snapshot().addGuild(guild('B'), b);
    snapshot().selectGuild({ id: '1', scope: b }); snapshot().removeGuild('1', a);
    expect(snapshot().selectedGuild).toEqual({ id: '1', scope: b });
    snapshot().removeGuild('1', b); expect(snapshot().selectedGuild).toBeNull();
  });
  it('can clear selection explicitly', () => {
    snapshot().selectGuild({ id: '1', scope: a }); snapshot().selectGuild(null);
    expect(snapshot().selectedGuild).toBeNull();
  });
  it('removes a selection no longer present in its authoritative snapshot', () => {
    snapshot().selectGuild({ id: '1', scope: a }); snapshot().setGuilds([], a);
    expect(snapshot().selectedGuild).toBeNull();
  });
  it('creates with an icon on the captured server after selection changes', async () => {
    const pending = delay(); const create = snapshot().createGuild('Created', a, 'icon-data');
    useServerListStore.getState().setActive('b');
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    expect(pending.adapter.mock.calls[0][0]).toMatchObject({ baseURL: 'https://a.test/api/v1', url: '/guilds', data: JSON.stringify({ name: 'Created', icon: 'icon-data' }) });
    pending.finish(guild('Created')); expect(await create).toMatchObject({ name: 'Created', scope: a });
    expect(cached(b)).toBeUndefined();
  });
  it('updates only the account captured for the mutation', async () => {
    snapshot().addGuild(guild('A'), a); snapshot().addGuild(guild('B'), b);
    const pending = delay(); const update = snapshot().updateGuild('1', { name: 'Updated' }, a);
    useServerListStore.getState().setActive('b');
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    pending.finish(guild('Updated')); await update;
    expect(cached()?.name).toBe('Updated'); expect(cached(b)?.name).toBe('B');
  });
  it.each(['deleteGuild', 'leaveGuild'] as const)('%s removes only its own guild', async action => {
    snapshot().addGuild(guild(), a); snapshot().addGuild(guild('B'), b);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => reply(config, {})); clients.get('a')!.defaults.adapter = adapter;
    await snapshot()[action]('1', a);
    expect(cached()).toBeUndefined(); expect(cached(b)?.name).toBe('B');
    expect(adapter.mock.calls[0][0].url).toBe(action === 'deleteGuild' ? '/guilds/1' : '/guilds/1/members/@me');
  });
  it('preserves gateway updates, additions and removals over an older snapshot', async () => {
    const pending = delay(); const load = snapshot().fetchGuilds(a);
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    snapshot().updateGuildData('1', { name: 'New name', owner_id: 'new-owner' }, a);
    snapshot().removeGuild('removed', a); snapshot().addGuild(guild('New', 'new'), a);
    pending.finish([guild('Old'), guild('Removed', 'removed')]); await load;
    expect(cached()).toMatchObject({ name: 'New name', owner_id: 'new-owner' });
    expect(cached(a, 'removed')).toBeUndefined(); expect(cached(a, 'new')?.name).toBe('New');
  });
  it('does not repopulate after reset, including a delayed create response', async () => {
    const pending = delay(); const create = snapshot().createGuild('Created', a);
    const rejected = expect(create).rejects.toThrow();
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    snapshot().reset(); pending.finish(guild('Created')); await rejected;
    expect(snapshot().guilds).toEqual([]);
  });
  it('does not let a logged-out snapshot clear replacement loading', async () => {
    const old = delay(); const oldLoad = snapshot().fetchGuilds(a);
    await vi.waitFor(() => expect(old.adapter).toHaveBeenCalledTimes(1));
    await useServerListStore.getState().clearSessions();
    useServerListStore.getState().updateToken('a', 'new-token'); useServerListStore.getState().setAuthenticatedUser('a', { id: '42', username: 'new' } as User);
    const fresh = delay(); const freshLoad = snapshot().fetchGuilds(a);
    await vi.waitFor(() => expect(fresh.adapter).toHaveBeenCalledTimes(1));
    old.finish([guild('Old')]); await oldLoad;
    expect(snapshot().loading[accountScopeKey(a)]).toBe(true); expect(cached()).toBeUndefined();
    fresh.finish([guild('Fresh')]); await freshLoad; expect(cached()?.name).toBe('Fresh');
  });
  it.each(['applyTemplate', 'joinPublic', 'acceptInvite'] as const)('%s retains the original account through the response', async action => {
    const pending = delay();
    const result = action === 'applyTemplate' ? snapshot().applyTemplate('template', 'Created', a) : action === 'joinPublic' ? snapshot().joinPublic('1', a) : snapshot().acceptInvite('invite', a);
    useServerListStore.getState().setActive('b');
    await vi.waitFor(() => expect(pending.adapter).toHaveBeenCalledTimes(1));
    pending.finish(action === 'acceptInvite' ? { guild: { ...guild('Joined'), default_channel_id: null } } : guild('Joined'));
    expect(await result).toMatchObject({ scope: a }); expect(cached(b)).toBeUndefined();
  });
  it('returns a reference distinct from the server payload', () => {
    const source = guild(); const scoped = scopeGuild(source, a);
    expect(scoped.key).toBe(entityScopeKey(a, source.id)); expect('scope' in source).toBe(false);
  });
});
