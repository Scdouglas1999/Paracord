import { isTauri } from './tauriEnv';
import { SystemAudioBridge } from './systemAudioWorklet';

let activeBridge: SystemAudioBridge | null = null;

export async function startNativeSystemAudio(): Promise<MediaStreamTrack | null> {
  if (!isTauri()) return null;

  try {
    const { invoke, Channel } = await import('@tauri-apps/api/core');

    const bridge = new SystemAudioBridge();
    const track = await bridge.start();

    const channel = new Channel<{ samples: number[]; sample_rate: number }>();
    channel.onmessage = (msg) => {
      bridge.pushSamples(new Float32Array(msg.samples));
    };

    await invoke('start_system_audio_capture', { onAudio: channel });

    activeBridge = bridge;
    console.info('[voice] Native system audio capture started');
    return track;
  } catch (err) {
    console.warn('[voice] Failed to start native system audio capture:', err);
    activeBridge?.stop();
    activeBridge = null;
    return null;
  }
}

export async function stopNativeSystemAudio(): Promise<void> {
  if (!activeBridge) return;

  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('stop_system_audio_capture');
    }
  } catch (err) {
    console.warn('[voice] Error stopping native audio capture:', err);
  }

  activeBridge.stop();
  activeBridge = null;
  console.info('[voice] Native system audio capture stopped');
}
