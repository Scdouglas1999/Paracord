import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createNotificationSettingsApi, type SpaceNotificationSetting } from '../api/notificationSettings';
import { captureScopedOperation, type OperationContext } from '../lib/operationContext';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../lib/serverScope';
import type { GuildReference } from '../lib/guildScope';
import { extractApiError } from '../api/client';
import { registerSessionReset } from './sessionReset';

type Settings = Record<string, SpaceNotificationSetting>;
interface PreferenceState {
  byAccount: Record<string, Settings>;
  loading: Record<string, boolean>;
  saving: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  refresh: (scope: AccountScope) => Promise<void>;
  setMuted: (guild: GuildReference, muted: boolean) => Promise<void>;
  reset: () => void;
}
interface Snapshot { context: OperationContext; changed: Map<string, SpaceNotificationSetting>; promise: Promise<void> }
const requests = new Map<string, Snapshot>();
const operations = new Set<OperationContext>();
const saves = new Map<string, { context: OperationContext; promise: Promise<void> }>();
function own(scope: AccountScope) {
  const context = captureScopedOperation(scope);
  operations.add(context);
  context.signal.addEventListener('abort', () => operations.delete(context), { once: true });
  return context;
}
function record(scope: AccountScope, setting: SpaceNotificationSetting) {
  const request = requests.get(accountScopeKey(scope));
  if (!request) return;
  if (!request.changed.has(setting.space_id) && request.changed.size >= 10_000) {
    request.context.dispose();
    useNotificationPreferenceStore.setState(state => ({ errors: { ...state.errors, [accountScopeKey(scope)]: 'Notification changes exceeded this snapshot. Refresh notification preferences.' } }));
    return;
  }
  request.changed.set(setting.space_id, setting);
}
export const useNotificationPreferenceStore = create<PreferenceState>()(persist((set) => ({
  byAccount: {}, loading: {}, saving: {}, errors: {},
  refresh: async scope => {
    const key = accountScopeKey(scope);
    const existing = requests.get(key);
    if (existing) return existing.promise;
    const context = own(scope);
    const request: Snapshot = { context, changed: new Map(), promise: Promise.resolve() };
    requests.set(key, request);
    context.signal.addEventListener('abort', () => {
      request.changed.clear();
      if (requests.get(key) !== request) return;
      requests.delete(key); set(state => ({ loading: { ...state.loading, [key]: false } }));
    }, { once: true });
    set(state => ({ loading: { ...state.loading, [key]: true }, errors: { ...state.errors, [key]: undefined } }));
    request.promise = (async () => {
      try {
        const { spaces } = await createNotificationSettingsApi(() => context.api).list();
        context.assertCurrent();
        const settings = Object.fromEntries(spaces.map(setting => [setting.space_id, setting]));
        for (const [id, setting] of request.changed) settings[id] = setting;
        set(state => ({ byAccount: { ...state.byAccount, [key]: settings } }));
      } catch (err) {
        if (!context.signal.aborted) set(state => ({ errors: { ...state.errors, [key]: extractApiError(err) } }));
        throw err;
      } finally { context.dispose(); }
    })();
    return request.promise;
  },
  setMuted: async (guild, muted) => {
    const key = entityScopeKey(guild.scope, guild.id);
    if (saves.has(key)) throw new Error('A notification change for this space is still being saved.');
    const context = own(guild.scope);
    const pending = { context, promise: Promise.resolve() };
    saves.set(key, pending);
    const release = () => {
      if (saves.get(key) !== pending) return;
      saves.delete(key); set(state => ({ saving: { ...state.saving, [key]: false } }));
    };
    context.signal.addEventListener('abort', release, { once: true });
    set(state => ({ saving: { ...state.saving, [key]: true } }));
    pending.promise = (async () => {
      try {
        // Change only mute status; unmuting must retain custom levels and suppression.
        const setting = await createNotificationSettingsApi(() => context.api).setSpace(guild.id, { muted });
        context.assertCurrent(); record(guild.scope, setting);
        const accountKey = accountScopeKey(guild.scope);
        set(state => ({ byAccount: { ...state.byAccount, [accountKey]: { ...state.byAccount[accountKey], [guild.id]: setting } } }));
      } finally { context.dispose(); }
    })();
    if (context.signal.aborted) release();
    return pending.promise;
  },
  reset: () => {
    for (const operation of operations) operation.dispose();
    requests.clear(); saves.clear(); operations.clear();
    set({ byAccount: {}, loading: {}, saving: {}, errors: {} });
  },
}), {
  // The previous global cache has no account provenance. Rebuild preferences
  // from the server; never assign those unowned IDs to whichever account logs in.
  name: 'paracord:notification-preferences-by-account',
  version: 1,
  partialize: state => ({ byAccount: state.byAccount }),
}));
registerSessionReset('notification-preferences', () => useNotificationPreferenceStore.getState().reset());
