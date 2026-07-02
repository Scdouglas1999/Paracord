import { isTauri } from './tauriEnv';
import { SystemAudioBridge } from './systemAudioWorklet';
import { logVoiceDiagnostic } from './desktopDiagnostics';

let activeBridge: SystemAudioBridge | null = null;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isCaptureAlreadyRunningError(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes('already running');
}

export async function startNativeSystemAudio(): Promise<MediaStreamTrack | null> {
  if (!isTauri()) return null;

  let bridge: SystemAudioBridge | null = null;

  try {
    logVoiceDiagnostic('[voice] system audio: starting');
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    await invoke('set_system_audio_capture_enabled', { enabled: true });

    // Recover from stale sessions where the backend thread survived but our
    // previous JS bridge was lost (e.g. reconnect edge cases).
    await invoke('stop_system_audio_capture').catch(() => {});

    if (activeBridge) {
      activeBridge.stop();
      activeBridge = null;
    }

    logVoiceDiagnostic('[voice] system audio: creating AudioWorklet bridge');
    bridge = new SystemAudioBridge();
    const workingBridge = bridge;
    const track = await workingBridge.start();
    logVoiceDiagnostic('[voice] system audio: bridge started, requesting Rust capture');

    const channel = new Channel<{ samples: number[]; sample_rate: number }>();
    channel.onmessage = (msg) => {
      workingBridge.pushSamples(new Float32Array(msg.samples));
    };

    try {
      await invoke('start_system_audio_capture', { onAudio: channel });
    } catch (startErr) {
      // One retry path for "already running" races from overlapping stop/start.
      if (!isCaptureAlreadyRunningError(startErr)) {
        throw startErr;
      }
      await invoke('stop_system_audio_capture').catch(() => {});
      await invoke('start_system_audio_capture', { onAudio: channel });
    }

    activeBridge = bridge;
    console.info('[voice] Native system audio capture started (stereo)');
    return track;
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn('[voice] Failed to start native system audio capture:', err);
    logVoiceDiagnostic('[voice] system audio capture FAILED', { error: errMsg });
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_system_audio_capture_enabled', { enabled: false });
    } catch {
      // ignore
    }
    bridge?.stop();
    if (activeBridge === bridge) {
      activeBridge = null;
    }
    return null;
  }
}

export async function stopNativeSystemAudio(): Promise<void> {
  const bridge = activeBridge;
  activeBridge = null;

  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('stop_system_audio_capture');
      await invoke('set_system_audio_capture_enabled', { enabled: false });
    }
  } catch (err) {
    console.warn('[voice] Error stopping native audio capture:', err);
  }

  bridge?.stop();
  if (bridge) {
    console.info('[voice] Native system audio capture stopped');
  }
}

