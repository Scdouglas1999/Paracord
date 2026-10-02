import { act, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamReactions as StreamReactionsEvent } from '../../../api/generated/StreamReactions';
import type { MediaViewState } from '../../../stores/voice/viewSessions';

const motion = vi.hoisted(() => ({ reduced: false }));
const api = vi.hoisted(() => ({ streamReaction: vi.fn(async () => ({ data: undefined })) }));

vi.mock('../../../lib/motion/reducedMotion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/motion/reducedMotion')>()),
  prefersReducedMotion: () => motion.reduced,
}));
vi.mock('../../../api/voice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/voice')>()),
  createCallVoiceApi: () => api,
}));
vi.mock('../../../lib/operationContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/operationContext')>()),
  captureOperationContext: (serverId: string) => ({ scope: { serverId, userId: 'me' }, dispose: () => {} }),
}));
vi.mock('../../../lib/serverIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/serverIdentity')>()),
  getServerUser: () => ({ id: 'me' }),
}));
vi.mock('../../../api/files', () => ({ fileApi: { getDownloadTicket: vi.fn() } }));

import { useStreamReactionStore } from '../../../stores/streamReactionStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import {
  ANNOUNCE_INTERVAL_MS,
  StreamReactionsLayer,
  reactionSentence,
  useStreamReactions,
  type StreamReactionTarget,
} from './StreamReactionsLayer';

const TARGET: StreamReactionTarget = { serverId: 'srv', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

function event(...reactions: Array<Partial<StreamReactionsEvent['reactions'][number]>>): StreamReactionsEvent {
  return {
    guild_id: 'g1',
    channel_id: 'lounge',
    reactions: reactions.map((over) => ({
      user_id: 'luke',
      stream_user_id: 'vincent',
      kind: 'flame',
      count: 1,
      nonce: null,
      username: 'luke',
      display_name: 'Luke',
      avatar_hash: null,
      ...over,
    })) as StreamReactionsEvent['reactions'],
  };
}

function watchView(over: Partial<MediaViewState> = {}): MediaViewState {
  return {
    id: 'w1',
    kind: 'watch',
    scope: { serverId: 'srv', userId: 'me' },
    guildId: 'g1',
    channelId: 'lounge',
    streamerId: 'vincent',
    route: 'session',
    phase: 'live',
    engine: null,
    sessionId: 'view-1',
    endReason: null,
    pauseReason: null,
    error: null,
    ...over,
  } as MediaViewState;
}

beforeEach(() => {
  vi.useFakeTimers();
  motion.reduced = false;
  api.streamReaction.mockClear();
  useStreamReactionStore.getState().reset();
  useVoiceStore.setState({ watchView: null, callScope: null, callPhase: 'idle', channelId: null });
});

afterEach(() => {
  useStreamReactionStore.getState().reset();
  useVoiceStore.setState({ watchView: null, callScope: null, callPhase: 'idle', channelId: null });
  vi.useRealTimers();
});

describe('StreamReactionsLayer', () => {
  it('draws no bubbles until someone reacts, and never takes the pointer', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    expect(screen.queryByTestId('stream-reactions')).toBeNull();
    act(() => useStreamReactionStore.getState().receive('srv', event({})));
    const layer = screen.getByTestId('stream-reactions');
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer).toHaveClass('glass-reactions');
  });

  it("puts the sender's face in the corner of someone else's reaction, and none on your own", () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => {
      useStreamReactionStore.getState().receive('srv', event({ user_id: 'luke', display_name: 'Luke' }));
      useStreamReactionStore.getState().send(TARGET, 'heart');
    });
    const bubbles = document.querySelectorAll('.glass-reactions__bubble');
    expect(bubbles).toHaveLength(2);
    const [theirs, mine] = Array.from(bubbles);
    expect(theirs).toHaveAttribute('data-kind', 'flame');
    expect(theirs.querySelector('.glass-reactions__face')?.textContent).toBe('L');
    expect(mine).toHaveAttribute('data-own');
    expect(mine).toHaveAttribute('data-kind', 'heart');
    expect(mine.querySelector('.glass-reactions__face')).toBeNull();
  });

  it('shows how many taps a merged reaction stands for', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ count: 4 })));
    expect(document.querySelector('.glass-reactions__count')?.textContent).toBe('4');
  });

  it("only draws its own stream's reactions", () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ stream_user_id: 'luke' })));
    expect(screen.queryByTestId('stream-reactions')).toBeNull();
  });

  it('rises and is gone after the rise', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({})));
    const bubble = document.querySelector('.glass-reactions__bubble');
    expect(bubble).not.toHaveAttribute('data-still');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByTestId('stream-reactions')).toBeNull();
  });

  it('with reduced motion, bubbles appear in place, stacked, and go', () => {
    motion.reduced = true;
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ user_id: 'a' }, { user_id: 'b', kind: 'heart' })));
    const bubbles = Array.from(document.querySelectorAll<HTMLElement>('.glass-reactions__bubble'));
    expect(bubbles.map((bubble) => bubble.getAttribute('data-still'))).toEqual(['true', 'true']);
    expect(bubbles.map((bubble) => bubble.style.bottom)).toEqual(['0px', '52px']);
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.queryByTestId('stream-reactions')).toBeNull();
  });

  it('stops keeping reactions when it leaves the screen', () => {
    const { unmount } = render(<StreamReactionsLayer target={TARGET} />);
    unmount();
    act(() => useStreamReactionStore.getState().receive('srv', event({})));
    expect(useStreamReactionStore.getState().bubbles).toHaveLength(0);
  });
});

