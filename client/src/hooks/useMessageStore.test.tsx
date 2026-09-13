import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useCurrentMessageStore, useAccountMessageStore } from './useMessageStore';
import { getMessageStore, resetMessageStores } from '../stores/messageStore';
import { useServerListStore } from '../stores/serverListStore';
import type { Message } from '../types';

const a = { serverId: 'a', userId: 'viewer' }; const b = { serverId: 'b', userId: 'viewer' };
beforeEach(() => {
  resetMessageStores();
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, url: `https://${id}.test`, name: id, token: 'token', userId: 'viewer', user: { id: 'viewer' } as never, connected: true })) });
  for (const scope of [a, b]) getMessageStore(scope).getState().setMessages('same', [{ id: '100', channel_id: 'same', content: scope.serverId } as Message]);
});
afterEach(resetMessageStores);

it('switches a mounted timeline immediately between colliding channel IDs', () => {
  const view = renderHook(() => useCurrentMessageStore(state => state.messages.same));
  expect(view.result.current[0].content).toBe('a');
  act(() => { useServerListStore.getState().setActive('b'); });
  expect(view.result.current[0].content).toBe('b');
});

it('reads background previews from their represented account and clears them on revocation', () => {
  const view = renderHook(() => useAccountMessageStore(b, state => state.messages.same));
  expect(view.result.current[0].content).toBe('b');
  act(() => { useServerListStore.getState().updateToken('b', ''); });
  expect(view.result.current).toBeUndefined();
  expect(getMessageStore(a).getState().messages.same[0].content).toBe('a');
});

it('never carries a timeline into another account on the same server', () => {
  const view = renderHook(() => useCurrentMessageStore(state => state.messages.same));
  act(() => { useServerListStore.setState(state => ({ servers: state.servers.map(server => server.id === 'a' ? { ...server, userId: 'next', user: { id: 'next' } as never } : server) })); });
  expect(view.result.current).toBeUndefined();
});
