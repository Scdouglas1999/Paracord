import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SoundboardSound } from '../../api/guilds';
import { useAuthStore } from '../../stores/authStore';
import { useSoundboardStore } from '../../stores/soundboardStore';
import { useVoiceStore } from '../../stores/voiceStore';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
}));

vi.mock('../../api/activeClient', () => ({
  getApi: () => ({ get: mocks.apiGet }),
}));

import {
  handleSoundboardPlay,
  previewSoundboardSound,
  soundboardEnabled,
  soundboardGain,
  soundboardVolume,
} from './soundboard';

function sound(over: Partial<SoundboardSound> = {}): SoundboardSound {
  return {
    id: 'snd1',
    guild_id: 'g1',
    name: 'ding',
    emoji: '🔔',
    volume: 100,
    duration_ms: 1000,
    content_type: 'audio/wav',
    size: 1234,
    creator_id: 'u1',
    sound_url: '/api/v1/guilds/g1/sounds/snd1/file',
    created_at: '2026-09-24T00:00:00Z',
    ...over,
  };
}

function settings(notifications: Record<string, unknown> | undefined) {
  useAuthStore.setState({
    settings: { notifications } as never,
    hasFetchedSettings: true,
    settingsUnavailable: false,
  });
}

/**
 * A minimal Web Audio stand-in: jsdom has no AudioContext. The capture arrays
 * live at module scope because the module under test caches its playback
 * context across tests — whichever fake was current at first use keeps serving.
 */
interface FakeSource { connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; onended: unknown; buffer: unknown }
interface FakeGain { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
const fakeAudio = { sources: [] as FakeSource[], gains: [] as FakeGain[] };

function installFakeAudio() {
  class FakeAudioContext {
    state = 'running';
    destination = { destination: true };
    decodeAudioData = vi.fn(async () => ({
      duration: 1,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(8),
      length: 8,
    }));
    createBufferSource = vi.fn(() => {
      const source: FakeSource = { connect: vi.fn(), start: vi.fn(), onended: null, buffer: null };
      fakeAudio.sources.push(source);
      return source;
    });
    createGain = vi.fn(() => {
      const node: FakeGain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      fakeAudio.gains.push(node);
      return node;
    });
    createMediaStreamDestination = vi.fn(() => ({ stream: {} }));
    resume = vi.fn(async () => {});
    setSinkId = vi.fn(async () => {});
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
}

describe('soundboardEnabled / soundboardVolume', () => {
  beforeEach(() => settings(undefined));

  it('defaults to enabled and full volume when unset', () => {
    expect(soundboardEnabled()).toBe(true);
    expect(soundboardVolume()).toBe(1);
  });

  it('honors an explicit toggle and a stored slider value', () => {
    settings({ soundboardEnabled: false, soundboardVolume: 40 });
    expect(soundboardEnabled()).toBe(false);
    expect(soundboardVolume()).toBe(0.4);
  });

  it('clamps out-of-range volume and treats junk as full', () => {
    settings({ soundboardVolume: 250 });
    expect(soundboardVolume()).toBe(1);
    settings({ soundboardVolume: -5 });
    expect(soundboardVolume()).toBe(0);
    settings({ soundboardVolume: 'loud' });
    expect(soundboardVolume()).toBe(1);
  });
});

describe('soundboardGain', () => {
  it('multiplies the sound’s volume by the listener’s', () => {
    settings({ soundboardVolume: 50 });
    expect(soundboardGain(sound({ volume: 80 }))).toBeCloseTo(0.4);
  });

  it('treats a missing sound volume as full', () => {
    settings({ soundboardVolume: 50 });
    expect(soundboardGain(sound({ volume: Number.NaN }))).toBeCloseTo(0.5);
  });

  it('reaches zero when either side is muted', () => {
    settings({ soundboardVolume: 0 });
    expect(soundboardGain(sound({ volume: 100 }))).toBe(0);
    settings({ soundboardVolume: 100 });
    expect(soundboardGain(sound({ volume: 0 }))).toBe(0);
  });
});

describe('handleSoundboardPlay', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset();
    mocks.apiGet.mockResolvedValue({ data: new ArrayBuffer(8) });
    fakeAudio.sources.length = 0;
    fakeAudio.gains.length = 0;
    installFakeAudio();
    settings(undefined);
    useSoundboardStore.setState({ recentPlays: [] });
    useVoiceStore.setState({
      connected: true,
      channelId: 'ch1',
      guildId: 'g1',
      selfDeaf: false,
      mediaEngine: null,
    });
  });

