import { useCallback, useState } from 'react';
import { create } from 'zustand';

import type { ScreenShareSource } from '../../../lib/media/mediaEngine';
import { logVoiceDiagnostic } from '../../../lib/desktopDiagnostics';
import { toast } from '../../../stores/toastStore';
import { useVoiceStore } from '../../../stores/voiceStore';

/**
 * The stage's share button (joined only): start or stop sharing your screen in
 * the call. The desktop app asks which screen or window first (its own picker);
 * the browser asks through `getDisplayMedia`. The same store calls and quality
 * presets the Lantern control bar offered (chosen under More, "Share quality"),
 * and a failure, or a share without the computer's sound, is said with the reason.
 */

/**
 * What a share can send (the store's native presets, `voiceStore.startStream`).
 * A preset names a height in lines and keeps the screen's own shape, so on a
 * 32:9 screen "1080p" is 3840x1080; "4K" is 2160 lines or the screen's own
 * size when it has fewer. The standard presets' bitrates follow the picture's
 * pixel count; the Movie presets keep their stated bitrate on any screen. A
 * preset that sends the same picture as a smaller one on a screen uses that
 * one's settings there (`resolve_screen_preset` on the native side), and the
 * menu says so (`shareQualitySameAs`).
 */
export const SHARE_QUALITIES = [
  { value: '720p30', label: '720p 30fps' },
  { value: '1080p60', label: '1080p 60fps' },
  { value: '1440p60', label: '1440p 60fps' },
  { value: '4k60', label: '4K 60fps' },
  { value: 'movie-50', label: 'Movie (up to 50 Mbps)' },
  { value: 'movie-100', label: 'Movie (up to 100 Mbps)' },
] as const;

/** The menu's note on what the sizes mean on a screen that is not 16:9. */
export const SHARE_QUALITY_HINT =
  'Each size is a height: a wider screen keeps its shape, and a screen with fewer lines sends its own size. ' +
  'The bitrate follows the picture, except Movie, which keeps its own.';

export type ShareQuality = (typeof SHARE_QUALITIES)[number]['value'];

/** 720p30 by default, for what capture costs; every higher preset stays one choice away. */
export const DEFAULT_SHARE_QUALITY: ShareQuality = '720p30';

export const useShareQualityStore = create<{ quality: ShareQuality; setQuality: (quality: ShareQuality) => void }>()(
  (set) => ({
    quality: DEFAULT_SHARE_QUALITY,
    setQuality: (quality) => set({ quality }),
  }),
);

/**
 * The standard presets' size and frame rate, smallest first (the Movie presets
 * never stand in for another). Keep in step with `STANDARD_SCREEN_PRESETS` in
 * `paracord-codec`, which applies the same rule to what is sent.
 */
const STANDARD_SHARE_SIZES: ReadonlyArray<{ value: ShareQuality; name: string; height: number; fps: number }> = [
  { value: '720p30', name: '720p', height: 720, fps: 30 },
  { value: '1080p60', name: '1080p', height: 1080, fps: 60 },
  { value: '1440p60', name: '1440p', height: 1440, fps: 60 },
  { value: '4k60', name: '4K', height: 2160, fps: 60 },
];

function sentSize(screenWidth: number, screenHeight: number, presetHeight: number): string {
  const lines = Math.min(presetHeight, screenHeight);
  const even = (value: number) => Math.max(2, Math.floor(value) & ~1);
  return `${even((screenWidth * lines) / screenHeight)}x${even(lines)}`;
}

/**
 * The smaller standard preset `quality` sends exactly the same picture as on a
 * `width`x`height` screen (same size, same frame rate), by its menu name
 * ("1440p"), or null when it is its own. "4K" on a 1440-line screen is "1440p".
 */
export function shareQualitySameAs(quality: ShareQuality, width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return null;
  const preset = STANDARD_SHARE_SIZES.find((entry) => entry.value === quality);
  if (!preset) return null;
  const size = sentSize(width, height, preset.height);
  const same = STANDARD_SHARE_SIZES.find(
    (entry) => entry.height < preset.height && entry.fps === preset.fps && sentSize(width, height, entry.height) === size,
  );
  return same?.name ?? null;
}

export function shareQualityLabel(quality: ShareQuality): string {
  return SHARE_QUALITIES.find((option) => option.value === quality)?.label ?? quality;
}

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
      await useVoiceStore.getState().startStream(useShareQualityStore.getState().quality, sourceId);
      setPickerOpen(false);
      // Sharing without the computer's own sound is said, with the reason.
      const warning = useVoiceStore.getState().streamAudioWarning;
      if (warning) toast.warning(warning, 10_000);
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
