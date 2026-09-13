import { useChannelStore } from '../stores/channelStore';
import { accountScopeKey, type AccountScope } from './serverScope';
import type { ScopedChannel } from './channelScope';

type ChannelState = ReturnType<typeof useChannelStore.getState>;
const views = new WeakMap<ChannelState, Map<string, ReturnType<typeof buildView>>>();
const actions = new Map<string, ReturnType<typeof buildActions>>();
function buildActions(scope: AccountScope | null) {
  const requireScope = () => { if (!scope) throw new Error('Sign in to this server before continuing.'); return scope; };
  return {
    fetchChannels: (id: string) => useChannelStore.getState().fetchChannels(id, requireScope()),
    selectChannel: (id: string | null) => useChannelStore.getState().selectChannel(id ? { id, scope: requireScope() } : null),
    addChannel: (channel: Parameters<ChannelState['addChannel']>[0]) => useChannelStore.getState().addChannel(channel, requireScope()),
    updateChannel: (channel: Parameters<ChannelState['updateChannel']>[0]) => useChannelStore.getState().updateChannel(channel, requireScope()),
    removeChannel: (guildId: string, id: string) => useChannelStore.getState().removeChannel(guildId, id, requireScope()),
    reorderChannels: (guildId: string, positions: Parameters<ChannelState['reorderChannels']>[1]) => useChannelStore.getState().reorderChannels(guildId, positions, requireScope()),
  };
}
export function actionsFor(scope: AccountScope | null) {
  const key = scope ? accountScopeKey(scope) : '';
  let result = actions.get(key);
  if (!result) { result = buildActions(scope); actions.set(key, result); }
  return result;
}
function buildView(state: ChannelState, scope: AccountScope | null) {
  const channelsByGuild: Record<string, ScopedChannel[]> = {};
  const channelsById: Record<string, ScopedChannel> = {};
  const guildChannelsLoaded: Record<string, boolean> = {};
  const loading: Record<string, boolean> = {};
  const errors: Record<string, string | undefined> = {};
  if (scope) {
    for (const [key, channels] of Object.entries(state.channelsByGuild)) {
      const [serverId, userId, guildId] = JSON.parse(key) as [string, string, string];
      if (serverId !== scope.serverId || userId !== scope.userId) continue;
      channelsByGuild[guildId] = channels;
      for (const channel of channels) channelsById[channel.id] = channel;
    }
    for (const [key, value] of Object.entries(state.guildChannelsLoaded)) {
      const [serverId, userId, guildId] = JSON.parse(key) as [string, string, string];
      if (serverId === scope.serverId && userId === scope.userId) guildChannelsLoaded[guildId] = value;
    }
    for (const [key, value] of Object.entries(state.loading)) {
      const [serverId, userId, guildId] = JSON.parse(key) as [string, string, string];
      if (serverId === scope.serverId && userId === scope.userId) loading[guildId] = value;
    }
    for (const [key, value] of Object.entries(state.errors)) {
      const [serverId, userId, guildId] = JSON.parse(key) as [string, string, string];
      if (serverId === scope.serverId && userId === scope.userId) errors[guildId] = value;
    }
  }
  return {
    scope, channelsByGuild, channelsById, guildChannelsLoaded, loading, errors,
    selectedChannelId: scope && state.selectedChannel && accountScopeKey(state.selectedChannel.scope) === accountScopeKey(scope) ? state.selectedChannel.id : null,
    ...actionsFor(scope),
  };
}
/** Explicit account view; bare IDs are local to this view, never global cache keys. */
export function getAccountChannelView(scope: AccountScope | null, state = useChannelStore.getState()) {
  let scoped = views.get(state);
  if (!scoped) { scoped = new Map(); views.set(state, scoped); }
  const key = scope ? accountScopeKey(scope) : '';
  let view = scoped.get(key);
  if (!view) { view = buildView(state, scope); scoped.set(key, view); }
  return view;
}
