import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationActions } from './useConversationActions';
import { CONVERSATION_ACTIONS, type ConversationCapabilities } from '../lib/conversationActions';

const mock = vi.hoisted(() => ({
  scope: { serverId: 'a', userId: '42' },
  capture: vi.fn(),
  account: { isUnlocked: true, publicKey: 'identity' },
}));
vi.mock('./useCurrentUser', () => ({ useCurrentAccountScope: () => mock.scope, useCurrentUser: () => ({ id: mock.scope.userId, public_key: 'identity' }) }));
vi.mock('../stores/accountStore', () => ({ useAccountStore: (selector: (state: typeof mock.account) => unknown) => selector(mock.account) }));
vi.mock('../lib/operationContext', () => ({ captureScopedOperation: mock.capture }));
vi.mock('../lib/tauriEnv', () => ({ isTauri: () => false }));

function response(channel = '1', user = '42'): { data: ConversationCapabilities } {
  return { data: { version: 1, channel_id: channel, user_id: user, encrypted: false, own_identity_enrolled: true, peers_ready: true,
    actions: Object.fromEntries(CONVERSATION_ACTIONS.map(action => [action, { supported: true, allowed: true, reason: null }])) as ConversationCapabilities['actions'] } };
}
function operation() {
  const controller = new AbortController();
  let resolve!: (value: ReturnType<typeof response>) => void;
  let reject!: (reason: Error) => void;
  const pending = new Promise<ReturnType<typeof response>>((yes, no) => { resolve = yes; reject = no; });
  const context = {
    signal: controller.signal,
    request: vi.fn(() => pending),
    assertCurrent: vi.fn(() => { if (controller.signal.aborted) throw new Error('Revoked'); }),
    dispose: vi.fn(() => controller.abort()),
  };
  mock.capture.mockReturnValueOnce(context);
  return { context, controller, resolve, reject };
}
beforeEach(() => { vi.clearAllMocks(); mock.scope = { serverId: 'a', userId: '42' }; });

describe('conversation action ownership and refresh', () => {
  it('fails closed until an authenticated matching response arrives', async () => {
    const request = operation();
    const { result } = renderHook(() => useConversationActions('1'));
    expect(result.current.actions.send.allowed).toBe(false);
    expect(result.current.loading).toBe(true);
    await act(async () => request.resolve(response()));
    expect(result.current.actions.send.allowed).toBe(true);
    expect(request.context.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/channels/1/capabilities' }));
  });
  it('ignores the previous channel response after navigation', async () => {
    const old = operation(); const next = operation();
    const { result, rerender } = renderHook(({ channel }) => useConversationActions(channel), { initialProps: { channel: '1' } });
    rerender({ channel: '2' });
    expect(old.context.dispose).toHaveBeenCalled();
    await act(async () => old.resolve(response()));
    expect(result.current.actions.send.allowed).toBe(false);
    await act(async () => next.resolve(response('2')));
    expect(result.current.actions.send.allowed).toBe(true);
  });
  it('does not carry permission across servers with colliding channel and user IDs', async () => {
    const old = operation(); const next = operation();
    const { result, rerender } = renderHook(() => useConversationActions('1'));
    await act(async () => old.resolve(response()));
    mock.scope = { serverId: 'b', userId: '42' };
    rerender();
    expect(result.current.actions.send.allowed).toBe(false);
    expect(mock.capture).toHaveBeenLastCalledWith(mock.scope);
    await act(async () => next.resolve(response()));
    expect(result.current.actions.send.allowed).toBe(true);
  });
  it('cannot be re-enabled by an HTTP result arriving after account revocation', async () => {
    const request = operation();
    const { result } = renderHook(() => useConversationActions('1'));
    act(() => request.controller.abort());
    expect(result.current.error).toContain('Sign in');
    await act(async () => request.resolve(response()));
    expect(result.current.actions.send.allowed).toBe(false);
    expect(result.current.error).toContain('Sign in');
  });
  it('rejects capabilities naming a different account and supports explicit retry', async () => {
    const request = operation(); const retry = operation();
    const { result } = renderHook(() => useConversationActions('1'));
    await act(async () => request.resolve(response('1', 'someone-else')));
    expect(result.current.actions.send.allowed).toBe(false);
    expect(result.current.error).toContain('could not be checked');
    act(() => result.current.refresh());
    await act(async () => retry.resolve(response()));
    expect(result.current.actions.send.allowed).toBe(true);
  });
  it('invalidates an allowed action when a permission event arrives', async () => {
    const request = operation(); const refresh = operation();
    const { result } = renderHook(() => useConversationActions('1'));
    await act(async () => request.resolve(response()));
    act(() => window.dispatchEvent(new CustomEvent('paracord:roles-changed')));
    expect(result.current.actions.send.allowed).toBe(false);
    const revoked = response();
    revoked.data.actions.send = { supported: true, allowed: false, reason: 'Permission removed.' };
    await act(async () => refresh.resolve(revoked));
    expect(result.current.actions.send.reason).toBe('Permission removed.');
  });
  it('reports server unavailability without preserving the previous permission', async () => {
    const request = operation();
    const { result } = renderHook(() => useConversationActions('1'));
    await act(async () => request.reject(new Error('Offline')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('server is available');
    expect(result.current.actions.send.allowed).toBe(false);
  });
});
