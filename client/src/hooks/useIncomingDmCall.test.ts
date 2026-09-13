import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useIncomingDmCall } from './useIncomingDmCall';
import type { Channel, VoiceState } from '../types';

const mock = vi.hoisted(() => ({
  voice: {
    channelParticipants: new Map<string, VoiceState[]>(),
    channelId: null as string | null,
    joiningChannelId: null as string | null,
  },
  channels: {} as Record<string, Channel>,
}));

vi.mock('../stores/voiceStore', () => ({
  useVoiceStore: (selector: (state: typeof mock.voice) => unknown) => selector(mock.voice),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) => selector({ user: { id: 'me' } }),
}));
vi.mock('./useChannels', () => ({
  useCurrentChannelStore: (selector: (view: { channelsById: Record<string, Channel> }) => unknown) =>
    selector({ channelsById: mock.channels }),
}));

function voiceState(userId: string, channelId: string, extra: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId, channel_id: channelId, session_id: `${userId}-session`,
    deaf: false, mute: false, self_deaf: false, self_mute: false, self_stream: false,
    self_video: false, suppress: false, username: userId, ...extra,
  };
}

const dm = (id: string): Channel => ({ id, type: 1, name: null, created_at: '' } as unknown as Channel);

beforeEach(() => {
  mock.voice = { channelParticipants: new Map(), channelId: null, joiningChannelId: null };
  mock.channels = { 'dm-1': dm('dm-1'), 'dm-2': dm('dm-2') };
});

describe('useIncomingDmCall', () => {
  it('names the caller of a direct-message call this window is not in', () => {
    mock.voice.channelParticipants = new Map([['dm-1', [voiceState('ada', 'dm-1', { display_name: 'Ada' })]]]);
    const { result } = renderHook(() => useIncomingDmCall());
    expect(result.current.call).toEqual({ channelId: 'dm-1', callerName: 'Ada', participantCount: 1 });
  });

  it('is silent for a call you are already in, or joining', () => {
    mock.voice.channelParticipants = new Map([['dm-1', [voiceState('ada', 'dm-1'), voiceState('me', 'dm-1')]]]);
    mock.voice.channelId = 'dm-1';
    expect(renderHook(() => useIncomingDmCall()).result.current.call).toBeNull();

    mock.voice.channelId = null;
    mock.voice.joiningChannelId = 'dm-1';
    expect(renderHook(() => useIncomingDmCall()).result.current.call).toBeNull();
  });

  it('is silent for a guild room, even one whose id collides with a conversation', () => {
    // Channel ids are only unique per server; `channelParticipants` is one map
    // across all of them. A guild voice state must never read as a DM call.
    mock.voice.channelParticipants = new Map([['dm-1', [voiceState('ada', 'dm-1', { guild_id: 'g1' })]]]);
    expect(renderHook(() => useIncomingDmCall()).result.current.call).toBeNull();

    // A channel this account does not hold at all is nobody's call.
    mock.voice.channelParticipants = new Map([['other', [voiceState('ada', 'other')]]]);
    expect(renderHook(() => useIncomingDmCall()).result.current.call).toBeNull();
  });

  it('is silent when the only participant is you', () => {
    mock.voice.channelParticipants = new Map([['dm-1', [voiceState('me', 'dm-1')]]]);
    expect(renderHook(() => useIncomingDmCall()).result.current.call).toBeNull();
  });

  it('declining dismisses only that call, and only until it ends', () => {
    mock.voice.channelParticipants = new Map([['dm-1', [voiceState('ada', 'dm-1', { display_name: 'Ada' })]]]);
    const { result, rerender } = renderHook(() => useIncomingDmCall());
    expect(result.current.call?.channelId).toBe('dm-1');

    act(() => result.current.decline());
    expect(result.current.call).toBeNull();

    // A different conversation still rings.
    mock.voice.channelParticipants = new Map([
      ['dm-1', [voiceState('ada', 'dm-1', { display_name: 'Ada' })]],
      ['dm-2', [voiceState('grace', 'dm-2', { display_name: 'Grace' })]],
    ]);
    rerender();
    expect(result.current.call?.channelId).toBe('dm-2');

    // The caller hangs up and calls again: the decline is forgotten with the
    // call it belonged to, so the second call is not silently swallowed.
    mock.voice.channelParticipants = new Map();
    rerender();
    expect(result.current.call).toBeNull();
    mock.voice.channelParticipants = new Map([['dm-1', [voiceState('ada', 'dm-1', { display_name: 'Ada' })]]]);
    rerender();
    expect(result.current.call?.channelId).toBe('dm-1');
  });

  it('names everybody in a group conversation call', () => {
    mock.channels['dm-3'] = { id: 'dm-3', type: 3, name: null, created_at: '' } as unknown as Channel;
    mock.voice.channelParticipants = new Map([[
      'dm-3',
      [voiceState('ada', 'dm-3', { display_name: 'Ada' }), voiceState('grace', 'dm-3', { display_name: 'Grace' })],
    ]]);
    expect(renderHook(() => useIncomingDmCall()).result.current.call).toEqual({
      channelId: 'dm-3', callerName: 'Ada, Grace', participantCount: 2,
    });
  });
});
