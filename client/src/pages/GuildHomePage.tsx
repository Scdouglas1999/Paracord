import { useParams } from 'react-router';
import { Lobby } from '../components/rooms/lobby';

/**
 * Route element for `guilds/:guildId` — the building's front door.
 *
 * The guild's home is the **Lobby** (docs/lantern-stage-spec.md §7.3): the
 * building seen from the street, with a window for every room. All of it lives
 * in `components/rooms/lobby/`, so this page stays a thin router adapter.
 */
export function GuildHomePage() {
  const { guildId } = useParams();
  return <Lobby guildId={guildId || ''} />;
}
