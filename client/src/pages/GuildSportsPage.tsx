import { useParams } from 'react-router';
import { useGuild } from '../hooks/useGuilds';
import { ServerPage } from '../components/rooms/lobby';
import { SportsBoardView } from '../components/sports/SportsBoardView';

/**
 * Route element for `guilds/:guildId/sports`: the Sports add-on's board as a page in
 * main (docs/index-spec.md §8.3). The page is the chrome (the large title, the
 * server, the toolbar); the board keeps its own look.
 */
export function GuildSportsPage() {
  const { guildId = '' } = useParams();
  const guild = useGuild(guildId);
  const serverName = guild?.name ?? '';
  return (
    <ServerPage guildId={guildId} title="Sports" subtitle={serverName || undefined} data-testid="ix-sports">
      <SportsBoardView guildId={guildId} serverName={serverName} embedded />
    </ServerPage>
  );
}
