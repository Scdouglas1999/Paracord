import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Simulate a browser runtime (NOT Tauri desktop). This is the case where the
// old teardown reset (useNativeMedia: isTauri()) silently flipped native OFF
// for the next join even though the browser has a real WebTransport engine.
vi.mock('../lib/tauriEnv', () => ({
  isTauri: () => false,
}));

// Silence audio side effects that touch DOM/Audio APIs during join.
vi.mock('../lib/features/voiceSounds', () => ({
  playVoiceJoinSound: vi.fn(),
  playVoiceLeaveSound: vi.fn(),
}));

const joinChannelMock = vi.fn(
  (_channelId: string, _options?: unknown): Promise<unknown> => Promise.resolve(),
);
const leaveChannelMock = vi.fn(
  (_channelId: string, _options?: unknown): Promise<unknown> => Promise.resolve(),
);

vi.mock('../api/voice', () => ({
  voiceApi: {
    joinChannel: (channelId: string, options?: unknown) => joinChannelMock(channelId, options),
    joinDmChannel: (channelId: string, options?: unknown) => joinChannelMock(channelId, options),
    leaveChannel: (channelId: string, options?: unknown) => leaveChannelMock(channelId, options),
    leaveDmChannel: () => Promise.resolve(),
    startStream: () => Promise.resolve({ data: {} }),
    stopStream: () => Promise.resolve(),
  },
}));

// Track how the native engine is constructed/connected so we can assert the
// native branch (not LiveKit) was taken.
const engineConnect = vi.fn(() => Promise.resolve());
const createMediaEngineMock = vi.fn();

function makeFakeEngine() {
  return {
    connect: engineConnect,
    disconnect: vi.fn(() => Promise.resolve()),
    setMute: vi.fn(),
    setDeaf: vi.fn(),
    onParticipantJoin: vi.fn(),
    onParticipantLeave: vi.fn(),
    onSpeakingChange: vi.fn(),
  };
}

vi.mock('../lib/media/mediaEngine', () => ({
  createMediaEngine: () => createMediaEngineMock(),
}));

import { useVoiceStore } from './voiceStore';

describe('voiceStore join in a browser after engine teardown', () => {
  beforeEach(() => {
    joinChannelMock.mockReset();
    leaveChannelMock.mockClear();
    engineConnect.mockClear();
    createMediaEngineMock.mockReset();
    createMediaEngineMock.mockImplementation(() => Promise.resolve(makeFakeEngine()));

    joinChannelMock.mockImplementation(() =>
      Promise.resolve({
        data: {
          token: 'lk-token',
          url: 'wss://server.example/livekit',
          room_name: 'room-xyz',
          session_id: 'sess-1',
          native_media: true,
          media_endpoint: 'https://media.example:4443/webtransport',
          media_token: 'native-token',
          livekit_available: true,
        },
      }),
    );
  });

  afterEach(() => {
    useVoiceStore.setState({
      mediaEngine: null,
      room: null,
      connected: false,
      channelId: null,
      useNativeMedia: true,
    });
    vi.clearAllMocks();
  });

  it('takes the native branch when the server returns native_media after tearing down a prior engine', async () => {
    // Simulate a prior native session whose engine must be torn down. In a
    // browser this is exactly where useNativeMedia used to be downgraded to
    // false (isTauri() === false), breaking the next join.
    const priorEngine = makeFakeEngine();
    useVoiceStore.setState({
      connected: false,
      channelId: null,
      mediaEngine: priorEngine as never,
      useNativeMedia: true,
    });

    await useVoiceStore.getState().joinChannel('chan-1', 'guild-1');

    // Prior engine was disconnected during teardown.
    expect(priorEngine.disconnect).toHaveBeenCalled();

    // Native branch was taken: a fresh engine was built and connected to the
    // server-provided media endpoint with the native token — never LiveKit.
    expect(createMediaEngineMock).toHaveBeenCalled();
    expect(engineConnect).toHaveBeenCalledWith(
      'https://media.example:4443/webtransport',
      'native-token',
      undefined,
    );

    const state = useVoiceStore.getState();
    expect(state.connected).toBe(true);
    expect(state.channelId).toBe('chan-1');
    expect(state.mediaEngine).not.toBeNull();
    // Native path leaves the LiveKit room null and keeps native selected.
    expect(state.room).toBeNull();
    expect(state.useNativeMedia).toBe(true);
  });

  it('keeps the stable native preference across teardown so the store drives the native branch even when the server omits native_media', async () => {
    // This is the exact regression the teardown fix guards: with native_media
    // absent, only the store preference can select native. The old teardown
    // reset (useNativeMedia: isTauri() === false in a browser) would have
    // flipped the preference OFF and routed this join through LiveKit instead.
    joinChannelMock.mockImplementation(() =>
      Promise.resolve({
        data: {
          token: 'lk-token',
          url: 'wss://server.example/livekit',
          room_name: 'room-xyz',
          session_id: 'sess-2',
          // No native_media flag from the server.
          media_endpoint: 'https://media.example:4443/webtransport',
          media_token: 'native-token',
          livekit_available: true,
        },
      }),
    );

    const priorEngine = makeFakeEngine();
    useVoiceStore.setState({
      connected: false,
      channelId: null,
      mediaEngine: priorEngine as never,
      useNativeMedia: true,
    });

    await useVoiceStore.getState().joinChannel('chan-2', 'guild-1');

    expect(priorEngine.disconnect).toHaveBeenCalled();
    // Store preference alone drove the native branch — no LiveKit Room built.
    expect(engineConnect).toHaveBeenCalledWith(
      'https://media.example:4443/webtransport',
      'native-token',
      undefined,
    );

    const state = useVoiceStore.getState();
    expect(state.connected).toBe(true);
    expect(state.mediaEngine).not.toBeNull();
    expect(state.room).toBeNull();
    expect(state.useNativeMedia).toBe(true);
  });
});
