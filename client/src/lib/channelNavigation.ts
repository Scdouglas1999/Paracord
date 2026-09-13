import type { ChannelReference } from './channelScope';
import { getServerAccountScope } from './serverIdentity';
import { accountScopeKey, LOCAL_SERVER_ID } from './serverScope';
import { OperationExpiredError } from './operationContext';
import { useServerListStore } from '../stores/serverListStore';
import { useChannelStore } from '../stores/channelStore';

export function activateChannel(channel: ChannelReference) {
  const current = getServerAccountScope(channel.scope.serverId);
  if (!current || accountScopeKey(current) !== accountScopeKey(channel.scope)) throw new OperationExpiredError();
  useServerListStore.getState().setActive(channel.scope.serverId === LOCAL_SERVER_ID ? null : channel.scope.serverId);
  useChannelStore.getState().selectChannel(channel);
}
