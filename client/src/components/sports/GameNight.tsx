import type { BaseballDetail, FootballDetail, SportsAthlete, SportsGame } from '../../api/sports';
import { useGameDetail } from '../../hooks/useGameDetail';
import { Diamond } from './BaseballPanels';
import { FootballField } from './FootballField';
import {
  baseballFieldLabel,
  baseballScorebug,
  footballFieldLabel,
  situationBugText,
  yardSpot,
} from './gamecast';
import { statusLine } from './model';

function runner(on: boolean | null, id: string): SportsAthlete | null {
  if (!on) return null;
  return { id, name: 'Runner', short_name: '', headshot: '' };
}

/** Enough of a ballpark to draw before the shared detail poll answers. */
function boardBallpark(game: SportsGame): BaseballDetail {
  const text = game.detail.toLowerCase();
  const half = text.includes('bot') || text.includes('bottom')
    ? 'bottom'
    : text.includes('top')
      ? 'top'
      : null;
  return {
    inning: game.period,
    half,
    balls: game.balls,
    strikes: game.strikes,
    outs: game.outs,
    bases: {
      first: runner(game.on_first, 'board-first'),
      second: runner(game.on_second, 'board-second'),
      third: runner(game.on_third, 'board-third'),
    },
    pitcher: null,
    batter: null,
    bats: null,
    strike_zone: null,
    at_bats: [],
  };
}

/**
 * The field or ballpark inside an expanded pin. Detail polling is the same
 * watcher the game page uses, so the two do not fetch twice.
 */
export function GameNight({
  guildId,
  game,
  hideScores,
}: {
  guildId: string;
  game: SportsGame;
  hideScores: boolean;
}) {
  const [sport, league] = game.league_path.split('/');
  const { detail } = useGameDetail(guildId, sport || game.sport, league || 'league', game.id);
  const away = hideScores ? '–' : (game.away.score ?? '–');
  const home = hideScores ? '–' : (game.home.score ?? '–');
  return (
    <div className="pc-sports-pin-stage">
      {game.sport === 'baseball' ? (
        <NightBallpark game={detail?.game ?? game} baseball={detail?.baseball ?? boardBallpark(game)} hideScores={hideScores} />
      ) : (
        <NightField game={game} football={detail?.football ?? null} hideScores={hideScores} />
      )}
      <div className="pc-sports-scorestrip" aria-hidden>
        <span className="pc-mono">{game.away.abbr} {away}</span>
        <span className="pc-mono">{statusLine(game)}</span>
        <span className="pc-mono">{home} {game.home.abbr}</span>
      </div>
    </div>
  );
}

function NightField({
  game,
  football,
  hideScores,
}: {
  game: SportsGame;
  football: FootballDetail | null;
  hideScores: boolean;
}) {
  const drives = football?.drives ?? [];
  const drive = drives[drives.length - 1] ?? null;
  const plays = drive?.plays ?? [];
  const yards = football?.ball_on ?? game.ball_on;
  const possession = football?.possession_team_id ?? game.possession_team_id;
  const downText = football?.down_distance_text ?? game.down_distance;
  const possessionAbbr = possession === game.away.id ? game.away.abbr : possession === game.home.id ? game.home.abbr : null;
  const spot = yards == null ? null : yardSpot(yards, game.home.abbr, game.away.abbr);
  return (
    <FootballField
      yards={yards}
      possessionTeamId={possession}
      home={game.home}
      away={game.away}
      distance={null}
      redZone={(football?.red_zone ?? game.red_zone) === true}
      live={game.state === 'in'}
      plays={plays}
      driveTeamId={drive?.team_id ?? null}
      playIndex={Math.max(0, plays.length - 1)}
      label={footballFieldLabel({
        ballOn: yards,
        downText,
        homeAbbr: game.home.abbr,
        awayAbbr: game.away.abbr,
        possessionAbbr,
      }) || 'Football field'}
      notice={null}
      flat={false}
      bugText={situationBugText({
        state: game.state,
        downText,
        spot,
        clock: game.clock,
        awayAbbr: game.away.abbr,
        homeAbbr: game.home.abbr,
        awayScore: game.away.score,
        homeScore: game.home.score,
        hideScores,
      })}
    />
  );
}

function NightBallpark({
  game,
  baseball,
  hideScores,
}: {
  game: SportsGame;
  baseball: BaseballDetail;
  hideScores: boolean;
}) {
  const live = game.state === 'in';
  const status = baseballScorebug({
    state: game.state,
    detail: game.detail,
    half: baseball.half,
    inning: baseball.inning,
    balls: baseball.balls,
    strikes: baseball.strikes,
    outs: baseball.outs,
  });
  const batting = baseball.half === 'bottom' ? game.home : baseball.half === 'top' ? game.away : null;
  const other = batting?.id === game.home.id ? game.away : game.home;
  return (
    <Diamond
      baseball={baseball}
      game={game}
      hit={null}
      hitKey=""
      batting={batting}
      battingOther={batting ? other : null}
      label={baseballFieldLabel({
        live,
        status,
        half: baseball.half,
        inning: baseball.inning,
        outs: baseball.outs,
        balls: baseball.balls,
        strikes: baseball.strikes,
        bases: baseball.bases,
      })}
      flat={false}
      hideScores={hideScores}
      status={status}
    />
  );
}
