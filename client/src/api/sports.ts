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
  updated_at: string;
}

/** Every field optional. `guild_id` and `updated_at` are not writable. */
export interface SportsSettingsUpdate {
  enabled?: boolean;
  leagues?: string[];
  favorite_teams?: SportsFavoriteTeam[];
  show_on_server_page?: boolean;
  default_view?: SportsDefaultView;
  layout?: SportsLayout;
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
  leagues: SportsBoardLeague[];
  games: SportsGame[];
}

export type GameDetailKind = 'football' | 'baseball' | 'other';

export interface SportsAthlete {
  id: string;
  name: string;
  short_name: string;
  headshot: string;
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
    getBoard: (guildId: string) =>
      getApi().get<SportsBoard>(`/guilds/${guildId}/sports/board`),
    listTeams: (leaguePath: string) => {
      const message = leaguePathError(leaguePath);
      if (message) return Promise.reject(new Error(message));
      return getApi().get<SportsRoster>(`/sports/leagues/${leaguePath.trim()}/teams`);
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
