import { useEffect, useMemo, useRef } from 'react';

import { displayName } from '../../../lib/displayName';
import { useGuildStore } from '../../../stores/guildStore';
import { useCardWorld } from '../card/useCardWorld';
import type { Place } from '../shell/place';
import { announcementsBetween, voiceSnapshot, type VoiceSnapshot } from './announcements';
import { announce, useAnnouncerStore } from './announcer';

/**
 * The Index's polite live region and what feeds it (docs/index-spec.md §10).
 * Mounted once by the frame. It reads the same world the room card does
 * (`useCardWorld`), so it re-renders on voice changes only, and says what
 * `announcementsBetween` finds in each change, paced by `announce`.
 */
export function IxAnnouncer({ place }: { place: Place }) {
  useCallAnnouncements(place);
  const text = useAnnouncerStore((state) => state.text);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="ix-announcer">
      {text}
    </div>
  );
}

function useCallAnnouncements(place: Place): void {
  const world = useCardWorld();
  const guilds = useGuildStore((state) => state.guilds);
  const guildIds = useMemo(() => guilds.map((guild) => guild.id), [guilds]);
  const before = useRef<VoiceSnapshot | null>(null);
  const currentGuildId = place.kind === 'server' ? place.guildId : null;

  useEffect(() => {
    if (!world) return;
    const after = voiceSnapshot(world.channelParticipants, guildIds);
    const said = announcementsBetween(before.current, after, {
      me: world.selfUserId,
      currentGuildId,
      callChannelId: world.held?.channelId ?? null,
      personName: (userId, channelId) => {
        const known = world.people.get(userId)?.name;
        if (known) return known;
        const state = world.channelParticipants.get(channelId)?.find((entry) => entry.user_id === userId);
        if (!state || (!state.display_name && !state.username)) return null;
        return displayName({ username: state.username, display_name: state.display_name });
      },
      channelName: (channelId) => world.channels.get(channelId)?.name || null,
      guildName: (guildId) => world.guildNames.get(guildId) ?? null,
    });
    before.current = after;
    for (const sentence of said) announce(sentence);
    // `currentGuildId` is read, not watched: switching place is not an event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, guildIds]);
}
