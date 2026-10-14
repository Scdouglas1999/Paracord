import { isTauri } from '../tauriEnv';
import { getVersionedStorageItem, setVersionedStorageItem } from '../versionedStorage';

const NOTIFICATIONS_ENABLED_KEY = 'notifications-enabled';

/**
 * Check if notification permission has been granted.
 * Uses Tauri notification plugin when available, falls back to browser API.
 */
export async function isPermissionGranted(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { isPermissionGranted: tauriIsGranted } = await import(
        '@tauri-apps/plugin-notification'
      );
      return await tauriIsGranted();
    } catch {
      // Plugin not available, fall through to browser API
    }
  }

  if (typeof Notification === 'undefined') return false;
  return Notification.permission === 'granted';
}

/**
 * Request notification permission from the user.
 * Returns true if permission was granted.
 */
export async function requestPermission(): Promise<boolean> {
  if (isTauri()) {
    try {
      const {
        isPermissionGranted: tauriIsGranted,
        requestPermission: tauriRequestPermission,
      } = await import('@tauri-apps/plugin-notification');
      let granted = await tauriIsGranted();
      if (!granted) {
        const result = await tauriRequestPermission();
        granted = result === 'granted';
      }
      return granted;
    } catch {
      // Plugin not available, fall through
    }
  }

  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  const result = await Notification.requestPermission();
  return result === 'granted';
}

/**
 * Whether this app is sharing a screen with the computer's sound. An OS
 * notification's sound is played by the desktop's notification service, which
 * the share's sound capture cannot tell from any other application's, so it
 * would go out to every viewer (stream-fix V5). Read at send time from the
 * voice store (imported lazily: the store is large and loaded by then).
 */
async function sharingComputerSound(): Promise<boolean> {
  try {
    const { useVoiceStore } = await import('../../stores/voiceStore');
    const state = useVoiceStore.getState();
    return Boolean(state.selfStream && state.systemAudioCaptureActive);
  } catch {
    return false;
  }
}

/**
 * Send a desktop notification. While this app shares a screen with sound the
 * notification is shown without its sound, and its sound comes back with the
 * share's end; the popup itself is unchanged.
 */
export async function sendNotification(
  title: string,
  body: string,
): Promise<void> {
  if (!isEnabled()) return;
  const quiet = await sharingComputerSound();

  if (isTauri() && quiet) {
    // No fallback to the plugin: on Linux it would make the sound this avoids.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('notification_show_quiet', { title, body });
    } catch (error) {
      console.error('[notifications] a quiet notification could not be shown while sharing with sound:', error);
    }
    return;
  }

  if (isTauri()) {
    try {
      const {
        isPermissionGranted: tauriIsGranted,
        sendNotification: tauriSend,
      } = await import('@tauri-apps/plugin-notification');
      const granted = await tauriIsGranted();
      if (granted) {
        tauriSend({ title, body });
        return;
      }
    } catch {
      // Plugin not available, fall through
    }
  }

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(title, quiet ? { body, silent: true } : { body });
  }
}

/**
 * Check if the user has enabled desktop notifications in their preferences.
 */
export function isEnabled(): boolean {
  try {
    return getVersionedStorageItem(NOTIFICATIONS_ENABLED_KEY, ['notifications-enabled']) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Set the user's notification preference.
 */
export function setEnabled(enabled: boolean): void {
  try {
    setVersionedStorageItem(NOTIFICATIONS_ENABLED_KEY, String(enabled));
  } catch {
    // localStorage unavailable
  }
}
