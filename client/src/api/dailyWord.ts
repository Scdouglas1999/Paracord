import axios from 'axios';
import { getApi as getActiveApi } from './activeClient';
import type { RestClient } from './restClient';

/** What one letter of a guess says about the answer. */
export type LetterState = 'correct' | 'present' | 'absent';

export interface DailyWordGuess {
  word: string;
  states: LetterState[];
}

export interface DailyWordDefinition {
  part_of_speech: string;
  text: string;
}

/** Your game today. The answer and definition arrive only once you have finished. */
export interface DailyWordToday {
  puzzle: number;
  /** The UTC day, YYYY-MM-DD. */
  date: string;
  /** Midnight UTC, when the next word arrives. */
  next_puzzle_at: string;
  word_length: number;
  max_guesses: number;
  guesses: DailyWordGuess[];
  finished: boolean;
  solved: boolean;
  answer?: string;
  definition?: DailyWordDefinition | null;
}

export interface DailyWordStats {
  puzzle: number;
  played: number;
  solved: number;
  missed: number;
  current_streak: number;
  max_streak: number;
  /** Solves in 1 through 6 guesses. */
  distribution: number[];
}

export interface DailyWordBoardUser {
  id: string;
  username: string;
  display_name: string | null;
  avatar_hash: string | null;
  nick: string | null;
}

export interface DailyWordBoardEntry {
  user: DailyWordBoardUser;
  finished: boolean;
  solved: boolean;
  guess_count: number;
  /** Letter states only. Empty while that person is still playing. */
  grid: LetterState[][];
}

export interface DailyWordBoard {
  guild_id: string;
  puzzle: number;
  played: number;
  finished: number;
  solved: number;
  solvers: DailyWordBoardUser[];
  /** Entries are filled in only once you have finished. */
  visible: boolean;
  entries: DailyWordBoardEntry[];
}

export interface DailyWordSettings {
  guild_id: string;
  enabled: boolean;
  share_channel_id: string | null;
  show_on_front_page: boolean;
  updated_at: string;
}

export interface DailyWordSettingsUpdate {
  enabled?: boolean;
  share_channel_id?: string | null;
  show_on_front_page?: boolean;
}

/** The server's code for a guess that is five letters but not a word on the list. */
export const NOT_IN_WORD_LIST = 'NOT_IN_WORD_LIST';

/** The error code a failed request carried, if any. */
export function apiErrorCode(err: unknown): string | null {
  if (!axios.isAxiosError(err)) return null;
  const data = err.response?.data as { code?: unknown } | undefined;
  return typeof data?.code === 'string' ? data.code : null;
}

export function createDailyWordApi(getApi: () => RestClient) {
  return {
    getToday: () => getApi().get<DailyWordToday>('/daily-word/today'),
    guess: (word: string) => getApi().post<DailyWordToday>('/daily-word/today/guess', { word }),
    getStats: () => getApi().get<DailyWordStats>('/daily-word/stats'),
    getBoard: (guildId: string) => getApi().get<DailyWordBoard>(`/guilds/${guildId}/daily-word/board`),
    getSettings: (guildId: string) => getApi().get<DailyWordSettings>(`/guilds/${guildId}/daily-word`),
    updateSettings: (guildId: string, body: DailyWordSettingsUpdate) =>
      getApi().put<DailyWordSettings>(`/guilds/${guildId}/daily-word`, body),
  };
}

export const dailyWordApi = createDailyWordApi(getActiveApi);
