import { useMemo } from 'react';
import { useChannelStore } from '../stores/channelStore';
import { useCurrentAccountScope } from './useCurrentUser';
import { accountScopeKey } from '../lib/serverScope';
import { EMPTY_CHANNELS } from '../lib/channelScope';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { getServerAccountScope } from '../lib/serverIdentity';

import { getAccountChannelView, actionsFor } from '../lib/channelView';
export { getAccountChannelView } from '../lib/channelView';
export function useCurrentChannelStore<T>(selector: (view: ReturnType<typeof getAccountChannelView>) => T): T {
  const scope = useCurrentAccountScope();
  return useChannelStore(state => selector(getAccountChannelView(scope, state)));
}
export function useChannel(id: string | null | undefined) {
  return useCurrentChannelStore(view => id ? view.channelsById[id] : undefined);
}
export function useGuildChannels(id: string | null | undefined) {
  return useCurrentChannelStore(view => id != null ? view.channelsByGuild[id] ?? EMPTY_CHANNELS : EMPTY_CHANNELS);
}
/** Cross-server views expose ownership on every item and exclude revoked accounts. */
export function useAvailableChannels() {
  const channels = useChannelStore(state => state.channelsById);
  const user = useAuthStore(state => state.user);
  const token = useAuthStore(state => state.token);
  const servers = useServerListStore(state => state.servers);
  return useMemo(() => {
    void user; void token; void servers;
    return Object.values(channels).filter(channel => {
      const scope = getServerAccountScope(channel.scope.serverId);
      return scope && accountScopeKey(scope) === accountScopeKey(channel.scope);
    });
  }, [channels, user, token, servers]);
}

export function useChannelActions() { return actionsFor(useCurrentAccountScope()); }
