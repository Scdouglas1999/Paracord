vi.mock('../lib/messages/accountMessagingRuntime', async () => (await import('../test/messagingRuntimeMock')).messagingRuntimeMock);
import { getTestMessagingRuntime } from '../test/messagingRuntimeMock';
import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessageStore, resetMessageStores, cancelMessageFetch } from './messageStore';
import { useServerListStore } from './serverListStore';
import { useChannelStore } from './channelStore';
import * as storage from '../lib/versionedStorage';
import { getVersionedJson, setVersionedStorageItem } from '../lib/versionedStorage';
import type { Message } from '../types';

const clients = vi.hoisted(() => new Map<string, AxiosInstance>());
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: (serverId: string) => clients.get(serverId) } }));
vi.mock('../lib/secureStorage', () => ({ secureGet: vi.fn(), secureSet: vi.fn(), secureDelete: vi.fn() }));
vi.mock('./toastStore', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
const a = { serverId: 'a', userId: 'viewer' }; const b = { serverId: 'b', userId: 'viewer' };
const msg = (content: string, id = '100'): Message => ({ id, channel_id: 'same', content, author: { id: 'author', username: 'Author', discriminator: '0001' }, tts: false, mention_everyone: false, pinned: false, type: 0, attachments: [], reactions: [] });
const response = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, status: 200, statusText: 'OK', headers: new AxiosHeaders() });
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

beforeEach(() => {
  resetMessageStores(); useChannelStore.getState().reset(); localStorage.clear(); clients.clear();
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, name: id, url: `https://${id}.example`, token: `token-${id}`, userId: 'viewer', user: { id: 'viewer' } as never, connected: true })) });
  for (const scope of [a, b]) {
    clients.set(scope.serverId, axios.create({ baseURL: `https://${scope.serverId}.example/api/v1` }));
    useChannelStore.getState().setChannels('guild', [{ id: 'same', guild_id: 'guild', type: 0, channel_type: 0, name: 'General', position: 0 } as never], scope);
  }
});
afterEach(() => { vi.restoreAllMocks(); resetMessageStores(); useChannelStore.getState().reset(); });

