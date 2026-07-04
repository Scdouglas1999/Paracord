import { useParams } from 'react-router-dom';
import { RoomsView } from '../components/rooms/RoomsView';

/**
 * Route element for `guilds/:guildId` — the guild's home is the presence-first
 * Rooms view (formerly the server hub). All content lives in RoomsView so
 * the page is a thin router adapter.
 */
export function GuildHomePage() {
  const { guildId } = useParams();
  return <RoomsView guildId={guildId || ''} />;
}
