import { useParams } from 'react-router';
import { useGuild } from '../hooks/useGuilds';
import { ServerPage } from '../components/rooms/lobby';
import { DailyWordView } from '../components/dailyWord/DailyWordView';

/**
 * Route element for `guilds/:guildId/daily-word`: the Daily word add-on's puzzle as a
 * page in main (docs/index-spec.md §8.3). The page is the chrome; the game keeps its
 * own look.
 */
export function GuildDailyWordPage() {
  const { guildId = '' } = useParams();
  const guild = useGuild(guildId);
  const serverName = guild?.name ?? '';
  return (
    <ServerPage guildId={guildId} title="Daily word" subtitle={serverName || undefined} data-testid="ix-daily-word">
      <DailyWordView guildId={guildId} serverName={serverName} embedded />
    </ServerPage>
  );
}
