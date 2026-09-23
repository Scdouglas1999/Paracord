import { getApi as getActiveApi } from './activeClient';
import type { RestClient } from './restClient';

/** ESPN "{sport}/{league}" path. Exactly one slash, ASCII letters, digits, "." and "-". */
const LEAGUE_PATH = /^[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+$/;
export const LEAGUE_PATH_MAX = 48;
export const LEAGUE_MIN = 1;
export const LEAGUE_MAX = 12;
export const FAVORITE_MAX = 24;

export interface LeagueCatalogEntry {
  path: string;
  label: string;
  sport: string;
}

export interface LeagueCatalog {
  leagues: LeagueCatalogEntry[];
}

export interface SportsFavoriteTeam {
  league: string;
  team_id: string;
  abbr: string;
  name: string;
}

export type SportsDefaultView = 'all' | 'live' | 'favorites';
export type SportsLayout = 'cards' | 'list';

export interface SportsSettings {
  guild_id: string;
  enabled: boolean;
  leagues: string[];
  favorite_teams: SportsFavoriteTeam[];
  show_on_server_page: boolean;
  default_view: SportsDefaultView;
  /** Absent on a server that has not stored the field yet. Cards is the default. */
  layout?: SportsLayout;
  /** Live game pinned above a text channel. Absent until the server stores one. */
  channel_pins?: ChannelPin[];
  /** Members are told when a favorite team scores. Absent on an older server. */
  score_alerts?: boolean;
  updated_at: string;
}

export interface ChannelPin {
  channel_id: string;
  /** `sport/league/event_id`, joined to a board game by league path and id. */
  game: string;
  pinned_by: string;
  pinned_at: string;
  /** The pin drops off at the final instead of a few hours after it. */
  unpin_at_final?: boolean;
}

export interface PinGameOptions {
  unpin_at_final?: boolean;
}

/** Every field optional. `guild_id` and `updated_at` are not writable. */
export interface SportsSettingsUpdate {
  enabled?: boolean;
  leagues?: string[];
  favorite_teams?: SportsFavoriteTeam[];
  show_on_server_page?: boolean;
  default_view?: SportsDefaultView;
  layout?: SportsLayout;
  score_alerts?: boolean;
}

export interface SportsRosterTeam {
  id: string;
  abbr: string;
  name: string;
  short_name: string;
  logo: string;
  color?: string | null;
  alt_color?: string | null;
}

export interface SportsRoster {
  league: string;
  teams: SportsRosterTeam[];
}

export interface SportsBoardLeague {
  path: string;
  label: string;
  error: string | null;
}

export type SportsGameState = 'pre' | 'in' | 'post';

export interface SportsTeam {
  id: string;
  abbr: string;
  name: string;
  short_name: string;
  logo: string;
  score: number | null;
  record: string | null;
  possession: boolean;
  winner: boolean;
  /** Feed color, lowercase rrggbb, or null when the feed has none. */
  color?: string | null;
  alt_color?: string | null;
}

export interface SportsGame {
  id: string;
  sport: string;
  league: string;
  league_path: string;
  name: string;
  start: string;
  state: SportsGameState;
  detail: string;
  period: number | null;
  clock: string | null;
  clock_seconds: number | null;
  home: SportsTeam;
  away: SportsTeam;
  last_play: string | null;
  last_play_type: string | null;
  last_play_score: number | null;
  down_distance: string | null;
  /** Yards from the home goal line, 0..100. Null when the feed has no spot. */
  ball_on: number | null;
  /** Team id of the side with the ball, or null. */
  possession_team_id: string | null;
  /** Yards from the ball to the goal the offense is attacking, or null. */
  yards_to_endzone: number | null;
  red_zone: boolean | null;
  balls: number | null;
  strikes: number | null;
  outs: number | null;
  on_first: boolean | null;
  on_second: boolean | null;
  on_third: boolean | null;
  home_win_pct: number | null;
  broadcasts: string[];
  heat: number;
  tags: string[];
  favorite: boolean;
}

export interface SportsBoard {
  fetched_at: string;
  /** Set when the board was asked for a day. YYYY-MM-DD. */
  date?: string;
  leagues: SportsBoardLeague[];
  games: SportsGame[];
}

export interface StandingsColumn {
  /** ESPN stat type, e.g. `winpercent`. */
  key: string;
  /** Short heading, e.g. `PCT`. */
  label: string;
  /** What the heading means. */
  title: string;
}

export interface StandingsRow {
  team: SportsRosterTeam;
  /** One per column, in column order. Empty when the feed has no value. */
  values: string[];
  seed: number | null;
  /** ESPN's clinch mark, such as `x`, `y`, `z` or `e`. */
  clincher: string | null;
  favorite: boolean;
}

export interface StandingsGroup {
  name: string;
  /** The conference a division sits in, when the league nests them. */
  parent: string | null;
  rows: StandingsRow[];
}

export interface LeagueStandings {
  league: string;
  label: string;
  season: string | null;
  fetched_at: string;
  /** The last refresh failed and this is the last good table. */
  stale: boolean;
  columns: StandingsColumn[];
  groups: StandingsGroup[];
}

/** Sent to a server's members for each score in a favorite team's game, and its final. */
export interface SportsScoreEvent {
  guild_id: string;
  /** `sport/league/event_id`. */
  game: string;
  league_path: string;
  event_id: string;
  kind: 'score' | 'final';
  /** The same sentence a pinned channel gets. */
  content: string;
  /** The team that scored, or null for the final. */
  team_id: string | null;
  favorite_team_ids: string[];
  home: SportsScoreEventTeam;
  away: SportsScoreEventTeam;
}

export interface SportsScoreEventTeam {
  id: string;
  abbr: string;
  name: string;
  score: number | null;
  logo: string;
}

export type GameDetailKind = 'football' | 'baseball' | 'other';

export interface SportsAthlete {
  id: string;
  name: string;
  short_name: string;
  headshot: string;
  /** Position abbreviation from the feed, or null when it has none. */
  position?: string | null;
}

export interface LineScoreSide {
  periods: (number | null)[];
  total: number | null;
  hits: number | null;
  errors: number | null;
}

export interface LineScore {
  periods: string[];
  home: LineScoreSide;
  away: LineScoreSide;
}

export interface GameLeader {
  team_id: string;
  category: string;
  label: string;
  athlete: SportsAthlete;
  value: string;
}

export interface GameProbable {
  team_id: string;
  athlete: SportsAthlete;
  role: string;
  note: string;
}

export interface BoxRow {
  athlete: SportsAthlete;
  position: string;
  values: string[];
}

export interface BoxTable {
  type: string;
  columns: string[];
  rows: BoxRow[];
}

export interface BoxScore {
  home: BoxTable[];
  away: BoxTable[];
}

export interface WinProbabilityPoint {
  home_pct: number;
}

export interface ScoringPlay {
  text: string;
  period: number | null;
  clock: string | null;
  team_id: string | null;
  home_score: number | null;
  away_score: number | null;
}

export interface FootballPlay {
  id: string;
  text: string;
  type: string | null;
  period: number | null;
  clock: string | null;
  start_yard: number | null;
  end_yard: number | null;
  down: number | null;
  distance: number | null;
  yards: number | null;
  scoring: boolean;
  team_id: string | null;
}

export interface FootballDrive {
  id: string;
  team_id: string | null;
  description: string | null;
  result: string | null;
  is_score: boolean;
  start_yard: number | null;
  end_yard: number | null;
  plays: FootballPlay[];
  live?: boolean;
}

export interface FootballDetail {
  possession_team_id: string | null;
  ball_on: number | null;
  down: number | null;
  distance: number | null;
  yards_to_endzone: number | null;
  down_distance_text: string | null;
  red_zone: boolean | null;
  drives: FootballDrive[];
}

export type PitchResult = 'ball' | 'strike-looking' | 'strike-swinging' | 'foul' | 'in-play' | 'other';

export interface Pitch {
  n: number;
  x: number | null;
  y: number | null;
  type: string | null;
  type_abbr: string | null;
  velocity: number | null;
  result: PitchResult | null;
  text: string | null;
}

export interface HitSpot {
  x: number;
  y: number;
  trajectory: string | null;
}

export interface AtBat {
  id: string;
  inning: number | null;
  half: 'top' | 'bottom' | null;
  batter: SportsAthlete | null;
  pitcher: SportsAthlete | null;
  result_text: string | null;
  scoring: boolean;
  pitches: Pitch[];
  hit: HitSpot | null;
  live?: boolean;
}

export interface BaseballDetail {
  inning: number | null;
  half: 'top' | 'bottom' | null;
  balls: number | null;
  strikes: number | null;
  outs: number | null;
  bases: {
    first: SportsAthlete | null;
    second: SportsAthlete | null;
    third: SportsAthlete | null;
  };
  pitcher: SportsAthlete | null;
  batter: SportsAthlete | null;
  bats: 'L' | 'R' | 'S' | null;
  strike_zone: { left: number; right: number; top: number; bottom: number } | null;
  at_bats: AtBat[];
}

export interface GameDetail {
  fetched_at: string;
  stale: boolean;
  game: SportsGame;
  kind: GameDetailKind;
  win_probability: WinProbabilityPoint[];
  scoring_plays: ScoringPlay[];
  line_score: LineScore | null;
  leaders: GameLeader[];
  probables: GameProbable[];
  box: BoxScore | null;
  football?: FootballDetail | null;
  baseball?: BaseballDetail | null;
}

/**
 * Client-side check matching the contract: the path is placed in an outbound
 * URL, so it is exactly one slash, ASCII letters, digits, "." and "-", and at
 * most 48 characters. Returns a sentence a person can act on, or null.
 */
export function leaguePathError(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return 'Enter a league path, like football/nfl.';
  if (trimmed.length > LEAGUE_PATH_MAX) {
    return 'That path is too long. Keep it to 48 characters.';
  }
  if (!LEAGUE_PATH.test(trimmed)) {
    return 'Use a path like football/nfl: letters, digits, dots and dashes, with one slash.';
  }
  return null;
}

export function asDefaultView(value: string | null | undefined): SportsDefaultView {
  if (value === 'live' || value === 'favorites' || value === 'all') return value;
  return 'all';
}

export function asLayout(value: string | null | undefined): SportsLayout {
  return value === 'list' ? 'list' : 'cards';
}

export function createSportsApi(getApi: () => RestClient) {
  return {
    listLeagues: () => getApi().get<LeagueCatalog>('/sports/leagues'),
    getSettings: (guildId: string) =>
      getApi().get<SportsSettings>(`/guilds/${guildId}/sports`),
    updateSettings: (guildId: string, body: SportsSettingsUpdate) =>
      getApi().put<SportsSettings>(`/guilds/${guildId}/sports`, body),
    getBoard: (guildId: string, date?: string) => {
      const query = date ? `?date=${encodeURIComponent(date)}` : '';
      return getApi().get<SportsBoard>(`/guilds/${guildId}/sports/board${query}`);
    },
    listTeams: (leaguePath: string) => {
      const message = leaguePathError(leaguePath);
      if (message) return Promise.reject(new Error(message));
      return getApi().get<SportsRoster>(`/sports/leagues/${leaguePath.trim()}/teams`);
    },
    pinGame: (guildId: string, channelId: string, game: string, options: PinGameOptions = {}) =>
      getApi().put<SportsSettings>(`/guilds/${guildId}/sports/pins/${channelId}`, { game, ...options }),
    unpinGame: (guildId: string, channelId: string) =>
      getApi().delete<SportsSettings>(`/guilds/${guildId}/sports/pins/${channelId}`),
    getStandings: (guildId: string, leaguePath: string) => {
      const message = leaguePathError(leaguePath);
      if (message) return Promise.reject(new Error(message));
      return getApi().get<LeagueStandings>(`/guilds/${guildId}/sports/standings/${leaguePath.trim()}`);
    },
    getGame: (guildId: string, sport: string, league: string, eventId: string) => {
      const message = leaguePathError(`${sport}/${league}`);
      if (message) return Promise.reject(new Error(message));
      if (!/^[0-9]{1,20}$/.test(eventId)) {
        return Promise.reject(new Error('That game id is not valid.'));
      }
      return getApi().get<GameDetail>(
        `/guilds/${guildId}/sports/games/${sport}/${league}/${eventId}`,
      );
    },
  };
}

export const sportsApi = createSportsApi(getActiveApi);