/** What the polite live region holds right now. */
const spoken = () => screen.getByTestId('stream-reactions-live').textContent;

describe('StreamReactionsLayer for screen readers', () => {
  it('keeps a hidden polite live region in the page from the start, apart from the pictures', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    const region = screen.getByTestId('stream-reactions-live');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveClass('sr-only');
    expect(spoken()).toBe('');
    // The bubbles stay pictures; the region is not inside them.
    act(() => useStreamReactionStore.getState().receive('srv', event({})));
    expect(screen.getByTestId('stream-reactions')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('stream-reactions').contains(region)).toBe(false);
    expect(region.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('says who reacted and with what', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ display_name: 'Brendan' })));
    expect(spoken()).toBe('Brendan reacted with a flame');
    act(() => vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS));
    act(() => useStreamReactionStore.getState().receive('srv', event({ user_id: 'nick', display_name: 'Nick', kind: 'heart' })));
    expect(spoken()).toBe('Nick reacted with a heart');
  });

  it('falls back to the username when there is no display name', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ display_name: null, username: 'luke_v' })));
    expect(spoken()).toBe('luke_v reacted with a flame');
  });

  it('never says your own reaction', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => {
      useStreamReactionStore.getState().send(TARGET, 'flame');
      useStreamReactionStore.getState().send(TARGET, 'heart');
    });
    expect(document.querySelectorAll('.glass-reactions__bubble[data-own]')).toHaveLength(2);
    expect(spoken()).toBe('');
    act(() => vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS * 3));
    expect(spoken()).toBe('');
  });

  it('speaks at most once every two seconds, and merges what arrives meanwhile ("3 reactions")', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    const receive = (over: Parameters<typeof event>[0]) => act(() => useStreamReactionStore.getState().receive('srv', event(over)));
    receive({ user_id: 'a', display_name: 'Ana' });
    expect(spoken()).toBe('Ana reacted with a flame');

    // Three more inside the interval: nothing new is said yet.
    act(() => vi.advanceTimersByTime(300));
    receive({ user_id: 'b', display_name: 'Bo' });
    act(() => vi.advanceTimersByTime(300));
    receive({ user_id: 'c', display_name: 'Cy', kind: 'heart' });
    act(() => vi.advanceTimersByTime(300));
    receive({ user_id: 'd', display_name: 'Di' });
    expect(spoken()).toBe('Ana reacted with a flame');

    // When the interval is up they are one line.
    act(() => vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS - 900 - 1));
    expect(spoken()).toBe('Ana reacted with a flame');
    act(() => vi.advanceTimersByTime(1));
    expect(spoken()).toBe('3 reactions');
  });

  it('counts a reaction that carries several taps, and speaks a single late one by name', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ count: 4 })));
    expect(spoken()).toBe('4 reactions');
    act(() => vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS + 500));
    act(() => useStreamReactionStore.getState().receive('srv', event({ user_id: 'bo', display_name: 'Bo' })));
    expect(spoken()).toBe('Bo reacted with a flame');
  });

  it('counts the taps that merge into a rising bubble when the stream is busy', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    // Six bubbles rising makes the stream busy: the seventh joins the youngest.
    for (let i = 0; i < 6; i++) {
      act(() => useStreamReactionStore.getState().receive('srv', event({ user_id: `u${i}`, display_name: `P${i}` })));
    }
    expect(spoken()).toBe('P0 reacted with a flame');
    act(() => vi.advanceTimersByTime(100));
    act(() => useStreamReactionStore.getState().receive('srv', event({ user_id: 'x', display_name: 'X' })));
    expect(document.querySelectorAll('.glass-reactions__bubble')).toHaveLength(6);
    expect(document.querySelector('.glass-reactions__count')?.textContent).toBe('2');
    // The merged tap has no one to name, but it is counted with the rest.
    act(() => vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS));
    expect(spoken()).toBe('6 reactions');
  });

  it("does not say what was already on screen when it started, nor another stream's", () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ stream_user_id: 'luke' })));
    expect(spoken()).toBe('');
    act(() => useStreamReactionStore.getState().receive('srv', event({ display_name: 'Bo' })));
    expect(spoken()).toBe('Bo reacted with a flame');
    // A second layer on the same stream starts with that bubble already there.
    const second = render(<StreamReactionsLayer target={TARGET} />);
    expect(within(second.container).getByTestId('stream-reactions-live').textContent).toBe('');
  });

  it('says the same line again as a new line, and clears it after a while', () => {
    render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ display_name: 'Bo' })));
    const first = screen.getByTestId('stream-reactions-live').firstElementChild;
    act(() => vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS));
    act(() => useStreamReactionStore.getState().receive('srv', event({ display_name: 'Bo' })));
    const second = screen.getByTestId('stream-reactions-live').firstElementChild;
    expect(spoken()).toBe('Bo reacted with a flame');
    // A new node, so the screen reader hears it again.
    expect(second).not.toBe(first);
    act(() => vi.advanceTimersByTime(10_000));
    expect(spoken()).toBe('');
  });

  it('stops when it leaves the screen: no timer says anything afterwards', () => {
    const { unmount } = render(<StreamReactionsLayer target={TARGET} />);
    act(() => useStreamReactionStore.getState().receive('srv', event({ user_id: 'a' })));
    act(() => useStreamReactionStore.getState().receive('srv', event({ user_id: 'b' })));
    unmount();
    expect(() => act(() => vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS * 3))).not.toThrow();
  });

  it('composes the sentence', () => {
    expect(reactionSentence([{ name: 'Brendan', kind: 'flame', taps: 1 }])).toBe('Brendan reacted with a flame');
    expect(reactionSentence([{ name: 'Brendan', kind: 'heart', taps: 1 }])).toBe('Brendan reacted with a heart');
    expect(reactionSentence([{ name: null, kind: 'flame', taps: 1 }])).toBe('1 reaction');
    expect(
      reactionSentence([
        { name: 'A', kind: 'flame', taps: 1 },
        { name: 'B', kind: 'heart', taps: 2 },
      ]),
    ).toBe('3 reactions');
  });
});

