import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useGuild } from '../hooks/useGuilds';
import { useGameDetail } from '../hooks/useGameDetail';
import { GameDetailView } from '../components/sports/GameDetailView';
import { sportsHref, stripMatchup } from '../components/sports/model';
import { ServerPage } from '../components/rooms/lobby';
import { usePushedPageKeys } from '../components/rooms/lobby/usePushedPageKeys';

/**
 * Route element for `guilds/:guildId/sports/:sport/:league/:eventId`: one game, a
 * pushed page (docs/index-spec.md §6.1): the matchup is the title, the toolbar has a
 * back chevron to the board, and Esc and Alt+Left go back too.
 */
export function GuildSportsGamePage() {
  const { guildId = '', sport = '', league = '', eventId = '' } = useParams();
  const guild = useGuild(guildId);
  const navigate = useNavigate();
  // The game's poll is shared by everyone who has it open, so this is not a second fetch.
  const { detail } = useGameDetail(guildId, sport, league, eventId);
  const back = useCallback(() => navigate(sportsHref(guildId)), [guildId, navigate]);
  usePushedPageKeys(back);
  const game = detail?.game ?? null;
  const subtitle = [game?.league, guild?.name].filter(Boolean).join(' · ');
  return (
    <ServerPage
      guildId={guildId}
      title={game ? stripMatchup(game) : 'Game'}
      subtitle={subtitle || undefined}
      onBack={back}
      backLabel="Back to Sports"
      data-testid="ix-game"
    >
      <GameDetailView
        guildId={guildId}
        sport={sport}
        league={league}
        eventId={eventId}
        serverName={guild?.name ?? ''}
        embedded
      />
    </ServerPage>
  );
}
