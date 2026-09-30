import { useParams } from 'react-router';
import { ServerHome } from '../components/rooms/lobby';

/**
 * Route element for `guilds/:guildId`: a server's Overview, opened from the
 * server menu (docs/design/glass-plan.md §8.4; the content is
 * docs/server-home-spec.md's, in the Glass column). It all lives in
 * `components/rooms/lobby/`, so this page stays a thin router adapter.
 */
export function GuildHomePage() {
  const { guildId } = useParams();
  return <ServerHome guildId={guildId || ''} />;
}
