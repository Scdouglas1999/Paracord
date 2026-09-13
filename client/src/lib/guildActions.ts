import { createChannelApi } from '../api/channels';
import { extractApiError } from '../api/client';
import { useReadStateStore } from '../stores/readStateStore';
import type { GuildReference } from './guildScope';
import { fetchVisibleGuildChannels } from './guildChannels';
import { captureScopedOperation } from './operationContext';

/** Background actions never read the selected server's channel cache. */
export async function markGuildRead(guild: GuildReference): Promise<void> {
  const context = captureScopedOperation(guild.scope);
  try {
    const channels = (await fetchVisibleGuildChannels(context, guild.id))
      .filter(channel => (channel.type ?? channel.channel_type) !== 4 && !!channel.last_message_id);
    const api = createChannelApi(() => context.api);
    const failures: unknown[] = [];
    for (let offset = 0; offset < channels.length; offset += 8) {
      context.assertCurrent();
      const results = await Promise.allSettled(channels.slice(offset, offset + 8).map(async channel => {
        await api.updateReadState(channel.id, channel.last_message_id!);
        context.assertCurrent();
        useReadStateStore.getState().markRead(guild.scope, channel.id, channel.last_message_id!);
      }));
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    }
    context.assertCurrent();
    if (failures.length) throw new Error(`${failures.length} of ${channels.length} channels could not be marked read: ${extractApiError(failures[0])}`);
  } finally { context.dispose(); }
}
