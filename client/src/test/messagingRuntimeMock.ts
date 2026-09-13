import { vi } from 'vitest';
import type { Message } from '../types';
import type { AccountScope } from '../lib/serverScope';
import type { AccountMessagingRuntime, RuntimeMessageEvent } from '../lib/messages/accountMessagingRuntime';

/** Store/dispatch boundary fake. Vault/crypto/transport behavior has separate tests. */
function runtime() {
  const listeners = new Set<(event: RuntimeMessageEvent) => void>();
  const knownMessageReaders = new Set<() => Message[]>();
  return {
    send: vi.fn<AccountMessagingRuntime['send']>(async () => {}),
    decrypt: vi.fn<AccountMessagingRuntime['decrypt']>(async () => { throw new Error('Identity locked'); }),
    reconcile: vi.fn(async () => {}),
    prepareChannelHistory: vi.fn<AccountMessagingRuntime['prepareChannelHistory']>(async () => {}),
    acceptHandshake: vi.fn<AccountMessagingRuntime['acceptHandshake']>(async () => {}),
    captureGatewayLease: vi.fn<AccountMessagingRuntime['captureGatewayLease']>(() => ({ signal: new AbortController().signal, assertCurrent: () => {} })),
    // The boundary fake treats the normalized gateway message as authoritative.
    // Tests that need vault arbitration (drops, ordered stalls, rejections)
    // stub this per call.
    acceptGatewayMutation: vi.fn<AccountMessagingRuntime['acceptGatewayMutation']>(async (input) => input.message ?? null),
    filterDeletedMessages: vi.fn(async (messages: Message[]) => messages),
    editMessage: vi.fn(async (_message: Message, _content: string) => {}),
    deleteMessage: vi.fn(async (_message: Message) => {}),
    observeDeleted: vi.fn(async (_channelId: string, _messageId: string) => {}),
    ingestEncryptedMessage: vi.fn(async (_message: Message) => {}),
    pauseForRecovery: vi.fn(() => {}),
    registerKnownMessages(read: () => Message[]) { knownMessageReaders.add(read); return () => knownMessageReaders.delete(read); },
    subscribeMessages(listener: (event: RuntimeMessageEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event: RuntimeMessageEvent) { for (const listener of listeners) listener(event); },
  };
}
const runtimes = new Map<string, ReturnType<typeof runtime>>();
export function getTestMessagingRuntime(scope: AccountScope) {
  const key = JSON.stringify([scope.serverId, scope.userId]);
  let value = runtimes.get(key);
  if (!value) { value = runtime(); runtimes.set(key, value); }
  return value;
}
export const messagingRuntimeMock = {
  getAccountMessagingRuntime: getTestMessagingRuntime,
  pauseAccountMessagingForRecovery: (scope: AccountScope) => { getTestMessagingRuntime(scope).pauseForRecovery(); },
  resetAccountMessagingRuntimes: vi.fn(),
  reconcileAccountMessaging: vi.fn(),
  startAccountMessagingLifecycle: vi.fn(() => () => {}),
};
