import { useState } from 'react';
import { useParams } from 'react-router';

import { EventList } from '../components/guild/EventList';
import { ServerPage } from '../components/rooms/lobby';
import { useGuild } from '../hooks/useGuilds';

/** "3 events still to come" (docs/index-spec.md §8.3). */
function comingLine(count: number | null): string | null {
  if (count === null) return null;
  if (count === 0) return 'Nothing is coming up';
  return `${count} ${count === 1 ? 'event' : 'events'} still to come`;
}

/**
 * Route element for `guilds/:guildId/events`: a server's full calendar as a page in
 * main (docs/index-spec.md §8.3). It is reached from the server menu's "Events", the
 * Overview's Calendar link and its Events chip; the sidebar's Coming up opens one event.
 */
export function GuildEventsPage() {
  const { guildId = '' } = useParams();
  const guild = useGuild(guildId);
  const [coming, setComing] = useState<number | null>(null);
  const subtitle = [guild?.name, comingLine(coming)].filter(Boolean).join(' · ');

  return (
    <ServerPage guildId={guildId} title="Events" subtitle={subtitle || undefined} data-testid="ix-events">
      <EventList guildId={guildId} variant="page" onUpcomingCount={setComing} />
    </ServerPage>
  );
}
