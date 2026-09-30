import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import type { StreamReactions } from '../api/generated/StreamReactions';

const api = vi.hoisted(() => ({ streamReaction: vi.fn() }));
const motion = vi.hoisted(() => ({ reduced: false }));
const identity = vi.hoisted(() => ({ userId: 'me' as string | null }));

vi.mock('../api/voice', () => ({ createCallVoiceApi: () => api }));
vi.mock('../lib/operationContext', () => ({
  captureOperationContext: (serverId: string) => {
    if (!identity.userId) throw new Error('Sign in to this instance before continuing.');
    return { scope: { serverId, userId: identity.userId }, dispose: vi.fn() };
  },
}));
vi.mock('../lib/serverIdentity', () => ({
  getServerUser: () => (identity.userId ? { id: identity.userId } : null),
}));
vi.mock('../lib/motion/reducedMotion', () => ({ prefersReducedMotion: () => motion.reduced }));

import {
  BUSY,
  isStreamReactions,
  MAX_LIVE,
  OWN_RISE_MS,
  RISE_MS,
  SEND_INTERVAL_MS,
  STILL_MS,
  streamKey,
  useStreamReactionStore,
} from './streamReactionStore';
import { useToastStore } from './toastStore';

const TARGET = { serverId: 'srv', channelId: 'lounge', streamerId: 'vincent' };
const KEY = streamKey('srv', 'lounge', 'vincent');

function reaction(over: Partial<StreamReactions['reactions'][number]> = {}) {
  return {
    user_id: 'luke',
    stream_user_id: 'vincent',
    kind: 'flame' as const,
    count: 1,
    nonce: null,
    username: 'luke',
    display_name: 'Luke',
    avatar_hash: null,
    ...over,
  };
}

function event(...reactions: ReturnType<typeof reaction>[]): StreamReactions {
  return { guild_id: 'g1', channel_id: 'lounge', reactions: reactions as StreamReactions['reactions'] };
}

const store = () => useStreamReactionStore.getState();
const bubbles = () => store().bubbles;

function rateLimited(seconds: number): AxiosError {
  const headers = new AxiosHeaders({ 'retry-after': String(seconds) });
  return new AxiosError('Request failed with status code 429', '429', undefined, undefined, {
    status: 429,
    statusText: 'Too Many Requests',
    headers,
    config: { headers },
    data: { code: 'RATE_LIMITED', message: 'rate limited', retry_after: seconds },
  });
}

let release: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T21:00:00Z'));
  api.streamReaction.mockReset();
  api.streamReaction.mockResolvedValue({ data: undefined });
  motion.reduced = false;
  identity.userId = 'me';
  store().reset();
  useToastStore.setState({ toasts: [] });
  release = store().watch(KEY);
});

afterEach(() => {
  release?.();
  store().reset();
  vi.useRealTimers();
});

