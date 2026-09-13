/**
 * Load every building's rooms and members, once (docs/lantern-stage-spec.md §7.1).
 *
 * The Buildings column draws a window map, a "24 in" count and a room list for
 * **every** building you belong to, not just the one you are standing in — so
 * every building's roster has to be in hand wherever you are. Before this hook
 * only Home fetched them, and the moment you walked into one building the
 * others collapsed to "0 in · Dark · nobody in" with no rooms: a building full
 * of people reading as dead, which is the one thing the light must never do.
 *
 * Both store fetches de-duplicate an in-flight request and both record a
 * loaded/error flag, so this is safe to mount on more than one surface and safe
 * to re-run on every presence tick.
 */

import { useEffect } from 'react';

import { useChannelStore } from '../stores/channelStore';
import { useMemberStore } from '../stores/memberStore';
import { useAvailableGuilds } from './useGuilds';

export function useBuildingRosters(): void {
  const guilds = useAvailableGuilds();
  const fetchChannels = useChannelStore((state) => state.fetchChannels);
  const fetchMembers = useMemberStore((state) => state.fetchMembers);

  useEffect(() => {
    for (const guild of guilds) {
      const channels = useChannelStore.getState();
      // A building that already failed keeps its error rather than retrying on
      // every tick; the surfaces that own a retry (Home's "refresh", the guild
      // route's error screen) ask again explicitly.
      if (
        !channels.guildChannelsLoaded[guild.key]
        && !channels.loading[guild.key]
        && !channels.errors[guild.key]
      ) {
        void fetchChannels(guild.id, guild.scope);
      }
      const members = useMemberStore.getState();
      if (!members.membersLoaded[guild.key] && !members.loading[guild.key]) {
        void fetchMembers(guild.id, guild.scope);
      }
    }
  }, [guilds, fetchChannels, fetchMembers]);
}
