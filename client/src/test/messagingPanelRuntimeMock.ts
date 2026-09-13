import { createStore, type StoreApi } from 'zustand/vanilla';
import { vi } from 'vitest';
import type {
  AccountMessagingRuntime,
  MessagingSnapshot,
  RuntimeMutationRow,
  RuntimeQueueRow,
} from '../lib/messages/accountMessagingRuntime';
import type { DurableIntent, DurableSend } from '../lib/messages/durableOutbox';
import type { DeliveredMutation } from '../lib/messages/deliveredMutations';
import type { RecoveryDraft } from '../lib/messages/legacyRecovery';

/**
 * Persistence-boundary fake for the queue/recovery panel components. The store
 * is a real zustand store so useStore subscriptions behave exactly like the
 * production runtime; every action that would touch the vault or IndexedDB is
 * a vi.fn so tests assert the exact records crossing the boundary.
 */
export function queuedIntentRow(overrides: Partial<DurableIntent> = {}): RuntimeQueueRow {
  return {
    source: 'local',
    record: {
      id: 'intent-1',
      nonce: 'nonce-1',
      sequence: 1,
      channelId: 'chan-1',
      draft: { content: 'queued body' },
      revision: 'rev-1',
      intent: { encryption: { kind: 'plain' } },
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      error: null,
      ...overrides,
    },
  };
}

export function preparedSendRow(overrides: Partial<DurableSend> = {}): RuntimeQueueRow {
  return {
    source: 'identity',
    record: {
      id: 'send-1',
      nonce: 'nonce-2',
      sequence: 2,
      channelId: 'chan-1',
      serializedRequest: JSON.stringify({ nonce: 'nonce-2', content: 'queued body' }),
      draft: { content: 'queued body' },
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 0,
      error: null,
      ...overrides,
    },
  };
}

export function mutationRow(overrides: Partial<DeliveredMutation> = {}): RuntimeMutationRow {
  return {
    source: 'local',
    record: {
      id: 'mut-1',
      sequence: 1,
      revision: 'rev-m1',
      target: {
        channelId: 'chan-1',
        messageId: 'msg-1',
        authorId: 'user-1',
        encryption: { kind: 'plain' },
      },
      intent: { kind: 'edit', editNonce: 'edit-nonce-1', content: 'edited body' },
      status: 'failed',
      attempts: 1,
      nextAttemptAt: 0,
      retryAfterAt: 0,
      error: null,
      ...overrides,
    },
  };
}

export function recoveryDraftRow(overrides: Partial<RecoveryDraft> = {}): RecoveryDraft {
  return {
    id: 'recovery-1',
    channelId: 'chan-1',
    content: 'recovered text',
    reason: 'Saved before durable encrypted delivery.',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    ...overrides,
  };
}

export function createMessagingPanelRuntime(snapshot: Partial<MessagingSnapshot> = {}, draftContent = '') {
  const store: StoreApi<MessagingSnapshot> = createStore<MessagingSnapshot>(() => ({
    storage: 'ready',
    synchronization: 'ready',
    encryption: 'ready',
    error: null,
    encryptionError: null,
    previousEpoch: null,
    draftGeneration: 0,
    queue: [],
    mutations: [],
    recovery: [],
    ...snapshot,
  }));
  const draftStore = createStore<{ draft: { revision: string; content: string }; status: string; error: string | null }>(() => ({
    draft: { revision: 'draft-revision', content: draftContent }, status: 'saved', error: null,
  }));
  const draft = {
    store: draftStore,
    setContent: vi.fn((content: string) => draftStore.setState({ draft: { revision: 'restored', content } })),
    capture: vi.fn(async () => draftStore.getState().draft),
  };
  const actions = {
    queueAction: vi.fn<AccountMessagingRuntime['queueAction']>(async () => {}),
    retryMutation: vi.fn<AccountMessagingRuntime['retryMutation']>(async () => {}),
    preservePreviousHistoryForReview: vi.fn<AccountMessagingRuntime['preservePreviousHistoryForReview']>(
      async () => {},
    ),
    startLocal: vi.fn<AccountMessagingRuntime['startLocal']>(async () => {}),
    enroll: vi.fn<AccountMessagingRuntime['enroll']>(async () => {}),
    reviewLegacySession: vi.fn<AccountMessagingRuntime['reviewLegacySession']>(async () => {}),
    draftController: vi.fn<AccountMessagingRuntime['draftController']>(() => draft as unknown as ReturnType<AccountMessagingRuntime['draftController']>),
  };
  const runtime = { store, ...actions } as unknown as AccountMessagingRuntime;
  return { runtime, store, actions, draft };
}