describe('receiving', () => {
  it('draws reactions for a stream on screen, with the sender to put in the corner', () => {
    store().receive('srv', event(reaction()));
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]).toMatchObject({ key: KEY, kind: 'flame', own: false, userId: 'luke', name: 'Luke', count: 1 });
  });

  it('keeps nothing for a stream nobody here is showing', () => {
    store().receive('srv', event(reaction({ stream_user_id: 'luke-screen' })));
    store().receive('other-instance', event(reaction()));
    expect(bubbles()).toHaveLength(0);
  });

  it('lets each bubble rise once and go', () => {
    store().receive('srv', event(reaction()));
    vi.advanceTimersByTime(RISE_MS - 1);
    expect(bubbles()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(bubbles()).toHaveLength(0);
  });

  it('with reduced motion, a bubble appears in place briefly', () => {
    motion.reduced = true;
    store().receive('srv', event(reaction()));
    expect(bubbles()[0].still).toBe(true);
    vi.advanceTimersByTime(STILL_MS);
    expect(bubbles()).toHaveLength(0);
  });

  it('skips a kind this version cannot draw, and still draws the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store().receive('srv', event(reaction({ kind: 'confetti' as never }), reaction({ kind: 'heart' })));
    expect(bubbles().map((bubble) => bubble.kind)).toEqual(['heart']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('drops its bubbles when the stream leaves the screen', () => {
    store().receive('srv', event(reaction()));
    release?.();
    release = null;
    expect(bubbles()).toHaveLength(0);
    expect(store().watching.has(KEY)).toBe(false);
  });

  it('merges into a young bubble of the same kind once busy', () => {
    for (let i = 0; i < BUSY; i += 1) store().receive('srv', event(reaction({ user_id: `u${i}`, kind: 'heart' })));
    expect(bubbles()).toHaveLength(BUSY);
    store().receive('srv', event(reaction({ user_id: 'nick', kind: 'heart', count: 2 })));
    expect(bubbles()).toHaveLength(BUSY);
    expect(bubbles().at(-1)?.count).toBe(3);
    // A kind with no bubble to join still gets its own.
    store().receive('srv', event(reaction({ user_id: 'brendan', kind: 'flame' })));
    expect(bubbles()).toHaveLength(BUSY + 1);
  });

  it('never shows more than the most a stream can hold', () => {
    const kinds = ['flame', 'heart'] as const;
    for (let i = 0; i < MAX_LIVE * 3; i += 1) {
      vi.advanceTimersByTime(1000); // older than the merge window each time
      store().receive('srv', event(reaction({ user_id: `u${i}`, kind: kinds[i % 2] })));
    }
    expect(bubbles().length).toBeLessThanOrEqual(MAX_LIVE);
  });

  it('recognizes the event shape', () => {
    expect(isStreamReactions(event(reaction()))).toBe(true);
    expect(isStreamReactions({ guild_id: 'g1', channel_id: 'lounge' })).toBe(false);
    expect(isStreamReactions(event({ ...reaction(), count: 0 }))).toBe(false);
    expect(isStreamReactions(event({ ...reaction(), user_id: 7 as never }))).toBe(false);
  });
});

describe('sending', () => {
  it('draws your own reaction at once and sends it with a nonce', async () => {
    store().send(TARGET, 'flame');
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]).toMatchObject({ own: true, kind: 'flame' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.streamReaction).toHaveBeenCalledTimes(1);
    const [channelId, body] = api.streamReaction.mock.calls[0];
    expect(channelId).toBe('lounge');
    expect(body).toMatchObject({ kind: 'flame', stream_user_id: 'vincent', count: 1 });
    expect(body.nonce).toMatch(/^[0-9a-f]{24}$/);
  });

  it('drops the echo of its own reaction, but not the same reaction from your other device', async () => {
    store().send(TARGET, 'heart');
    await vi.advanceTimersByTimeAsync(0);
    const nonce = api.streamReaction.mock.calls[0][1].nonce as string;
    store().receive('srv', event(reaction({ user_id: 'me', kind: 'heart', nonce })));
    expect(bubbles()).toHaveLength(1);
    store().receive('srv', event(reaction({ user_id: 'me', kind: 'heart', nonce: 'another-device' })));
    expect(bubbles()).toHaveLength(2);
    expect(bubbles()[1].own).toBe(false);
  });

  it('sends one request a second and merges the taps in between', async () => {
    store().send(TARGET, 'flame');
    await vi.advanceTimersByTimeAsync(0);
    store().send(TARGET, 'flame');
    store().send(TARGET, 'flame');
    store().send(TARGET, 'flame');
    expect(bubbles().filter((bubble) => bubble.own)).toHaveLength(4); // every tap is drawn
    await vi.advanceTimersByTimeAsync(SEND_INTERVAL_MS - 1);
    expect(api.streamReaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.streamReaction).toHaveBeenCalledTimes(2);
    expect(api.streamReaction.mock.calls[1][1]).toMatchObject({ kind: 'flame', count: 3 });
  });

  it('sends a flame and a heart tapped together a second apart', async () => {
    store().send(TARGET, 'flame');
    store().send(TARGET, 'heart');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.streamReaction.mock.calls.map((call) => call[1].kind)).toEqual(['flame']);
    await vi.advanceTimersByTimeAsync(SEND_INTERVAL_MS);
    expect(api.streamReaction.mock.calls.map((call) => call[1].kind)).toEqual(['flame', 'heart']);
  });

  it('when the server says wait, puts the taps back and sends them after Retry-After', async () => {
    api.streamReaction.mockRejectedValueOnce(rateLimited(2));
    store().send(TARGET, 'heart');
    await vi.advanceTimersByTimeAsync(0);
    store().send(TARGET, 'heart');
    await vi.advanceTimersByTimeAsync(1999);
    expect(api.streamReaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.streamReaction).toHaveBeenCalledTimes(2);
    expect(api.streamReaction.mock.calls[1][1]).toMatchObject({ kind: 'heart', count: 2 });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('says so when a reaction could not be sent for any other reason', async () => {
    api.streamReaction.mockRejectedValueOnce(new Error('That person is not streaming in this channel'));
    store().send(TARGET, 'flame');
    await vi.advanceTimersByTimeAsync(0);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'Your reaction was not sent: That person is not streaming in this channel',
    );
  });

  it('never sends taps as an account that is no longer signed in', async () => {
    store().send(TARGET, 'flame');
    await vi.advanceTimersByTimeAsync(0);
    store().send(TARGET, 'flame');
    identity.userId = 'someone-else';
    await vi.advanceTimersByTimeAsync(SEND_INTERVAL_MS);
    expect(api.streamReaction).toHaveBeenCalledTimes(1);
  });

  it('your own bubble rises a little longer than others', () => {
    store().send(TARGET, 'flame');
    vi.advanceTimersByTime(RISE_MS);
    expect(bubbles()).toHaveLength(1);
    vi.advanceTimersByTime(OWN_RISE_MS - RISE_MS);
    expect(bubbles()).toHaveLength(0);
  });
});
