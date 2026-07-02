import { useCallback } from 'react';
import { useVoiceStore } from '../stores/voiceStore';

export function useStream() {
  const selfStream = useVoiceStore((s) => s.selfStream);
  const connected = useVoiceStore((s) => s.connected);

  const startStream = useCallback(async (qualityPreset?: string, sourceId?: string) => {
    if (!connected) return;
    await useVoiceStore.getState().startStream(qualityPreset, sourceId);
  }, [connected]);

  const stopStream = useCallback(() => {
    useVoiceStore.getState().stopStream();
  }, []);

  return { selfStream, startStream, stopStream };
}
