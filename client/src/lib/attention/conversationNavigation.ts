import { activateChannel } from '../channelNavigation';
import { activateGuild } from '../guildNavigation';
import type { ConversationEntry } from './conversationModel';

/** Validate and activate the row's account before resolving its local route. */
export function activateConversation(entry: ConversationEntry): string {
  if (entry.kind === 'guild_home' && entry.guildId) {
    activateGuild({ scope: entry.scope, id: entry.guildId });
    return `/app/guilds/${entry.guildId}`;
  }
  activateChannel({ scope: entry.scope, id: entry.channelId });
  return entry.guildId
    ? `/app/guilds/${entry.guildId}/channels/${entry.channelId}`
    : `/app/dms/${entry.channelId}`;
}
