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
  const owner = { id: 'call-owner', assertCurrent: vi.fn() };
  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the selected name to the stable device id and switches the device', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'voice_list_output_devices') {
        return Promise.resolve({
          backend: 'sound-server',
          warning: null,
          devices: [
            { id: '@default', name: 'System default', is_default: true, group: 'system-default' },
            {
              id: 'alsa_output.usb-Focusrite_Scarlett_Solo_USB-00.Direct__Direct__sink',
              name: 'Scarlett Solo USB',
              detail: 'Direct',
              group: 'device',
            },
          ],
        });
      }
      return Promise.resolve(undefined);
    });

    await switchNativeOutputDevice('Scarlett Solo USB', owner);

    expect(invokeMock).toHaveBeenCalledWith('voice_switch_output_device', {
      deviceId: 'alsa_output.usb-Focusrite_Scarlett_Solo_USB-00.Direct__Direct__sink',
      ownerId: 'call-owner',
    });
  });

  it('still reads an older backend that answered a bare array of indices', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'voice_list_output_devices') {
        return Promise.resolve([
          { index: 0, name: 'Built-in Output', is_default: true },
          { index: 1, name: 'USB Headset' },
        ]);
      }
      return Promise.resolve(undefined);
    });

    await switchNativeOutputDevice('USB Headset', owner);

    expect(invokeMock).toHaveBeenCalledWith('voice_switch_output_device', { deviceId: '1', ownerId: 'call-owner' });
  });

  it('falls back to the system default and never throws when the list command is unavailable', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'voice_list_output_devices') {
        return Promise.reject(new Error('command not found'));
      }
      return Promise.resolve(undefined);
    });

    await expect(switchNativeOutputDevice('Some Device', owner)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('voice_switch_output_device', { deviceId: '@default', ownerId: 'call-owner' });
  });

  it('returns an empty list rather than throwing on enumeration failure', async () => {
    invokeMock.mockRejectedValue(new Error('nope'));
    await expect(listNativeOutputDevices()).resolves.toEqual([]);
  });
});
