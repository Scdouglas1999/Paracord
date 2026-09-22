import { useParams } from 'react-router';
import { useGuild } from '../hooks/useGuilds';
import { GameDetailView } from '../components/sports/GameDetailView';

/** Route element for `guilds/:guildId/sports/:sport/:league/:eventId`. */
export function GuildSportsGamePage() {
  const { guildId = '', sport = '', league = '', eventId = '' } = useParams();
  const guild = useGuild(guildId);
  return (
    <GameDetailView
      guildId={guildId}
      sport={sport}
      league={league}
      eventId={eventId}
      serverName={guild?.name ?? ''}
    />
  );
}