describe('useStreamReactions', () => {
  it('is not available before the stream is on screen, and says why', () => {
    useVoiceStore.setState({ watchView: watchView({ phase: 'connecting' }) });
    const { result } = renderHook(() => useStreamReactions(TARGET));
    expect(result.current.available).toBe(false);
    expect(result.current.unavailableReason).toBe('You can react once the stream is on your screen.');
  });

  it('is available while watching, and sends a flame for the fire button', async () => {
    useVoiceStore.setState({ watchView: watchView() });
    const { result } = renderHook(() => useStreamReactions(TARGET));
    expect(result.current).toMatchObject({ available: true, unavailableReason: null });
    act(() => result.current.send('fire'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.streamReaction).toHaveBeenCalledWith('lounge', expect.objectContaining({ kind: 'flame', stream_user_id: 'vincent' }));
  });

  it('is available in the call, joined or listening, without a separate watch', () => {
    useVoiceStore.setState({ callScope: { serverId: 'srv', userId: 'me' }, callPhase: 'connected', channelId: 'lounge' });
    const { result } = renderHook(() => useStreamReactions(TARGET));
    expect(result.current.available).toBe(true);
  });

  it('is not available for another stream or another channel', () => {
    useVoiceStore.setState({ watchView: watchView({ streamerId: 'luke' }) });
    expect(renderHook(() => useStreamReactions(TARGET)).result.current.available).toBe(false);
    useVoiceStore.setState({ watchView: null, callScope: { serverId: 'srv', userId: 'me' }, callPhase: 'connected', channelId: 'general' });
    expect(renderHook(() => useStreamReactions(TARGET)).result.current.available).toBe(false);
  });

  it('is not available in a direct message call', () => {
    useVoiceStore.setState({ callScope: { serverId: 'srv', userId: 'me' }, callPhase: 'connected', channelId: 'lounge' });
    const { result } = renderHook(() => useStreamReactions({ ...TARGET, guildId: null }));
    expect(result.current).toMatchObject({ available: false, unavailableReason: 'Reactions on the stream are for server voice channels.' });
  });
});