describe('message account ownership', () => {
  it('keeps colliding messages, pins, reaction echoes and author changes inside their account', () => {
    const first = getMessageStore(a); const second = getMessageStore(b);
    first.getState().addMessage('same', msg('A')); second.getState().addMessage('same', msg('B'));
    first.getState().updatePinState('same', '100', true);
    second.getState().handleReactionAdd('same', '100', '👍', 'viewer', 'viewer');
    first.getState().updateUserIdentity({ id: 'author', username: 'Changed on A', discriminator: 1 } as never);
    expect(first.getState().messages.same[0]).toMatchObject({ content: 'A', pinned: true, reactions: [], author: { username: 'Changed on A' } });
    expect(second.getState().messages.same[0]).toMatchObject({ content: 'B', pinned: false, author: { username: 'Author' }, reactions: [{ emoji: '👍', count: 1, me: true }] });
    first.getState().removeMessage('same', '100');
    expect(second.getState().messages.same).toHaveLength(1);
  });

  it('loads histories independently while selection changes and each receives gateway edits', async () => {
    const startedA = latch(); const startedB = latch(); const finishA = latch(); const finishB = latch();
    clients.get('a')!.defaults.adapter = async config => { startedA.release(); await finishA.promise; return response(config, [msg('Old A')]); };
    clients.get('b')!.defaults.adapter = async config => { startedB.release(); await finishB.promise; return response(config, [msg('Old B')]); };
    const first = getMessageStore(a); const second = getMessageStore(b);
    const requestA = first.getState().fetchMessages('same'); const requestB = second.getState().fetchMessages('same');
    await Promise.all([startedA.promise, startedB.promise]);
    useServerListStore.getState().setActive('b');
    first.getState().updateMessage('same', { id: '100', content: 'New A' });
    second.getState().updateMessage('same', { id: '100', content: 'New B' });
    finishB.release(); await requestB;
    expect(first.getState().loading.same).toBe(true);
    finishA.release(); await requestA;
    expect(first.getState().messages.same[0].content).toBe('New A');
    expect(second.getState().messages.same[0].content).toBe('New B');
  });

  it('accepts in its captured runtime and projects receipts only to that account after selection changes', async () => {
    const first = getMessageStore(a); const second = getMessageStore(b);
    await first.getState().sendMessage('same', 'Sent to A');
    useServerListStore.getState().setActive('b');
    expect(getTestMessagingRuntime(a).send).toHaveBeenCalledWith('same', 'Sent to A', undefined, undefined, undefined, undefined, undefined);
    getTestMessagingRuntime(a).emit({ kind: 'create', message: msg('Sent to A') });
    expect(first.getState().messages.same[0].content).toBe('Sent to A');
    expect(second.getState().messages).toEqual({});
  });

  it('revokes old account state and prevents a late history from populating its replacement', async () => {
    const started = latch(); const finish = latch();
    clients.get('a')!.defaults.adapter = async config => { started.release(); await finish.promise; return response(config, [msg('Old account')]); };
    const first = getMessageStore(a); first.getState().addMessage('same', msg('Cached old account'));
    const history = first.getState().fetchMessages('same'); await started.promise;
    useServerListStore.setState(state => ({ servers: state.servers.map(server => server.id === 'a' ? { ...server, token: 'replacement', userId: 'next', user: { id: 'next' } as never } : server) }));
    const replacement = getMessageStore({ serverId: 'a', userId: 'next' });
    expect(first.getState().messages).toEqual({}); expect(first.getState().loading).toEqual({});
    finish.release(); await history;
    expect(replacement.getState().messages).toEqual({}); expect(first.getState().messages).toEqual({});
  });

  it('makes retained callbacks inert after account revocation', async () => {
    const store = getMessageStore(a);
    const callbacks = store.getState();
    callbacks.addMessage('same', msg('Before logout'));
    useServerListStore.getState().updateToken('a', '');
    callbacks.addMessage('same', msg('Late event'));
    callbacks.setMessages('same', [msg('Late snapshot')]);
    expect(store.getState().messages).toEqual({});
    await expect(callbacks.sendMessage('same', 'Late send')).rejects.toThrow(/session has ended/);
  });

  it('does not project a late runtime receipt after account revocation', async () => {
    const store = getMessageStore(a);
    await store.getState().sendMessage('same', 'Keep this draft');
    useServerListStore.getState().updateToken('a', '');
    getTestMessagingRuntime(a).emit({ kind: 'create', message: msg('Late response') });
    expect(store.getState().messages).toEqual({});
  });

  it('rejects encrypted acceptance failure instead of accepting an unsaved draft', async () => {
    const store = getMessageStore(a);
    getTestMessagingRuntime(a).send.mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'));
    await expect(store.getState().sendMessage('same', 'Keep this draft')).rejects.toThrow('Quota exceeded');
    expect(store.getState().offlineQueue).toEqual([]);
  });

  it('does not replace an unreadable existing queue when a new send fails', async () => {
    setVersionedStorageItem('offline-message-queue', '{incomplete backup');
    getTestMessagingRuntime(a).send.mockRejectedValueOnce(new Error('Recover unreadable legacy queue'));
    await expect(getMessageStore(a).getState().sendMessage('same', 'New draft')).rejects.toThrow();
    expect(storage.getVersionedStorageItem('offline-message-queue')).toBe('{incomplete backup');
  });

  it('does not send legacy queue records through the retired plaintext writer', async () => {
    const queued = { id: 'saved', scope: a, channelId: 'same', content: 'Keep this draft', nonce: 'original', createdAt: '' };
    setVersionedStorageItem('offline-message-queue', JSON.stringify([queued]));
    const adapter = vi.fn(); clients.get('a')!.defaults.adapter = adapter;
    const store = getMessageStore(a);
    await store.getState().flushOfflineQueue();
    expect(store.getState().offlineQueue).toEqual([]);
    expect(adapter).not.toHaveBeenCalled();
    expect(getTestMessagingRuntime(a).reconcile).toHaveBeenCalled();
    expect(getVersionedJson('offline-message-queue', [])).toEqual([queued]);
  });

  it('cancellation releases loading immediately and cannot clear a replacement request', async () => {
    const started = latch(); const finishOld = latch(); const finishNew = latch(); let calls = 0;
    clients.get('a')!.defaults.adapter = async config => { if (++calls === 1) { started.release(); await finishOld.promise; return response(config, [msg('Old')]); } await finishNew.promise; return response(config, [msg('New')]); };
    const store = getMessageStore(a);
    const old = store.getState().fetchMessages('same'); await started.promise;
    cancelMessageFetch(a, 'same'); expect(store.getState().loading.same).toBe(false);
    const next = store.getState().fetchMessages('same');
    finishOld.release(); await old; expect(store.getState().loading.same).toBe(true);
    finishNew.release(); await next; expect(store.getState().messages.same[0].content).toBe('New');
  });

  it('retains unowned legacy drafts without assigning them to either account', () => {
    const legacy = { id: 'old-draft', channelId: 'same', content: 'Unknown owner', nonce: 'old', createdAt: '' };
    setVersionedStorageItem('offline-message-queue', JSON.stringify([legacy]));
    expect(getMessageStore(a).getState().offlineQueue).toEqual([]);
    expect(getMessageStore(b).getState().offlineQueue).toEqual([]);
    expect(getVersionedJson('offline-message-queue', [])).toEqual([legacy]);
  });
});


it('rejects unknown channel metadata before a plaintext request can be constructed', async () => {
  const adapter = vi.fn(); clients.get('a')!.defaults.adapter = adapter;
  getTestMessagingRuntime(a).send.mockRejectedValueOnce(new Error('Load this conversation before sending.'));
  await expect(getMessageStore(a).getState().sendMessage('not-loaded', 'Private draft')).rejects.toThrow(/Load this conversation/);
  expect(adapter).not.toHaveBeenCalled();
});
