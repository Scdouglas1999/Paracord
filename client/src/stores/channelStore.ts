import { create } from 'zustand';
import type { Channel } from '../types';
import { createGuildApi, guildApi } from '../api/guilds';
import { createChannelApi } from '../api/channels';
import { createDmApi } from '../api/dms';
import { extractApiError, isMissingOrForbidden } from '../api/client';
import { captureScopedOperation, type OperationContext } from '../lib/operationContext';
import { accountScopeKey, entityScopeKey, entityKeyBelongsToScope, LOCAL_SERVER_ID, type AccountScope } from '../lib/serverScope';
import { scopeChannel, type ScopedChannel, type ChannelReference } from '../lib/channelScope';
import { getServerAccountScope } from '../lib/serverIdentity';
import { fetchVisibleGuildChannels } from '../lib/guildChannels';
import { useServerListStore } from './serverListStore';
import { toast } from './toastStore';
import { registerSessionReset } from './sessionReset';
import { isChannelActivity, preserveChannelActivity, type ChannelActivity } from '../lib/channelActivity';
import { registerAccountHistoryReset } from '../lib/databaseHistory';

interface ChannelState {
  /** Guild and DM collections, keyed by (server, account, guild ID or empty DM ID). */
  channelsByGuild: Record<string, ScopedChannel[]>;
  channelsById: Record<string, ScopedChannel>;
  guildChannelsLoaded: Record<string, boolean>;
  loading: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  /**
   * The server answered "this is not yours to see" (403) or "there is no such
   * thing" (404). A route draws that as a state with a way back, rather than
   * toasting the API's own word at somebody who followed a stale link.
   */
  denied: Record<string, boolean>;
  selectedChannel: ChannelReference | null;
  fetchChannels: (guildId: string, scope: AccountScope) => Promise<void>;
  fetchDmChannels: (scope: AccountScope) => Promise<void>;
  loadAllDmChannels: () => Promise<void>;
  selectChannel: (channel: ChannelReference | null) => void;
  setChannels: (guildId: string, channels: Channel[], scope: AccountScope) => void;
  changeDmRecipient: (channelId: string, recipientId: string, add: boolean, scope: AccountScope) => Promise<void>;
  createDm: (recipientId: string, scope: AccountScope) => Promise<ScopedChannel>;
  createGroupDm: (recipientIds: string[], name: string | undefined, scope: AccountScope) => Promise<ScopedChannel>;
  createChannel: (guildId: string, data: Parameters<typeof guildApi.createChannel>[1], scope: AccountScope) => Promise<ScopedChannel>;
  updateChannelData: (channelId: string, data: Partial<Channel>, scope: AccountScope) => Promise<void>;
  deleteChannel: (channelId: string, scope: AccountScope) => Promise<void>;
  reorderChannels: (guildId: string, positions: { id: string; position: number; parent_id?: string | null }[], scope: AccountScope) => Promise<void>;
  addChannel: (channel: Channel, scope: AccountScope) => void;
  updateChannel: (channel: Partial<Channel> & Pick<Channel, 'id'>, scope: AccountScope) => void;
  removeChannel: (guildId: string, channelId: string, scope: AccountScope) => void;
  applyMessageActivity: (channelId: string, activity: unknown, scope: AccountScope) => void;
  resetAccount: (scope: AccountScope) => void;
  reset: () => void;
}

type Mutation = { kind: 'delete' } | { kind: 'put'; channel: Channel } | { kind: 'patch'; channel: Partial<Channel> };
interface Snapshot { context: OperationContext; promise: Promise<void>; mutations: Map<string, Mutation>; activitySerial: number }
const requests = new Map<string, Snapshot>();
const operations = new Set<OperationContext>();
const visibilityTimers = new Map<string, { context: OperationContext; timer: ReturnType<typeof setTimeout> }>();
const MAX_PENDING_CHANNELS = 10_000;
interface EarlyActivity { activity: ChannelActivity; observedAt: number }
const earlyActivity = new Map<string, Map<string, EarlyActivity>>();
let activitySerial = 0;

function removeEarlyActivity(scope: AccountScope, channelId: string) {
  const key = accountScopeKey(scope);
  const pending = earlyActivity.get(key);
  pending?.delete(channelId);
  if (pending?.size === 0) earlyActivity.delete(key);
}

