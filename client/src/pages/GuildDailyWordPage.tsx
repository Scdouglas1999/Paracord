import { useParams } from 'react-router';
import { useGuild } from '../hooks/useGuilds';
import { DailyWordView } from '../components/dailyWord/DailyWordView';

/** Route element for `guilds/:guildId/daily-word`. */
export function GuildDailyWordPage() {
  const { guildId = '' } = useParams();
  const guild = useGuild(guildId);
  return <DailyWordView guildId={guildId} serverName={guild?.name ?? ''} />;
}
