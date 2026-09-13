import { createStore, type StoreApi } from 'zustand/vanilla';
import { EncryptedDraftController } from '../lib/messages/encryptedDraftController';
import type { EncryptedMessageDraft } from '../lib/messages/encryptedDraftSubmission';
import type { MessagingSnapshot } from '../lib/messages/accountMessagingRuntime';
import { accountScopeKey, type AccountScope } from '../lib/serverScope';

/**
 * Test-only account messaging runtime for jsdom suites. Draft text stays in
 * the real EncryptedDraftController over in-memory persistence — never
 * localStorage and never IndexedDB — so component tests still exercise async
 * persistence, navigation, and current-revision behavior.
 */
type DraftPersistence = ConstructorParameters<typeof EncryptedDraftController>[0];

export interface FakeMessagingRuntime {
  readonly scope: AccountScope;
  readonly store: StoreApi<MessagingSnapshot>;
  draftController(channelId: string): EncryptedDraftController;
}

export type MessagingRuntimeRegistry = Map<string, FakeMessagingRuntime>;

function channelPersistence(
  drafts: Map<string, EncryptedMessageDraft>,
  channelId: string,
): DraftPersistence {
  return {
    read: async () => drafts.get(channelId) ?? null,
    write: async (draft, expectedRevision) => {
      if ((drafts.get(channelId)?.revision ?? null) !== expectedRevision) {
        throw new Error(
          'This conversation’s saved draft changed in another window. Review it before replacing it.',
        );
      }
      drafts.set(channelId, { ...draft });
    },
    clear: async (revision) => {
      if (drafts.get(channelId)?.revision === revision) drafts.delete(channelId);
    },
  };
}

export function createFakeMessagingRuntime(scope: AccountScope): FakeMessagingRuntime {
  const drafts = new Map<string, EncryptedMessageDraft>();
  const controllers = new Map<string, EncryptedDraftController>();
  return {
    scope,
    store: createStore<MessagingSnapshot>(() => ({
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
    })),
    draftController(channelId: string) {
      let controller = controllers.get(channelId);
      if (!controller) {
        controller = new EncryptedDraftController(channelPersistence(drafts, channelId));
        controllers.set(channelId, controller);
      }
      return controller;
    },
  };
}

/** Stable per-account runtimes; clear the registry between tests so drafts never leak. */
export function fakeAccountMessagingRuntime(
  registry: MessagingRuntimeRegistry,
  scope: AccountScope,
): FakeMessagingRuntime {
  const key = accountScopeKey(scope);
  let runtime = registry.get(key);
  if (!runtime) {
    runtime = createFakeMessagingRuntime(scope);
    registry.set(key, runtime);
  }
  return runtime;
}
