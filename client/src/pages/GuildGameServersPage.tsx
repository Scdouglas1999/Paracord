import { useParams } from 'react-router';

import { GameServersPage } from '../components/gameServers/GameServersPage';

/** Route element for `guilds/:guildId/game-servers`. */
export function GuildGameServersPage() {
  const { guildId = '' } = useParams();
  return <GameServersPage guildId={guildId} />;
}
