import { createChannelApi } from '../api/channels';
import { createGuildApi } from '../api/guilds';
import type { OperationContext } from './operationContext';

export async function fetchVisibleGuildChannels(context: OperationContext, guildId: string) {
  const [{ data: channels }, { data: visibility }] = await Promise.all([
    createGuildApi(() => context.api).getChannels(guildId),
    createChannelApi(() => context.api).getVisibleChannels(guildId),
  ]);
  context.assertCurrent();
  if (!Array.isArray(channels) || !Array.isArray(visibility.channel_ids) || !visibility.channel_ids.every(id => typeof id === 'string')) {
    throw new Error('The instance returned an invalid channel visibility response.');
  }
  const visible = new Set(visibility.channel_ids);
  return channels.filter(channel => visible.has(channel.id)).sort((a, b) => a.position - b.position);
}
