import type { SportsBoardLeague, SportsDefaultView, SportsGame, SportsTeam } from '../../api/sports';

export const LIVE_POLL_MS = 15_000;
export const QUIET_POLL_MS = 60_000;
export const SCORE_FLASH_MS = 6_000;

const HIDE_SCORES_KEY = 'paracord.sports.hide-scores';
export const HIDE_SCORES_EVENT = 'paracord:hide-sports-scores';

export function readHideScores(): boolean {
  try {
    return localStorage.getItem(HIDE_SCORES_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeHideScores(hidden: boolean): void {
  try {
    localStorage.setItem(HIDE_SCORES_KEY, hidden ? '1' : '0');
  } catch {
    // Storage can be blocked. The choice still applies on this screen, and
    // there is nothing stored for the other open screens to copy.
    return;
  }
  try {
    window.dispatchEvent(new Event(HIDE_SCORES_EVENT));
  } catch {
    // No window in some test hosts.
  }
}

/**
 * Sentence-case a tag from the wire. A 2–3 letter all-caps token stays
 * ("OT", "SO", "ET"), and so does a token that contains a digit ("2OT").
 * Words in a phrase still become a sentence ("RED ZONE" → "Red zone").
 */
export function sentenceCaseTag(tag: string): string {
  const trimmed = tag.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const tokens = trimmed.split(' ');
  return tokens.map((token, index) => formatTagToken(token, index, tokens.length)).join(' ');
}

function ariaTag(shown: string): string {
  if (/^[A-Z]{2,3}$/.test(shown)) return shown;
  if (/\d/.test(shown)) return shown;
  return shown.toLowerCase();
}

function formatTagToken(token: string, index: number, count: number): string {
  if (/\d/.test(token)) return token;
  if (count === 1 && /^[A-Z]{2,3}$/.test(token)) return token;
  if (count > 1 && /^[A-Z]{2}$/.test(token)) return token;
  const lower = token.toLowerCase();
  if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
  return lower;
}

export function teamLabel(team: SportsTeam): string {
  return team.short_name || team.abbr || team.name || 'Team';
}

export function teamMonogram(team: SportsTeam): string {
  const source = (team.abbr || team.short_name || team.name || '?').trim();
  return source.slice(0, 2).toUpperCase() || '?';
}

export function formatStart(iso: string, now = new Date()): string {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 'Time not set';
  const time = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (start.toDateString() === now.toDateString()) return time;
  const day = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} ${time}`;
}

export function statusLine(game: SportsGame, now = new Date()): string {
  if (game.state === 'pre') return formatStart(game.start, now);
  if (game.detail.trim()) return game.detail.trim();
  return game.state === 'post' ? 'Final' : '';
}

/** One phone line. "8:25 - 1st" becomes "8:25 1st" so the clock cannot wrap on the dash. */
export function pinOneLine(game: SportsGame, hideScores: boolean): string {
  const away = hideScores ? '–' : String(game.away.score ?? '–');
  const home = hideScores ? '–' : String(game.home.score ?? '–');
  const when = statusLine(game).replace(/\s+[–-]\s+/g, ' ');
  return `${game.away.abbr} ${away} · ${when} · ${home} ${game.home.abbr}`;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * A league that failed must not read as a day with no games. When that league
 * still has games, they are the previous good copy.
 */
export function leagueFailureCopy(
  leagues: readonly SportsBoardLeague[],
  games: readonly SportsGame[],
): string | null {
  const failed = leagues.filter((league) => league.error);
  if (failed.length === 0) return null;
  const names = joinLabels(failed.map((league) => league.label));
  const kept = failed.some((league) => games.some((game) => game.league_path === league.path));
  if (kept) return `Scores couldn't be loaded for ${names}. Showing the last ones we got.`;
  return `Scores couldn't be loaded for ${names}.`;
}

export function runnersLabel(game: SportsGame): string {
  const on = [
    game.on_first ? 'first' : null,
    game.on_second ? 'second' : null,
    game.on_third ? 'third' : null,
  ].filter((base): base is string => Boolean(base));
  if (on.length === 0) return 'Bases empty';
  if (on.length === 1) return `Runner on ${on[0]}`;
  if (on.length === 2) return `Runners on ${on[0]} and ${on[1]}`;
  return 'Bases loaded';
}

export function countLabel(game: SportsGame): string {
  const balls = game.balls ?? 0;
  const strikes = game.strikes ?? 0;
  const outs = game.outs ?? 0;
  const ballWord = balls === 1 ? 'ball' : 'balls';
  const strikeWord = strikes === 1 ? 'strike' : 'strikes';
  const outWord = outs === 1 ? 'out' : 'outs';
  return `${balls} ${ballWord}, ${strikes} ${strikeWord}, ${outs} ${outWord}`;
}

export function winChanceLabel(game: SportsGame): string | null {
  if (game.home_win_pct == null || Number.isNaN(game.home_win_pct)) return null;
  const homeLeads = game.home_win_pct >= 0.5;
  const team = homeLeads ? game.home : game.away;
  const pct = Math.round((homeLeads ? game.home_win_pct : 1 - game.home_win_pct) * 100);
  return `${teamLabel(team)} ${pct}% to win`;
}

export function situationTags(game: SportsGame): string[] {
  const tags = game.tags.map(sentenceCaseTag).filter(Boolean);
  if (game.red_zone && !tags.some((tag) => tag.toLowerCase() === 'red zone')) {
    tags.push('Red zone');
  }
  return tags;
}

export function gameAriaLabel(game: SportsGame, hideScores: boolean, now = new Date()): string {
  const away = teamLabel(game.away);
  const home = teamLabel(game.home);
  const bits: string[] = [];
  if (game.state === 'pre') {
    bits.push(`${away} at ${home}`, statusLine(game, now));
  } else if (hideScores) {
    bits.push(`${away} and ${home}`, statusLine(game, now), 'scores hidden');
  } else {
    bits.push(`${away} ${game.away.score ?? 0}`, `${home} ${game.home.score ?? 0}`, statusLine(game, now));
  }
  if (!hideScores && game.state === 'in') {
    if (game.sport === 'baseball' && game.outs != null) {
      bits.push(countLabel(game), runnersLabel(game));
    }
    if (game.down_distance) bits.push(game.down_distance);
    for (const tag of situationTags(game)) bits.push(ariaTag(tag));
  }
  return bits.filter(Boolean).join(', ');
}

function startMs(game: SportsGame): number {
  const ms = Date.parse(game.start);
  return Number.isNaN(ms) ? 0 : ms;
}

export interface GroupedGames {
  yours: SportsGame[];
  live: SportsGame[];
  upcoming: SportsGame[];
  final: SportsGame[];
}

function stateRank(game: SportsGame): number {
  if (game.state === 'in') return 0;
  if (game.state === 'pre') return 1;
  return 2;
}

export function groupGames(
  games: readonly SportsGame[],
  options: { leaguePath: string | null; view: SportsDefaultView; hideScores: boolean },
): GroupedGames {
  let list = games.slice();
  if (options.leaguePath) list = list.filter((game) => game.league_path === options.leaguePath);
  if (options.view === 'live') list = list.filter((game) => game.state === 'in');
  if (options.view === 'favorites') list = list.filter((game) => game.favorite);
  const liveCompare = options.hideScores
    ? (a: SportsGame, b: SportsGame) => startMs(a) - startMs(b)
    : (a: SportsGame, b: SportsGame) => b.heat - a.heat;
  const yoursCompare = (a: SportsGame, b: SportsGame) => {
    const byState = stateRank(a) - stateRank(b);
    if (byState) return byState;
    if (a.state === 'in') return liveCompare(a, b);
    if (a.state === 'pre') return startMs(a) - startMs(b);
    return startMs(b) - startMs(a);
  };
  const yours = list.filter((game) => game.favorite).sort((a, b) => yoursCompare(a, b) || a.id.localeCompare(b.id));
  const rest = list.filter((game) => !game.favorite);
  return {
    yours,
    live: rest.filter((game) => game.state === 'in').sort((a, b) => liveCompare(a, b) || a.id.localeCompare(b.id)),
    upcoming: rest.filter((game) => game.state === 'pre').sort((a, b) => startMs(a) - startMs(b) || a.id.localeCompare(b.id)),
    final: rest.filter((game) => game.state === 'post').sort((a, b) => startMs(b) - startMs(a) || a.id.localeCompare(b.id)),
  };
}

/** The live game with the highest heat, or null when nothing is in progress. */
export function hottestLiveId(games: readonly SportsGame[]): string | null {
  let best: SportsGame | null = null;
  for (const game of games) {
    if (game.state !== 'in') continue;
    if (!best || game.heat > best.heat || (game.heat === best.heat && game.id.localeCompare(best.id) < 0)) {
      best = game;
    }
  }
  return best?.id ?? null;
}

export function countStates(games: readonly SportsGame[]): { live: number; upcoming: number } {
  let live = 0;
  let upcoming = 0;
  for (const game of games) {
    if (game.state === 'in') live += 1;
    else if (game.state === 'pre') upcoming += 1;
  }
  return { live, upcoming };
}

export function liveCount(games: readonly SportsGame[] | undefined): number {
  if (!games) return 0;
  let n = 0;
  for (const game of games) if (game.state === 'in') n += 1;
  return n;
}

export interface StripPick {
  kind: 'live' | 'upcoming' | 'none';
  games: SportsGame[];
}

/** Up to four of the hottest live games, or the next few that have not started. */
export function stripGames(games: readonly SportsGame[]): StripPick {
  const live = games
    .filter((game) => game.state === 'in')
    .sort((a, b) => b.heat - a.heat || a.id.localeCompare(b.id))
    .slice(0, 4);
  if (live.length > 0) return { kind: 'live', games: live };
  const upcoming = games
    .filter((game) => game.state === 'pre')
    .sort((a, b) => startMs(a) - startMs(b) || a.id.localeCompare(b.id))
    .slice(0, 4);
  if (upcoming.length > 0) return { kind: 'upcoming', games: upcoming };
  return { kind: 'none', games: [] };
}

export function scoreKey(game: SportsGame): string {
  return `${game.home.score ?? ''}:${game.away.score ?? ''}`;
}

export interface ScoreChange {
  id: string;
  message: string;
  /** Which side's score went up, when only one side did. */
  side: 'home' | 'away' | null;
}

function scoreFlashMessage(previous: SportsGame, next: SportsGame): { message: string; side: 'home' | 'away' | null } {
  const awayName = teamLabel(next.away);
  const homeName = teamLabel(next.home);
  const awayWas = previous.away.score ?? 0;
  const homeWas = previous.home.score ?? 0;
  const awayNow = next.away.score ?? 0;
  const homeNow = next.home.score ?? 0;
  const line = `${awayName} ${awayNow}, ${homeName} ${homeNow}`;
  if (awayNow > awayWas && homeNow <= homeWas) return { message: `${awayName} scored. ${line}.`, side: 'away' };
  if (homeNow > homeWas && awayNow <= awayWas) return { message: `${homeName} scored. ${line}.`, side: 'home' };
  return { message: `Score update. ${line}.`, side: null };
}

/** Score changes since the previous poll. The first load flashes nothing. */
export function scoreChanges(previous: readonly SportsGame[] | null, next: readonly SportsGame[]): ScoreChange[] {
  if (!previous) return [];
  const before = new Map(previous.map((game) => [game.id, game]));
  const changed: ScoreChange[] = [];
  for (const game of next) {
    const prev = before.get(game.id);
    if (!prev || scoreKey(prev) === scoreKey(game)) continue;
    const flash = scoreFlashMessage(prev, game);
    changed.push({ id: game.id, message: flash.message, side: flash.side });
  }
  return changed;
}

export function stripMatchup(game: SportsGame): string {
  return `${teamLabel(game.away)} at ${teamLabel(game.home)}`;
}

export function stripAriaLabel(game: SportsGame, now = new Date()): string {
  const when = statusLine(game, now);
  const matchup = stripMatchup(game);
  return when ? `${matchup}, ${when}` : matchup;
}

export function isSportsPath(guildId: string, pathname?: string): boolean {
  const path = (pathname ?? (typeof window === 'undefined' ? '' : window.location.pathname)).replace(/\/$/, '');
  const base = `/app/guilds/${guildId}/sports`;
  return path === base || path.startsWith(`${base}/`);
}

/** Deep link for one game. Sport and league are separate path segments. */
export function gameHref(guildId: string, game: { id: string; sport: string; league_path: string }): string {
  const [pathSport, pathLeague] = game.league_path.split('/');
  const sport = pathSport || game.sport;
  const league = pathLeague || 'league';
  return `/app/guilds/${guildId}/sports/${sport}/${league}/${game.id}`;
}

export function sportsHref(guildId: string): string {
  return `/app/guilds/${guildId}/sports`;
}
