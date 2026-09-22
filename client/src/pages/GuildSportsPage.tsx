import { useParams } from 'react-router';
import { useGuild } from '../hooks/useGuilds';
import { SportsBoardView } from '../components/sports/SportsBoardView';

/** Route element for `guilds/:guildId/sports`. */
export function GuildSportsPage() {
  const { guildId = '' } = useParams();
  const guild = useGuild(guildId);
  return <SportsBoardView guildId={guildId} serverName={guild?.name ?? ''} />;
}
