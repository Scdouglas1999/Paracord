import { useParams } from 'react-router';
import { ServerHome } from '../components/rooms/lobby';

/**
 * Route element for `guilds/:guildId`: the server home page
 * (docs/server-home-spec.md). It all lives in `components/rooms/lobby/`, so
 * this page stays a thin router adapter.
 */
export function GuildHomePage() {
  const { guildId } = useParams();
  return <ServerHome guildId={guildId || ''} />;
}