/** A list started after an event can prove that its channel is no longer visible. */
function reconcileEarlyActivity(scope: AccountScope, guildId: string, startedAt: number) {
  const pending = earlyActivity.get(accountScopeKey(scope));
  if (!pending) return;
  for (const [id, entry] of pending) {
    if ((entry.activity.guild_id ?? '') === guildId && entry.observedAt <= startedAt) removeEarlyActivity(scope, id);
  }
}

function withEarlyActivity(channel: Channel, scope: AccountScope): Channel {
  const activity = earlyActivity.get(accountScopeKey(scope))?.get(channel.id)?.activity;
  if (!activity) return channel;
  removeEarlyActivity(scope, channel.id);
  if ((channel.guild_id ?? null) !== activity.guild_id) return channel;
  const patch = { last_message_id: activity.last_message_id, message_revision: activity.revision };
  return preserveChannelActivity(channel, { ...channel, ...patch });
}

function own(scope: AccountScope) {
  const context = captureScopedOperation(scope);
  operations.add(context);
  context.signal.addEventListener('abort', () => operations.delete(context), { once: true });
  return context;
}
function record(scope: AccountScope, guildId: string, id: string, mutation: Mutation) {
  const key = entityScopeKey(scope, guildId);
  const request = requests.get(key);
  if (!request) return;
  if (!request.mutations.has(id) && request.mutations.size >= MAX_PENDING_CHANNELS) {
    request.context.dispose();
    const error = 'Channel activity exceeded this snapshot. Reload the channel list to refresh.';
    useChannelStore.setState(state => ({ guildChannelsLoaded: { ...state.guildChannelsLoaded, [key]: false }, errors: { ...state.errors, [key]: error } }));
    toast.error(error);
    return;
  }
  const previous = request.mutations.get(id);
  if (mutation.kind === 'patch' && previous) {
    if (previous.kind === 'delete') return;
    request.mutations.set(id, { ...previous, channel: preserveChannelActivity(previous.channel, { ...previous.channel, ...mutation.channel }) } as Mutation);
  } else request.mutations.set(id, mutation);
}
function replaceCollection(state: ChannelState, guildId: string, channels: Channel[], scope: AccountScope) {
  const key = entityScopeKey(scope, guildId);
  const list = [...new Map(channels.map(channel => [channel.id, state.channelsById[entityScopeKey(scope, channel.id)] === channel ? channel as ScopedChannel : scopeChannel(preserveChannelActivity(state.channelsById[entityScopeKey(scope, channel.id)], withEarlyActivity(channel, scope)), scope)])).values()]
    .sort((a, b) => a.position - b.position);
  const index = { ...state.channelsById };
  for (const old of state.channelsByGuild[key] ?? []) delete index[old.key];
  for (const channel of list) index[channel.key] = channel;
  return { channelsByGuild: { ...state.channelsByGuild, [key]: list }, channelsById: index };
}
async function fetchCollection(guildId: string, scope: AccountScope) {
  const key = entityScopeKey(scope, guildId);
  const previous = requests.get(key);
  if (previous) return previous.promise;
  let context: OperationContext;
  try { context = own(scope); } catch (err) {
    useChannelStore.setState(state => ({ errors: { ...state.errors, [key]: extractApiError(err) } }));
    return;
  }
  const request: Snapshot = { context, promise: Promise.resolve(), mutations: new Map(), activitySerial };
  requests.set(key, request);
  context.signal.addEventListener('abort', () => {
    request.mutations.clear();
    if (requests.get(key) !== request) return;
    requests.delete(key);
    useChannelStore.setState(state => ({ loading: { ...state.loading, [key]: false } }));
  }, { once: true });
  useChannelStore.setState(state => ({ loading: { ...state.loading, [key]: true }, errors: { ...state.errors, [key]: undefined }, denied: { ...state.denied, [key]: false } }));
  request.promise = (async () => {
    try {
      const channels = guildId ? await fetchVisibleGuildChannels(context, guildId) : (await createDmApi(() => context.api).list()).data;
      context.assertCurrent();
      if (requests.get(key) !== request) return;
      const merged = new Map(channels.map(channel => [channel.id, channel]));
      for (const [id, mutation] of request.mutations) {
        if (mutation.kind === 'delete') merged.delete(id);
        else if (mutation.kind === 'put') merged.set(id, preserveChannelActivity(merged.get(id), mutation.channel));
        else {
          const channel = merged.get(id);
          if (channel) merged.set(id, preserveChannelActivity(channel, { ...channel, ...mutation.channel }));
        }
      }
      useChannelStore.getState().setChannels(guildId, [...merged.values()], scope);
      reconcileEarlyActivity(scope, guildId, request.activitySerial);
    } catch (err) {
      if (!context.signal.aborted) {
        const error = `Failed to load channels: ${extractApiError(err)}`;
        useChannelStore.setState(state => ({
          errors: { ...state.errors, [key]: error },
          denied: { ...state.denied, [key]: isMissingOrForbidden(err) },
        }));
        // A room list you are not allowed to see is a state the route draws,
        // not an incident to toast about in the API's own words.
        if (!isMissingOrForbidden(err)) toast.error(error);
      }
    } finally { context.dispose(); }
  })();
  return request.promise;
}

