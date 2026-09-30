import { act, render, renderHook, screen } from '@testing-library/react';
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
import { StreamReactionsLayer, useStreamReactions, type StreamReactionTarget } from './StreamReactionsLayer';

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
  it('draws nothing until someone reacts, and never takes the pointer', () => {
    const { container } = render(<StreamReactionsLayer target={TARGET} />);
    expect(container).toBeEmptyDOMElement();
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
