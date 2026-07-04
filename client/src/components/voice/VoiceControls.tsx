import { useMemo, useState, useCallback } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, Monitor, PhoneOff, Signal, MonitorOff, Video, VideoOff } from 'lucide-react';
import { useVoice } from '../../hooks/useVoice';
import { useChannelStore } from '../../stores/channelStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { ScreenSharePickerModal } from './ScreenSharePickerModal';
import type { ScreenShareSource } from '../../lib/media/mediaEngine';
import { logVoiceDiagnostic } from '../../lib/desktopDiagnostics';

function thumbnailToDataUrl(thumbnail: { dataUrl: string } | null): string | null {
  return thumbnail?.dataUrl ?? null;
}

function getPickerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unable to start stream.';
}

export function VoiceControls() {
  const {
    connected,
    channelId,
    selfMute,
    selfDeaf,
    selfStream,
    selfVideo,
    leaveChannel,
    toggleMute,
    toggleDeaf,
    startStream,
    stopStream,
    toggleVideo,
  } = useVoice();
  const channels = useChannelStore((s) => s.channels);
  const mediaEngine = useVoiceStore((s) => s.mediaEngine);
  const [startingStream, setStartingStream] = useState(false);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [screenSources, setScreenSources] = useState<ScreenShareSource[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const channelName = useMemo(
    () => channels.find((c) => c.id === channelId)?.name ?? 'Voice Channel',
    [channels, channelId]
  );

  const loadScreenSources = useCallback(async () => {
    if (!mediaEngine || !mediaEngine.supportsNativeSourcePicker()) return;
    setSourcesLoading(true);
    setPickerError(null);
    try {
      const sources = await mediaEngine.listScreenShareSources();
      setScreenSources(sources);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : 'Failed to load screen share sources.';
      setPickerError(message);
    } finally {
      setSourcesLoading(false);
    }
  }, [mediaEngine]);

  const loadThumbnail = useCallback(async (sourceId: string): Promise<string | null> => {
    if (!mediaEngine || !mediaEngine.supportsNativeSourcePicker()) return null;
    const thumbnail = await mediaEngine.getScreenShareSourceThumbnail(sourceId);
    return thumbnailToDataUrl(thumbnail);
  }, [mediaEngine]);

  const openSourcePicker = useCallback(async () => {
    setShowSourcePicker(true);
    await loadScreenSources();
  }, [loadScreenSources]);

  if (!connected) return null;

  // Shared control base — 40px, radius-sm, layered focus ring, tactile press.
  const ctrl =
    'flex h-10 w-10 items-center justify-center rounded-sm outline-none transition-[background-color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97] disabled:opacity-70';
  const idle = 'text-interactive-normal hover:bg-bg-mod-subtle hover:text-interactive-hover';
  const activeOn = 'bg-accent-tint text-accent-primary hover:bg-accent-tint-strong';
  const activeDanger = 'bg-danger-tint text-accent-danger';

  return (
    <>
    <div className="px-3 py-3">
      <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-accent shadow-sm">
        {/* Connection status header */}
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-3.5">
          <Signal size={16} className="voice-connected-pulse shrink-0" style={{ color: 'var(--status-online)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-meta font-semibold" style={{ color: 'var(--status-online)' }}>
              Voice Connected
            </div>
            <div className="truncate text-label text-text-primary">{channelName}</div>
          </div>
        </div>

        <div className="h-px bg-border-subtle" />

        {/* Action buttons row */}
        <div className="flex items-center gap-1.5 px-3 py-3">
          <button
            onClick={toggleMute}
            className={`${ctrl} ${selfMute ? activeDanger : idle}`}
            aria-label={selfMute ? 'Unmute' : 'Mute'}
            title={selfMute ? 'Unmute' : 'Mute'}
          >
            {selfMute ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button
            onClick={toggleDeaf}
            className={`${ctrl} ${selfDeaf ? activeDanger : idle}`}
            aria-label={selfDeaf ? 'Undeafen' : 'Deafen'}
            title={selfDeaf ? 'Undeafen' : 'Deafen'}
          >
            {selfDeaf ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
          </button>
          <button
            onClick={toggleVideo}
            className={`${ctrl} ${selfVideo ? activeOn : idle}`}
            aria-label={selfVideo ? 'Turn Off Camera' : 'Turn On Camera'}
            title={selfVideo ? 'Turn Off Camera' : 'Turn On Camera'}
          >
            {selfVideo ? <VideoOff size={18} /> : <Video size={18} />}
          </button>
          <button
            onClick={async () => {
              if (selfStream) {
                stopStream();
              } else {
                if (mediaEngine?.supportsNativeSourcePicker()) {
                  await openSourcePicker();
                } else {
                  setStartingStream(true);
                  try {
                    await startStream();
                  } catch {
                    // Error is surfaced in the voice panel / stream viewer
                  } finally {
                    setStartingStream(false);
                  }
                }
              }
            }}
            className={`${ctrl} ${selfStream ? activeOn : idle}`}
            disabled={startingStream}
            aria-label={selfStream ? 'Stop Sharing' : 'Share Screen'}
            title={selfStream ? 'Stop Sharing' : 'Share Screen'}
          >
            {selfStream ? <MonitorOff size={18} /> : <Monitor size={18} />}
          </button>

          {/* Spacer pushes disconnect to the right */}
          <div className="flex-1" />

          <button
            className={`${ctrl} text-interactive-normal hover:bg-danger-tint hover:text-accent-danger`}
            onClick={() => void leaveChannel()}
            aria-label="Disconnect"
            title="Disconnect"
          >
            <PhoneOff size={18} />
          </button>
        </div>
      </div>
    </div>
    {showSourcePicker && !selfStream && (
      <ScreenSharePickerModal
        sources={screenSources}
        loading={sourcesLoading}
        error={pickerError}
        loadThumbnail={loadThumbnail}
        onClose={() => {
          if (!startingStream) {
            setShowSourcePicker(false);
          }
        }}
        onRefresh={() => { void loadScreenSources(); }}
        onSelect={async (source) => {
          setPickerError(null);
          setStartingStream(true);
          try {
            logVoiceDiagnostic('[picker] start stream requested', { sourceId: source.id });
            await startStream(undefined, source.id);
            setShowSourcePicker(false);
          } catch (error) {
            setPickerError(getPickerErrorMessage(error));
          } finally {
            setStartingStream(false);
          }
        }}
      />
    )}
    </>
  );
}
