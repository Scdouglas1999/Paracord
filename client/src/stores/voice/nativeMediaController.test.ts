import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
}));

vi.mock('../../lib/tauriEnv', () => ({
  isTauri: () => true,
}));

import { listNativeOutputDevices, switchNativeOutputDevice } from './nativeMediaController';

describe('switchNativeOutputDevice', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the selected label to a cpal index and switches the device', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'voice_list_output_devices') {
        return Promise.resolve([
          { index: 0, name: 'Built-in Output', is_default: true },
          { index: 1, name: 'USB Headset' },
        ]);
      }
      return Promise.resolve(undefined);
    });

    await switchNativeOutputDevice('USB Headset');

    expect(invokeMock).toHaveBeenCalledWith('voice_switch_output_device', { deviceId: '1' });
  });

  it('falls back to index 0 and never throws when the list command is unavailable', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'voice_list_output_devices') {
        return Promise.reject(new Error('command not found'));
      }
      return Promise.resolve(undefined);
    });

    await expect(switchNativeOutputDevice('Some Device')).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('voice_switch_output_device', { deviceId: '0' });
  });

  it('returns an empty list rather than throwing on enumeration failure', async () => {
    invokeMock.mockRejectedValue(new Error('nope'));
    await expect(listNativeOutputDevices()).resolves.toEqual([]);
  });
});
