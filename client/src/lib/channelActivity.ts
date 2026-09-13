import type { Channel } from '../types';

export interface ChannelActivity {
  channel_id: string;
  guild_id: string | null;
  last_message_id: string | null;
  revision: string;
}

const MAX_I64 = 9223372036854775807n;
function integer(value: unknown, allowZero: boolean): value is string {
  return typeof value === 'string' && (allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)
    && value.length <= 19 && BigInt(value) <= MAX_I64;
}
export function isChannelActivity(value: unknown): value is ChannelActivity {
  if (!value || typeof value !== 'object') return false;
  const activity = value as Partial<ChannelActivity>;
  return integer(activity.channel_id, false) && integer(activity.revision, true)
    && (activity.guild_id === null || integer(activity.guild_id, false))
    && (activity.last_message_id === null || integer(activity.last_message_id, false));
}

/** Merge ordinary channel metadata while retaining the newest known activity. */
export function preserveChannelActivity<T extends Partial<Channel>>(current: Partial<Channel> | undefined, incoming: T): T {
  if (!current || !integer(current.message_revision, true)) return incoming;
  if (integer(incoming.message_revision, true) && BigInt(incoming.message_revision) > BigInt(current.message_revision)) return incoming;
  return { ...incoming, last_message_id: current.last_message_id, message_revision: current.message_revision };
}
