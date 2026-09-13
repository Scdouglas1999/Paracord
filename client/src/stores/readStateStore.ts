import { create } from 'zustand';
import type { ReadState } from '../types';
import { accountScopeKey, type AccountScope, LOCAL_SERVER_ID } from '../lib/serverScope';
import { captureScopedOperation, type OperationContext } from '../lib/operationContext';
import { getServerAccountScope } from '../lib/serverIdentity';
import { useServerListStore } from './serverListStore';
import { extractApiError } from '../api/client';
import { createChannelApi } from '../api/channels';
import { registerSessionReset } from './sessionReset';
import { registerAccountHistoryReset } from '../lib/databaseHistory';

type AccountReadStates = Record<string, ReadState>;
export const EMPTY_READ_STATES: AccountReadStates = Object.freeze({});
interface ReadStateStore {
  byAccount: Record<string, AccountReadStates>;
  attentionRevisions: Record<string, Record<string, number>>;
  invalidateAttention: (scope: AccountScope, channelId: string) => void;
  loading: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  getReadStateMap: (scope: AccountScope) => AccountReadStates;
  getReadState: (scope: AccountScope, channelId: string) => ReadState | undefined;
  setAll: (states: ReadState[], scope: AccountScope) => void;
  refresh: (scope: AccountScope) => Promise<void>;
  refreshAll: () => Promise<void>;
  refreshAfterEvent: (scope: AccountScope) => void;
  markRead: (scope: AccountScope, channelId: string, lastMessageId: string) => void;
  incrementMention: (scope: AccountScope, channelId: string) => void;
  saveReadPosition: (scope: AccountScope, channelId: string, lastMessageId: string, options?: { delayMs?: number; signal?: AbortSignal }) => Promise<void>;
  resetAccount: (scope: AccountScope) => void;
  reset: () => void;
}
interface Snapshot { context: OperationContext; promise: Promise<void>; changed: Map<string, ReadState> }
const requests = new Map<string, Snapshot>();
const eventRefreshes = new Map<string, { dirty: boolean }>();
const operations = new Set<OperationContext>();
const MAX_CHANGED_CHANNELS = 10_000;
function own(scope: AccountScope) {
  const context = captureScopedOperation(scope);
  operations.add(context);
  context.signal.addEventListener('abort', () => operations.delete(context), { once: true });
  return context;
}
function index(states: ReadState[]): AccountReadStates {
  return Object.fromEntries(states.map(state => [state.channel_id, state]));
}
function record(scope: AccountScope, value: ReadState) {
  const key = accountScopeKey(scope);
  const snapshot = requests.get(key);
  if (!snapshot) return;
  if (!snapshot.changed.has(value.channel_id) && snapshot.changed.size >= MAX_CHANGED_CHANNELS) {
    snapshot.context.dispose();
    useReadStateStore.setState(state => ({ errors: { ...state.errors, [key]: 'Read activity exceeded this snapshot. Refresh unread state to reconcile it.' } }));
    return;
  }
  snapshot.changed.set(value.channel_id, value);
}
export const useReadStateStore = create<ReadStateStore>()((set, get) => ({
  byAccount: {}, attentionRevisions: {}, loading: {}, errors: {},
  invalidateAttention: (scope, channelId) => {
    const key = accountScopeKey(scope);
    set(state => ({ attentionRevisions: { ...state.attentionRevisions, [key]: {
      ...state.attentionRevisions[key], [channelId]: (state.attentionRevisions[key]?.[channelId] ?? 0) + 1,
    } } }));
  },
  getReadStateMap: scope => get().byAccount[accountScopeKey(scope)] ?? EMPTY_READ_STATES,
  getReadState: (scope, id) => get().byAccount[accountScopeKey(scope)]?.[id],
  setAll: (states, scope) => set(state => ({ byAccount: { ...state.byAccount, [accountScopeKey(scope)]: index(states) } })),
  refresh: async scope => {
    const key = accountScopeKey(scope);
    const previous = requests.get(key);
    if (previous) return previous.promise;
    const context = own(scope);
    const request: Snapshot = { context, promise: Promise.resolve(), changed: new Map() };
    requests.set(key, request);
    context.signal.addEventListener('abort', () => {
      request.changed.clear();
      if (requests.get(key) !== request) return;
      requests.delete(key);
      set(state => ({ loading: { ...state.loading, [key]: false } }));
    }, { once: true });
    set(state => ({ loading: { ...state.loading, [key]: true }, errors: { ...state.errors, [key]: undefined } }));
    request.promise = (async () => {
      try {
        const { data } = await context.api.get<ReadState[]>('/users/@me/read-states');
        context.assertCurrent();
        if (requests.get(key) !== request) return;
        const snapshot = index(data);
        for (const [id, value] of request.changed) snapshot[id] = value;
        set(state => ({ byAccount: { ...state.byAccount, [key]: snapshot } }));
      } catch (err) {
        if (!context.signal.aborted) set(state => ({ errors: { ...state.errors, [key]: extractApiError(err) } }));
        throw err;
      } finally { context.dispose(); }
    })();
    return request.promise;
  },
  refreshAll: async () => {
    const ids = [LOCAL_SERVER_ID, ...useServerListStore.getState().servers.filter(server => server.connected).map(server => server.id)];
    const scopes = ids.map(getServerAccountScope).filter((scope): scope is AccountScope => !!scope);
    // Each failure remains visible in its account's error state; another host's
    // successful request must not wait for or overwrite that failed account.
    await Promise.allSettled(scopes.map(scope => get().refresh(scope)));
  },
  refreshAfterEvent: scope => {
    const key = accountScopeKey(scope);
    const previous = eventRefreshes.get(key);
    if (previous) { previous.dirty = true; return; }
    const job = { dirty: true };
    eventRefreshes.set(key, job);
    void (async () => {
      try {
        while (job.dirty && eventRefreshes.get(key) === job) {
          job.dirty = false;
          // A second event during an in-flight snapshot forces one fresh read
          // afterwards, so an older snapshot cannot consume the newer event.
          const waitingForEarlierSnapshot = requests.has(key);
          await get().refresh(scope);
          if (waitingForEarlierSnapshot) job.dirty = true;
        }
      } catch { /* refresh exposes its owned error; reconnect/Refresh retries. */ }
      finally { if (eventRefreshes.get(key) === job) eventRefreshes.delete(key); }
    })();
  },
  markRead: (scope, id, lastMessageId) => {
    const value = { channel_id: id, last_message_id: lastMessageId, mention_count: 0 };
    record(scope, value);
    const key = accountScopeKey(scope);
    set(state => ({ byAccount: { ...state.byAccount, [key]: { ...state.byAccount[key], [id]: value } } }));
  },
  incrementMention: (scope, id) => {
    const previous = get().getReadState(scope, id);
    const value = { channel_id: id, last_message_id: previous?.last_message_id ?? '', mention_count: (previous?.mention_count ?? 0) + 1 };
    record(scope, value);
    const key = accountScopeKey(scope);
    set(state => ({ byAccount: { ...state.byAccount, [key]: { ...state.byAccount[key], [id]: value } } }));
  },
  saveReadPosition: async (scope, id, lastMessageId, options) => {
    const context = own(scope);
    const cancel = () => context.dispose();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (options?.signal?.aborted) context.dispose();
      context.assertCurrent();
      if (options?.delayMs) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { context.signal.removeEventListener('abort', abort); resolve(); }, options.delayMs);
        const abort = () => { clearTimeout(timer); reject(context.signal.reason); };
        context.signal.addEventListener('abort', abort, { once: true });
      });
      await createChannelApi(() => context.api).updateReadState(id, lastMessageId);
      context.assertCurrent();
    } finally {
      options?.signal?.removeEventListener('abort', cancel);
      context.dispose();
    }
  },
  resetAccount: scope => {
    const key = accountScopeKey(scope);
    eventRefreshes.delete(key);
    for (const context of operations) if (context.key === key) context.dispose();
    const retain = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([id]) => id !== key));
    set(state => ({ byAccount: retain(state.byAccount), attentionRevisions: retain(state.attentionRevisions), loading: retain(state.loading), errors: retain(state.errors) }));
  },
  reset: () => {
    for (const context of operations) context.dispose();
    operations.clear(); requests.clear(); eventRefreshes.clear();
    set({ byAccount: {}, attentionRevisions: {}, loading: {}, errors: {} });
  },
}));
registerSessionReset('read-state', () => useReadStateStore.getState().reset());
registerAccountHistoryReset('read-state', scope => useReadStateStore.getState().resetAccount(scope));
