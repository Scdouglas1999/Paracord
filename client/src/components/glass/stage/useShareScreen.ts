import { useCallback, useState } from 'react';

import type { ScreenShareSource } from '../../../lib/media/mediaEngine';
import { logVoiceDiagnostic } from '../../../lib/desktopDiagnostics';
import { toast } from '../../../stores/toastStore';
import { useVoiceStore } from '../../../stores/voiceStore';

/**
 * The stage's share button (joined only): start or stop sharing your screen in
 * the call. The desktop app asks which screen or window first (its own picker);
 * the browser asks through `getDisplayMedia`. The same store calls and quality
 * default as the Lantern control bar (`components/voice/VoiceControlBar.tsx`),
 * and a failure is said out loud with the reason.
 */

/** The Lantern bar's starting quality. */
const DEFAULT_QUALITY = '720p30';

export function shareErrorMessage(error: unknown): string {
  const err = error as { name?: string; message?: string };
  const name = err?.name || '';
  const raw = err?.message || (typeof error === 'string' ? error : String(error || ''));
  const message = raw.toLowerCase();
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Screen share permission was denied. Allow screen capture for this app and try again.';
  }
  if (name === 'NotReadableError') return 'Screen capture is blocked by your system or another app.';
  if (name === 'NotFoundError') return 'No shareable screen or window was found.';
  if (name === 'AbortError') return 'The share prompt was closed before a screen was picked.';
  if (message.includes('voice connection is not ready')) return 'The call is not ready yet. Try again in a moment.';
  if (message.includes('vpx') || message.includes('screen share encoding')) {
    return 'Screen sharing needs the VP9 encoder (libvpx) in this build.';
  }
  return raw || 'The share could not start.';
}

export interface ShareScreen {
  sharing: boolean;
  starting: boolean;
  /** The desktop picker is open. */
  pickerOpen: boolean;
  sources: ScreenShareSource[];
  sourcesLoading: boolean;
  error: string | null;
  toggle: () => void;
  pick: (source: ScreenShareSource) => void;
  closePicker: () => void;
  refreshSources: () => void;
  loadThumbnail: (sourceId: string) => Promise<string | null>;
}

export function useShareScreen(): ShareScreen {
  const sharing = useVoiceStore((state) => state.selfStream);
  const engine = useVoiceStore((state) => state.mediaEngine);
  const [starting, setStarting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState<ScreenShareSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    if (!engine || !engine.supportsNativeSourcePicker()) return;
    setSourcesLoading(true);
    setError(null);
    try {
      setSources(await engine.listScreenShareSources());
    } catch (failure) {
      setError(shareErrorMessage(failure));
    } finally {
      setSourcesLoading(false);
    }
  }, [engine]);

  const start = useCallback(async (sourceId?: string) => {
    setStarting(true);
    setError(null);
    try {
      logVoiceDiagnostic('[glass-stage] start stream requested', { sourceId: sourceId ?? null });
      await useVoiceStore.getState().startStream(DEFAULT_QUALITY, sourceId);
      setPickerOpen(false);
    } catch (failure) {
      const message = shareErrorMessage(failure);
      setError(message);
      toast.error(`Could not share your screen: ${message}`);
    } finally {
      setStarting(false);
    }
  }, []);

  const toggle = useCallback(() => {
    if (starting) return;
    if (useVoiceStore.getState().selfStream) {
      useVoiceStore.getState().stopStream();
      return;
    }
    if (engine?.supportsNativeSourcePicker()) {
      setPickerOpen(true);
      void loadSources();
      return;
    }
    void start();
  }, [engine, loadSources, start, starting]);

  const loadThumbnail = useCallback(
    async (sourceId: string): Promise<string | null> => {
      if (!engine || !engine.supportsNativeSourcePicker()) return null;
      const thumbnail = await engine.getScreenShareSourceThumbnail(sourceId);
      return thumbnail?.dataUrl ?? null;
    },
    [engine],
  );

  return {
    sharing,
    starting,
    pickerOpen,
    sources,
    sourcesLoading,
    error,
    toggle,
    pick: (source) => void start(source.id),
    closePicker: () => {
      if (!starting) setPickerOpen(false);
    },
    refreshSources: () => void loadSources(),
    loadThumbnail,
  };
}
