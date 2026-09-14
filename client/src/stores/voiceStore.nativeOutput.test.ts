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
        return Promise.resolve({
          backend: 'sound-server',
          warning: null,
          devices: [
            { id: '@default', name: 'System default', is_default: true, group: 'system-default' },
            { id: 'alsa_output.usb-headset', name: 'USB Headset', group: 'device' },
            { id: 'alsa_output.hdmi-stereo', name: 'HDMI Audio', group: 'device' },
          ],
        });
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

  it('rejects a synthetic native engine without a call owner', async () => {
    await useVoiceStore.getState().applyAudioOutputDevice('HDMI Audio');

    expect(invokeMock).not.toHaveBeenCalledWith('voice_switch_output_device', expect.anything());
  });

  it('does not switch natively when no native session is active', async () => {
    useVoiceStore.setState({ mediaEngine: null });
    await useVoiceStore.getState().applyAudioOutputDevice('HDMI Audio');
    expect(invokeMock).not.toHaveBeenCalledWith('voice_switch_output_device', expect.anything());
  });
});
