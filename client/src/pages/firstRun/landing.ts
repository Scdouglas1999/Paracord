import { getServerApi } from '../../api/activeClient';
import { createInviteApi } from '../../api/invites';
import { LOCAL_SERVER_ID } from '../../lib/serverScope';

/**
 * Where the first run lands (docs/setup-spec.md §1.13: "Route lands on the
 * server's general channel") and the home-server calls the steps make once the
 * account exists. Everything goes to the home server (`LOCAL_SERVER_ID`): the
 * first run points the app at its server before the account is made.
 */

interface ChannelRow {
  id: string;
  name?: string | null;
  type?: number | null;
  position?: number | null;
}

/** Text channels are type 0 (Discord numbering, kept by Paracord). */
const TEXT = 0;

/** Invites on the home server (the active server may still be unset during the first run). */
export const homeInvites = createInviteApi(() => getServerApi(LOCAL_SERVER_ID));

/** The server's `general` channel, else its first text channel. */
export async function firstTextChannel(guildId: string, preferred?: string | null): Promise<string | null> {
  if (preferred) return preferred;
  const { data } = await getServerApi(LOCAL_SERVER_ID).get<ChannelRow[]>(`/guilds/${guildId}/channels`);
  const text = (Array.isArray(data) ? data : []).filter((c) => (c.type ?? TEXT) === TEXT).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return (text.find((c) => c.name === 'general') ?? text[0])?.id ?? null;
}

export function landingPath(guildId: string | null, channelId: string | null): string {
  if (guildId && channelId) return `/app/guilds/${guildId}/channels/${channelId}`;
  if (guildId) return `/app/guilds/${guildId}`;
  return '/app';
}

/** Join the invite's server with the new account (`POST /invites/{code}`, as the client always has). */
export async function acceptInvite(code: string): Promise<{ guildId: string; channelId: string | null; name: string }> {
  const { data } = await homeInvites.accept(code);
  const guild = data.guild;
  const channelId = await firstTextChannel(guild.id, guild.default_channel_id);
  return { guildId: guild.id, channelId, name: guild.name };
}
