import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createNotificationSettingsApi,
  type ChannelNotificationSetting,
  type NotificationLevel,
  type SpaceNotificationSetting,
} from '../api/notificationSettings';
import { captureScopedOperation, type OperationContext } from '../lib/operationContext';
import { accountScopeKey, entityScopeKey, type AccountScope } from '../lib/serverScope';
import type { GuildReference } from '../lib/guildScope';
import { extractApiError } from '../api/client';
import { registerSessionReset } from './sessionReset';

type Settings = Record<string, SpaceNotificationSetting>;
type ChannelSettings = Record<string, ChannelNotificationSetting>;
/** A room, the same shape a guild reference has: an id plus the account it is on. */
export interface ChannelReferenceWithScope {
  id: string;
  scope: AccountScope;
}
interface PreferenceState {
  byAccount: Record<string, Settings>;
  /** Per-room overrides, keyed by account then by channel id. */
  channelsByAccount: Record<string, ChannelSettings>;
  loading: Record<string, boolean>;
  saving: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  refresh: (scope: AccountScope) => Promise<void>;
  setMuted: (guild: GuildReference, muted: boolean) => Promise<void>;
  /**
   * A room's own notification level. `null` clears the override so the room
   * follows its building again — the third state the menu offers.
   */
  setChannelLevel: (channel: ChannelReferenceWithScope, level: NotificationLevel | null) => Promise<void>;
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
  byAccount: {}, channelsByAccount: {}, loading: {}, saving: {}, errors: {},
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
        const { spaces, channels } = await createNotificationSettingsApi(() => context.api).list();
        context.assertCurrent();
        const settings = Object.fromEntries(spaces.map(setting => [setting.space_id, setting]));
        for (const [id, setting] of request.changed) settings[id] = setting;
        const rooms = Object.fromEntries((channels ?? []).map(setting => [setting.channel_id, setting]));
        set(state => ({
          byAccount: { ...state.byAccount, [key]: settings },
          channelsByAccount: { ...state.channelsByAccount, [key]: rooms },
        }));
      } catch (err) {
        if (!context.signal.aborted) set(state => ({ errors: { ...state.errors, [key]: extractApiError(err) } }));
        throw err;
      } finally { context.dispose(); }
    })();
    return request.promise;
  },
  setMuted: async (guild, muted) => {
    const key = entityScopeKey(guild.scope, guild.id);
    if (saves.has(key)) throw new Error('A notification change for this building is still being saved.');
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
  setChannelLevel: async (channel, level) => {
    const key = entityScopeKey(channel.scope, channel.id);
    if (saves.has(key)) throw new Error('A notification change for this room is still being saved.');
    const context = own(channel.scope);
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
        const api = createNotificationSettingsApi(() => context.api);
        const accountKey = accountScopeKey(channel.scope);
        if (level === null) {
          // No override: the room follows whatever its building says.
          await api.clearChannel(channel.id);
          context.assertCurrent();
          set(state => {
            const rooms = { ...(state.channelsByAccount[accountKey] ?? {}) };
            delete rooms[channel.id];
            return { channelsByAccount: { ...state.channelsByAccount, [accountKey]: rooms } };
          });
          return;
        }
        // Level 2 IS the mute: "nothing from this room" has to survive a
        // reload, and the server resolves `muted_now` for us.
        const setting = await api.setChannel(channel.id, { level, muted: level === 2 });
        context.assertCurrent();
        set(state => ({
          channelsByAccount: {
            ...state.channelsByAccount,
            [accountKey]: { ...(state.channelsByAccount[accountKey] ?? {}), [channel.id]: setting },
          },
        }));
      } finally { context.dispose(); }
    })();
    if (context.signal.aborted) release();
    return pending.promise;
  },
  reset: () => {
    for (const operation of operations) operation.dispose();
    requests.clear(); saves.clear(); operations.clear();
    set({ byAccount: {}, channelsByAccount: {}, loading: {}, saving: {}, errors: {} });
  },
}), {
  // The previous global cache has no account provenance. Rebuild preferences
  // from the server; never assign those unowned IDs to whichever account logs in.
  name: 'paracord:notification-preferences-by-account',
  version: 1,
  partialize: state => ({ byAccount: state.byAccount, channelsByAccount: state.channelsByAccount }),
}));
registerSessionReset('notification-preferences', () => useNotificationPreferenceStore.getState().reset());
