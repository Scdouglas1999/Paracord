import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyWordApi, type DailyWordToday } from '../../api/dailyWord';
import { useDailyWordStore } from '../../stores/dailyWordStore';
import { toast } from '../../stores/toastStore';
import { DailyWordView } from './DailyWordView';

vi.mock('../../api/dailyWord', async () => {
  const actual = await vi.importActual<typeof import('../../api/dailyWord')>('../../api/dailyWord');
  return {
    ...actual,
    dailyWordApi: {
      getToday: vi.fn(),
      guess: vi.fn(),
      getStats: vi.fn(),
      getBoard: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
    },
  };
});

vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const ok = <T,>(data: T) => Promise.resolve({ data } as never);

function today(over: Partial<DailyWordToday> = {}): DailyWordToday {
  return {
    puzzle: 267,
    date: '2026-09-24',
    next_puzzle_at: '2026-09-25T00:00:00Z',
    word_length: 5,
    max_guesses: 6,
    guesses: [],
    finished: false,
    solved: false,
    ...over,
  };
}

function notAWord() {
  const response = {
    status: 400,
    statusText: 'Bad Request',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { code: 'NOT_IN_WORD_LIST', message: 'Not in the word list' },
  };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', response.config, null, response);
}

function type(word: string) {
  for (const letter of word) fireEvent.keyDown(window, { key: letter });
}

describe('DailyWordView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDailyWordStore.getState().reset();
    vi.mocked(dailyWordApi.getSettings).mockImplementation(() =>
      ok({ guild_id: 'g1', enabled: true, share_channel_id: null, show_on_front_page: true, updated_at: '' }));
    vi.mocked(dailyWordApi.getToday).mockImplementation(() => ok(today()));
    vi.mocked(dailyWordApi.getBoard).mockImplementation(() =>
      ok({ guild_id: 'g1', puzzle: 267, played: 0, finished: 0, solved: 0, solvers: [], visible: false, entries: [] }));
  });

  async function renderView() {
    render(
      <MemoryRouter>
        <DailyWordView guildId="g1" serverName="Lantern Works" />
      </MemoryRouter>,
    );
    await screen.findByRole('group', { name: 'Keyboard' });
  }

  it('refuses a word that is not on the list without using a guess, and shakes the row', async () => {
    vi.mocked(dailyWordApi.guess).mockImplementation(() => Promise.reject(notAWord()));
    await renderView();
    type('qqqqq');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Not in the word list'));
    const row = screen.getByRole('group', { name: 'Typing QQQQQ' });
    expect(row.className).toContain('is-shaking');
    expect(useDailyWordStore.getState().today?.guesses).toEqual([]);
  });

  it('sends a typed word and colors the tiles and the keys', async () => {
    vi.mocked(dailyWordApi.guess).mockImplementation(() =>
      ok(today({ guesses: [{ word: 'crane', states: ['absent', 'present', 'absent', 'absent', 'correct'] }] })));
    await renderView();
    type('crane');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(dailyWordApi.guess).toHaveBeenCalledWith('crane');
    await screen.findByRole('group', {
      name: 'CRANE: C not in the word, R in the word, A not in the word, N not in the word, E in place',
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'E, in place' })).toHaveAttribute('data-state', 'correct'));
    expect(screen.getByRole('button', { name: 'R, in the word' })).toHaveAttribute('data-state', 'present');
  });

  it('asks for five letters before sending', async () => {
    await renderView();
    type('cra');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(dailyWordApi.guess).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith('Not enough letters');
  });

  it('shows the answer, stats and a spoiler-free share once finished', async () => {
    vi.mocked(dailyWordApi.getToday).mockImplementation(() =>
      ok(today({
        guesses: [
          { word: 'slate', states: ['absent', 'absent', 'absent', 'absent', 'correct'] },
          { word: 'crane', states: ['correct', 'correct', 'correct', 'correct', 'correct'] },
        ],
        finished: true,
        solved: true,
        answer: 'crane',
        definition: { part_of_speech: 'noun', text: 'a large long-necked wading bird' },
      })));
    vi.mocked(dailyWordApi.getStats).mockImplementation(() =>
      ok({ puzzle: 267, played: 3, solved: 3, missed: 0, current_streak: 3, max_streak: 3, distribution: [0, 1, 2, 0, 0, 0] }));
    render(
      <MemoryRouter>
        <DailyWordView guildId="g1" serverName="Lantern Works" />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Solved in 2')).toBeInTheDocument();
    expect(screen.getByText('crane')).toBeInTheDocument();
    expect(screen.getByText(/a large long-necked wading bird/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Keyboard' })).toBeNull();
    await screen.findByRole('list', { hidden: false });
    const share = screen.getByText((_, node) => node?.tagName === 'PRE');
    expect(share.textContent).toContain('Daily word 267 · 2/6');
    expect(share.textContent?.toLowerCase()).not.toContain('crane');
  });
});
