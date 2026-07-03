import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
}));

vi.mock('../lib/tauriEnv', () => ({
  isTauri: () => true,
}));

import { useVoiceStore } from './voiceStore';

describe('voiceStore.applyAudioOutputDevice (native path)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'voice_list_output_devices') {
        return Promise.resolve([
          { index: 0, name: 'Built-in Output', is_default: true },
          { index: 1, name: 'USB Headset' },
          { index: 2, name: 'HDMI Audio' },
        ]);
      }
      return Promise.resolve(undefined);
    });
    // A non-null mediaEngine marks the active session as native (QUIC) rather
    // than LiveKit; room stays null on that path.
    useVoiceStore.setState({
      room: null,
      mediaEngine: { disconnect: () => Promise.resolve() } as never,
    });
  });

  afterEach(() => {
    useVoiceStore.setState({ mediaEngine: null });
    vi.restoreAllMocks();
  });

  it('invokes voice_switch_output_device with the mapped cpal index', async () => {
    await useVoiceStore.getState().applyAudioOutputDevice('HDMI Audio');

    expect(invokeMock).toHaveBeenCalledWith('voice_list_output_devices', undefined);
    expect(invokeMock).toHaveBeenCalledWith('voice_switch_output_device', { deviceId: '2' });
  });

  it('does not switch natively when no native session is active', async () => {
    useVoiceStore.setState({ mediaEngine: null });
    await useVoiceStore.getState().applyAudioOutputDevice('HDMI Audio');
    expect(invokeMock).not.toHaveBeenCalledWith('voice_switch_output_device', expect.anything());
  });
});