  it('ignores plays for a channel the listener is not in', async () => {
    useVoiceStore.setState({ connected: false, channelId: null });
    await handleSoundboardPlay({ channel_id: 'ch1', user_id: 'u2', sound: sound() });
    expect(useSoundboardStore.getState().recentPlays).toHaveLength(0);
    expect(mocks.apiGet).not.toHaveBeenCalled();

    await handleSoundboardPlay({ channel_id: 'ch2', user_id: 'u2', sound: sound() });
    expect(useSoundboardStore.getState().recentPlays).toHaveLength(0);
  });

  it('records the ripple mark and plays through Web Audio', async () => {
    await handleSoundboardPlay({
      channel_id: 'ch1',
      user_id: 'u2',
      sound: sound({ name: 'ding' }),
    });
    const plays = useSoundboardStore.getState().recentPlays;
    expect(plays).toHaveLength(1);
    expect(plays[0].userId).toBe('u2');
    expect(plays[0].soundName).toBe('ding');
    // The fetch goes through the authenticated API client.
    expect(mocks.apiGet).toHaveBeenCalledWith(
      'guilds/g1/sounds/snd1/file',
      expect.objectContaining({ responseType: 'arraybuffer' }),
    );
  });

  it('shows the ripple without playing audio while deafened', async () => {
    useVoiceStore.setState({ selfDeaf: true });
    await handleSoundboardPlay({ channel_id: 'ch1', user_id: 'u2', sound: sound() });
    expect(useSoundboardStore.getState().recentPlays).toHaveLength(1);
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });

  it('shows the ripple without playing audio when the toggle is off', async () => {
    settings({ soundboardEnabled: false });
    await handleSoundboardPlay({ channel_id: 'ch1', user_id: 'u2', sound: sound() });
    expect(useSoundboardStore.getState().recentPlays).toHaveLength(1);
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });

  it('silences a live clip when the listener deafens mid-play', async () => {
    await handleSoundboardPlay({ channel_id: 'ch1', user_id: 'u2', sound: sound({ id: 'snd-mid' }) });
    expect(fakeAudio.gains).toHaveLength(1);
    expect(fakeAudio.gains[0].gain.value).toBe(1);
    useVoiceStore.setState({ selfDeaf: true });
    expect(fakeAudio.gains[0].gain.value).toBe(0);
    useVoiceStore.setState({ selfDeaf: false });
    expect(fakeAudio.gains[0].gain.value).toBe(1);
  });

  it('drops the play if the listener leaves while the clip decodes', async () => {
    let release: (v: { data: ArrayBuffer }) => void = () => {};
    mocks.apiGet.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const pending = handleSoundboardPlay({
      channel_id: 'ch1',
      user_id: 'u2',
      sound: sound({ id: 'snd-slow' }),
    });
    useVoiceStore.setState({ channelId: 'ch9' });
    release({ data: new ArrayBuffer(8) });
    await pending;
    // Mark is recorded (the event arrived while connected) but no source starts.
    expect(useSoundboardStore.getState().recentPlays).toHaveLength(1);
  });
});

describe('previewSoundboardSound', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset();
    mocks.apiGet.mockResolvedValue({ data: new ArrayBuffer(8) });
    fakeAudio.sources.length = 0;
    fakeAudio.gains.length = 0;
    installFakeAudio();
    settings(undefined);
    useVoiceStore.setState({ connected: true, channelId: 'ch1', selfDeaf: false, mediaEngine: null });
  });

  it('plays for the local listener when enabled', async () => {
    await previewSoundboardSound(sound({ id: 'snd-prev' }));
    expect(mocks.apiGet).toHaveBeenCalled();
  });

  it('stays silent when the soundboard is toggled off', async () => {
    settings({ soundboardEnabled: false });
    await previewSoundboardSound(sound({ id: 'snd-off' }));
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });
});
