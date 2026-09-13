import { useGuildStore } from '../stores/guildStore';
import { useServerListStore } from '../stores/serverListStore';
import { getServerAccountScope } from './serverIdentity';
import { accountScopeKey, LOCAL_SERVER_ID } from './serverScope';
import { captureScopedOperation } from './operationContext';
import { fetchVisibleGuildChannels } from './guildChannels';
import type { GuildReference, ScopedGuild } from './guildScope';

/** Activate the exact account represented by a row; never retarget a stale row. */
export function activateGuild(guild: GuildReference): void {
  const current = getServerAccountScope(guild.scope.serverId);
  if (!current || accountScopeKey(current) !== accountScopeKey(guild.scope)) {
    throw new Error('The account for this building is no longer signed in.');
  }
  useServerListStore.getState().setActive(guild.scope.serverId === LOCAL_SERVER_ID ? null : guild.scope.serverId);
  useGuildStore.getState().selectGuild(guild);
}

/** Resolve a landing channel against the captured server before navigating. */
export async function guildLandingPath(guild: ScopedGuild): Promise<string> {
  const context = captureScopedOperation(guild.scope);
  try {
    const available = (await fetchVisibleGuildChannels(context, guild.id))
      .filter(channel => (channel.type ?? channel.channel_type) !== 4);
    const first = available.find(channel => channel.id === guild.default_channel_id)
      ?? available.find(channel => (channel.type ?? channel.channel_type) === 0)
      ?? available[0];
    activateGuild(guild);
    if (first) return `/app/guilds/${guild.id}/channels/${first.id}`;
    return `/app/guilds/${guild.id}`;
  } finally { context.dispose(); }
}
