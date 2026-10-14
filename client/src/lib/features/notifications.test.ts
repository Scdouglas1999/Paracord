import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * While this app shares a screen with the computer's sound, its OS
 * notifications make no sound (the notification service's sound would be
 * captured into the stream); the popup still shows, and the sound comes back
 * when the share ends (stream-fix V5).
 */
const env = vi.hoisted(() => ({ tauri: true }));
const voice = vi.hoisted(() => ({ selfStream: false, systemAudioCaptureActive: false }));
const invoke = vi.hoisted(() => vi.fn(async () => undefined));
const pluginSend = vi.hoisted(() => vi.fn());

vi.mock('../tauriEnv', () => ({ isTauri: () => env.tauri }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: pluginSend,
}));
vi.mock('../../stores/voiceStore', () => ({ useVoiceStore: { getState: () => voice } }));

import { sendNotification } from './notifications';

beforeEach(() => {
  env.tauri = true;
  voice.selfStream = false;
  voice.systemAudioCaptureActive = false;
  invoke.mockClear();
  pluginSend.mockClear();
});

describe('sendNotification', () => {
  it('not sharing: the plugin, with the desktop\'s own sound', async () => {
    await sendNotification('Vincent', 'hello');
    expect(pluginSend).toHaveBeenCalledWith({ title: 'Vincent', body: 'hello' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sharing with sound: the quiet notification, never the plugin', async () => {
    voice.selfStream = true;
    voice.systemAudioCaptureActive = true;
    await sendNotification('Vincent', 'hello');
    expect(invoke).toHaveBeenCalledWith('notification_show_quiet', { title: 'Vincent', body: 'hello' });
    expect(pluginSend).not.toHaveBeenCalled();
  });

  it('a quiet notification that fails is logged, not replaced by one with sound', async () => {
    voice.selfStream = true;
    voice.systemAudioCaptureActive = true;
    invoke.mockRejectedValueOnce(new Error('no notification server'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendNotification('Vincent', 'hello');
    expect(error).toHaveBeenCalled();
    expect(pluginSend).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('sharing without sound, and after the share: the sound is back', async () => {
    voice.selfStream = true;
    await sendNotification('Vincent', 'one');
    voice.selfStream = false;
    voice.systemAudioCaptureActive = false;
    await sendNotification('Vincent', 'two');
    expect(pluginSend).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('in a browser, a share with sound sends a silent Notification', async () => {
    env.tauri = false;
    voice.selfStream = true;
    voice.systemAudioCaptureActive = true;
    const made: Array<{ title: string; options?: NotificationOptions }> = [];
    class FakeNotification {
      static permission = 'granted';
      constructor(title: string, options?: NotificationOptions) {
        made.push({ title, options });
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    await sendNotification('Vincent', 'hello');
    expect(made).toEqual([{ title: 'Vincent', options: { body: 'hello', silent: true } }]);
    vi.unstubAllGlobals();
  });
});