/** Debounced work retains its account even when the visible server changes. */
export function refreshGuildChannelVisibility(guildId: string | null | undefined, scope: AccountScope): void {
  if (!guildId) return;
  const key = entityScopeKey(scope, guildId);
  visibilityTimers.get(key)?.context.dispose();
  let context: OperationContext;
  try { context = own(scope); } catch { return; }
  const timer = setTimeout(() => {
    if (requests.has(key)) {
      refreshGuildChannelVisibility(guildId, scope);
      return;
    }
    context.assertCurrent();
    context.dispose();
    void useChannelStore.getState().fetchChannels(guildId, scope);
  }, 750);
  const entry = { context, timer };
  visibilityTimers.set(key, entry);
  context.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    if (visibilityTimers.get(key) === entry) visibilityTimers.delete(key);
  }, { once: true });
}

export const useChannelStore = create<ChannelState>()((set, get) => ({
  channelsByGuild: {}, channelsById: {}, guildChannelsLoaded: {}, loading: {}, errors: {}, denied: {}, selectedChannel: null,
  fetchChannels: fetchCollection,
  fetchDmChannels: scope => fetchCollection('', scope),
  loadAllDmChannels: async () => {
    const serverIds = [LOCAL_SERVER_ID, ...useServerListStore.getState().servers.filter(server => server.connected).map(server => server.id)];
    const scopes = serverIds.map(getServerAccountScope).filter((scope): scope is AccountScope => !!scope);
    await Promise.all(scopes.map(scope => get().fetchDmChannels(scope)));
  },
  selectChannel: channel => set({ selectedChannel: channel ? { id: channel.id, scope: { ...channel.scope } } : null }),
  setChannels: (guildId, channels, scope) => set(state => ({
    ...replaceCollection(state, guildId, channels, scope),
    guildChannelsLoaded: { ...state.guildChannelsLoaded, [entityScopeKey(scope, guildId)]: true },
  })),
  changeDmRecipient: async (id, recipientId, add, scope) => {
    const context = own(scope);
    try {
      const api = createDmApi(() => context.api);
      if (add) await api.addRecipient(id, recipientId);
      else await api.removeRecipient(id, recipientId);
      context.assertCurrent();
      if (!add && recipientId === scope.userId) get().removeChannel('', id, scope);
      else {
        const { data: recipients } = await api.listRecipients(id);
        context.assertCurrent(); get().updateChannel({ id, recipients }, scope);
      }
    } finally { context.dispose(); }
  },
  createDm: async (recipientId, scope) => {
    const context = own(scope);
    try {
      const { data } = await createDmApi(() => context.api).create(recipientId);
      context.assertCurrent(); get().addChannel(data, scope); return scopeChannel(data, scope);
    } finally { context.dispose(); }
  },
  createGroupDm: async (ids, name, scope) => {
    const context = own(scope);
    try {
      const { data } = await createDmApi(() => context.api).createGroup(ids, name);
      context.assertCurrent(); get().addChannel(data, scope); return scopeChannel(data, scope);
    } finally { context.dispose(); }
  },
  createChannel: async (guildId, data, scope) => {
    const context = own(scope);
    try {
      const response = await createGuildApi(() => context.api).createChannel(guildId, data);
      context.assertCurrent(); get().addChannel(response.data, scope); return scopeChannel(response.data, scope);
    } finally { context.dispose(); }
  },
  updateChannelData: async (id, patch, scope) => {
    const context = own(scope);
    try {
      const { data } = await createChannelApi(() => context.api).update(id, patch);
      context.assertCurrent(); get().updateChannel(data, scope);
    } finally { context.dispose(); }
  },
  deleteChannel: async (id, scope) => {
    const context = own(scope);
    const channel = get().channelsById[entityScopeKey(scope, id)];
    try {
      await createChannelApi(() => context.api).delete(id);
      context.assertCurrent();
      if (channel) get().removeChannel(channel.guild_id ?? '', id, scope);
    } finally { context.dispose(); }
  },
  reorderChannels: async (guildId, positions, scope) => {
    const context = own(scope);
    try {
      // Commit after acknowledgement; a failed reorder must never restore a stale snapshot.
      await createChannelApi(() => context.api).updatePositions(guildId, positions);
      context.assertCurrent();
      for (const position of positions) get().updateChannel(position, scope);
    } finally { context.dispose(); }
  },
  addChannel: (channel, scope) => {
    channel = preserveChannelActivity(get().channelsById[entityScopeKey(scope, channel.id)], withEarlyActivity(channel, scope));
    const guildId = channel.guild_id ?? '';
    record(scope, guildId, channel.id, { kind: 'put', channel });
    set(state => {
      const key = entityScopeKey(scope, guildId);
      const previous = state.channelsByGuild[key] ?? [];
      return replaceCollection(state, guildId, [...previous.filter(item => item.id !== channel.id), channel], scope);
    });
  },
  updateChannel: (patch, scope) => {
    const existing = get().channelsById[entityScopeKey(scope, patch.id)];
    patch = preserveChannelActivity(existing, patch);
    const guildId = patch.guild_id ?? existing?.guild_id ?? '';
    record(scope, guildId, patch.id, { kind: 'patch', channel: patch });
    if (!existing) return;
    set(state => replaceCollection(state, guildId, (state.channelsByGuild[entityScopeKey(scope, guildId)] ?? []).map(channel => channel.id === patch.id ? { ...channel, ...patch } : channel), scope));
  },
  removeChannel: (guildId, id, scope) => {
    removeEarlyActivity(scope, id);
    record(scope, guildId, id, { kind: 'delete' });
    set(state => ({
      ...replaceCollection(state, guildId, (state.channelsByGuild[entityScopeKey(scope, guildId)] ?? []).filter(channel => channel.id !== id), scope),
      selectedChannel: state.selectedChannel?.id === id && accountScopeKey(state.selectedChannel.scope) === accountScopeKey(scope) ? null : state.selectedChannel,
    }));
  },
  applyMessageActivity: (id, activity, scope) => {
    if (!isChannelActivity(activity) || activity.channel_id !== id) return;
    const existing = get().channelsById[entityScopeKey(scope, id)];
    if (existing && (existing.guild_id ?? null) !== activity.guild_id) return;
    if (!existing) {
      const key = accountScopeKey(scope);
      const pending = earlyActivity.get(key) ?? new Map<string, EarlyActivity>();
      const previous = pending.get(id);
      if (!previous && pending.size >= MAX_PENDING_CHANNELS) {
        const group = entityScopeKey(scope, activity.guild_id ?? '');
        const error = 'Channel activity exceeded the pending channel list. Refresh channels to reconcile it.';
        requests.get(group)?.context.dispose();
        set(state => ({ guildChannelsLoaded: { ...state.guildChannelsLoaded, [group]: false }, errors: { ...state.errors, [group]: error } }));
        return;
      }
      if (!previous || BigInt(activity.revision) > BigInt(previous.activity.revision)) {
        pending.set(id, { activity, observedAt: ++activitySerial });
        earlyActivity.set(key, pending);
      }
    }
    get().updateChannel({ id, guild_id: activity.guild_id, last_message_id: activity.last_message_id, message_revision: activity.revision }, scope);
  },
  resetAccount: scope => {
    const key = accountScopeKey(scope);
    for (const context of operations) if (context.key === key) context.dispose();
    earlyActivity.delete(key);
    const retain = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([id]) => !entityKeyBelongsToScope(id, scope)));
    set(state => ({
      channelsByGuild: retain(state.channelsByGuild), channelsById: retain(state.channelsById),
      guildChannelsLoaded: retain(state.guildChannelsLoaded), loading: retain(state.loading), errors: retain(state.errors), denied: retain(state.denied),
      selectedChannel: state.selectedChannel && accountScopeKey(state.selectedChannel.scope) === key ? null : state.selectedChannel,
    }));
  },
  reset: () => {
    for (const context of operations) context.dispose();
    operations.clear(); requests.clear(); visibilityTimers.clear(); earlyActivity.clear();
    activitySerial = 0;
    set({ channelsByGuild: {}, channelsById: {}, guildChannelsLoaded: {}, loading: {}, errors: {}, denied: {}, selectedChannel: null });
  },
}));
registerSessionReset('channels', () => useChannelStore.getState().reset());
registerAccountHistoryReset('channels', scope => useChannelStore.getState().resetAccount(scope));
