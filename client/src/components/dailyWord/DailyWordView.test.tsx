import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The fixture puzzle ends at 2026-09-25T00:00Z. The view compares that with the
// wall clock, so a test that reads the real one goes stale the moment the calendar
// passes it: the view thinks a new puzzle is due and refetches, and every refetch
// returns the same past fixture. Pin the date (only the date: the timers stay real
// because the tests wait on promises).
const NOW = new Date('2026-09-24T12:00:00Z');

describe('DailyWordView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    vi.clearAllMocks();
    useDailyWordStore.getState().reset();
    vi.mocked(dailyWordApi.getSettings).mockImplementation(() =>
      ok({ guild_id: 'g1', enabled: true, share_channel_id: null, show_on_front_page: true, updated_at: '' }));
    vi.mocked(dailyWordApi.getToday).mockImplementation(() => ok(today()));
    vi.mocked(dailyWordApi.getBoard).mockImplementation(() =>
      ok({ guild_id: 'g1', puzzle: 267, played: 0, finished: 0, solved: 0, solvers: [], visible: false, entries: [] }));
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // Drive the reveal animation explicitly: its 940 ms duration leaves only
    // 60 ms of the default waitFor timeout for a busy test worker to render.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: NOW });
    type('crane');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(dailyWordApi.guess).toHaveBeenCalledWith('crane');
    expect(screen.getByRole('group', {
      name: 'CRANE: C not in the word, R in the word, A not in the word, N not in the word, E in place',
    })).toBeInTheDocument();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByRole('button', { name: 'E, in place' })).toHaveAttribute('data-state', 'correct');
    expect(screen.getByRole('button', { name: 'R, in the word' })).toHaveAttribute('data-state', 'present');
  });

  it('asks the server for a new puzzle at most once per tick when its own clock is past the puzzle end', async () => {
    // The device clock is ahead of the server's: the puzzle it is showing "ended" five
    // minutes ago by this clock, and the server keeps answering with the same one. The
    // view used to refetch on every answer, without end. Each mock answer takes a
    // macrotask, so a regression fails the count instead of starving the test runner.
    vi.setSystemTime(new Date('2026-09-25T00:05:00Z'));
    vi.mocked(dailyWordApi.getToday).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: today() } as never), 0)),
    );
    await renderView();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    // One read on mount, one because the puzzle is already past its end.
    expect(vi.mocked(dailyWordApi.getToday).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('starts a fresh game when midnight passes, without the letters typed for the old word', async () => {
    // The page's clock is the only thing that notices midnight, so it has to be driven.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
    render(
      <MemoryRouter>
        <DailyWordView guildId="g1" serverName="Lantern Works" />
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(screen.getByText(/No\. 267/)).toBeInTheDocument();
    type('cra');
    expect(screen.getByRole('group', { name: 'Typing CRA' })).toBeInTheDocument();

    vi.mocked(dailyWordApi.getToday).mockImplementation(() =>
      ok(today({ puzzle: 268, date: '2026-09-25', next_puzzle_at: '2026-09-26T00:00:00Z' })));
    await act(async () => {
      vi.setSystemTime(new Date('2026-09-25T00:00:10Z'));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText(/No\. 268/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Next guess, empty' })).toBeInTheDocument();
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
