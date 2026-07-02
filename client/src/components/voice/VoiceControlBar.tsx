import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, MonitorUp, PhoneOff, ChevronUp, AlertTriangle, MonitorOff, MessageSquare, Radio } from 'lucide-react';
import { useVoice } from '../../hooks/useVoice';
import { useStream } from '../../hooks/useStream';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { cn } from '../../lib/utils';
import { Tooltip } from '../ui/Tooltip';
import { ScreenSharePickerModal } from './ScreenSharePickerModal';
import type { ScreenShareSource } from '../../lib/media/mediaEngine';
import { logVoiceDiagnostic } from '../../lib/desktopDiagnostics';

function thumbnailToDataUrl(thumbnail: { dataUrl: string } | null): string | null {
    return thumbnail?.dataUrl ?? null;
}

function getStreamErrorMessage(error: unknown): string {
    const err = error as { name?: string; message?: string };
    const name = err?.name || '';
    // Tauri IPC errors are thrown as plain strings; handle both Error objects and strings.
    const rawMessage = err?.message || (typeof error === 'string' ? error : String(error || ''));
    const message = rawMessage.toLowerCase();

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        return 'Screen share permission was denied. Allow screen capture for this app and try again.';
    }
    if (name === 'NotReadableError') {
        return 'Screen capture is blocked by your OS or another app. Close protected content and retry.';
    }
    if (name === 'NotFoundError') {
        return 'No shareable display source was found.';
    }
    if (name === 'AbortError') {
        return 'Screen share prompt was closed before selecting a source.';
    }
    if (message.includes('voice connection is not ready')) {
        return 'Voice connection is not ready yet. Wait a moment and try again.';
    }
    if (message.includes('secure') || message.includes('https')) {
        return 'Screen sharing requires a secure context. Use localhost or HTTPS.';
    }
    if (message.includes('vpx') || message.includes('screen share encoding')) {
        return 'Screen sharing requires the VP9 encoder (libvpx). Install libvpx and rebuild with the vpx feature.';
    }

    // Always show the actual error so we can diagnose issues.
    // Build a detailed fallback that includes whatever we can extract.
    const detail = rawMessage || (error != null ? JSON.stringify(error) : '(no error details)');
    if (name) {
        return `Unable to start stream (${name}): ${detail}`;
    }
    return `Unable to start stream: ${detail}`;
}

export function VoiceControlBar({
    onToggleChat,
    isChatOpen
}: {
    onToggleChat?: () => void;
    isChatOpen?: boolean;
}) {
    const { selfMute, selfDeaf, toggleMute, toggleDeaf, leaveChannel } = useVoice();
    const { selfStream, startStream, stopStream } = useStream();
    const streamAudioWarning = useVoiceStore((s) => s.streamAudioWarning);
    const mediaEngine = useVoiceStore((s) => s.mediaEngine);
    const pttEngaged = useVoiceStore((s) => s.pttEngaged);
    const rawNotifications = useAuthStore((s) => s.settings?.notifications as Record<string, unknown> | undefined);
    const isPttMode = (rawNotifications?.['voiceInputMode'] ?? 'voice_activity') === 'push_to_talk';

    const [streamStarting, setStreamStarting] = useState(false);
    const [streamError, setStreamError] = useState<string | null>(null);
    const [captureQuality, setCaptureQuality] = useState('1080p60');
    const [showStreamMenu, setShowStreamMenu] = useState(false);
    const [showError, setShowError] = useState(false);
    const [showSourcePicker, setShowSourcePicker] = useState(false);
    const [screenSources, setScreenSources] = useState<ScreenShareSource[]>([]);
    const [sourcesLoading, setSourcesLoading] = useState(false);

    const streamMenuRef = useRef<HTMLDivElement>(null);

    const streamIssueMessage = streamError || streamAudioWarning;

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (streamMenuRef.current && !streamMenuRef.current.contains(event.target as Node)) {
                setShowStreamMenu(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const loadScreenSources = useCallback(async () => {
        if (!mediaEngine || !mediaEngine.supportsNativeSourcePicker()) return;
        setSourcesLoading(true);
        setStreamError(null);
        try {
            const sources = await mediaEngine.listScreenShareSources();
            setScreenSources(sources);
        } catch (error) {
            setStreamError(getStreamErrorMessage(error));
        } finally {
            setSourcesLoading(false);
        }
    }, [mediaEngine]);

    const loadThumbnail = useCallback(async (sourceId: string): Promise<string | null> => {
        if (!mediaEngine || !mediaEngine.supportsNativeSourcePicker()) return null;
        const thumbnail = await mediaEngine.getScreenShareSourceThumbnail(sourceId);
        return thumbnailToDataUrl(thumbnail);
    }, [mediaEngine]);

    const handleStartStream = useCallback(async (sourceId?: string) => {
        setShowStreamMenu(false);
        setStreamError(null);
        setShowError(false);
        setStreamStarting(true);
        try {
            logVoiceDiagnostic('[picker] start stream requested', { sourceId: sourceId ?? null });
            await startStream(captureQuality, sourceId);
            setShowSourcePicker(false);
        } catch (error) {
            setStreamError(getStreamErrorMessage(error));
            setShowError(true);
        } finally {
            setStreamStarting(false);
        }
    }, [captureQuality, startStream]);

    const handleStopStream = () => {
        stopStream();
        setStreamError(null);
        setShowError(false);
        setShowStreamMenu(false);
        setShowSourcePicker(false);
    };

    const openSourcePicker = useCallback(async () => {
        setShowStreamMenu(false);
        setShowError(false);
        setShowSourcePicker(true);
        await loadScreenSources();
    }, [loadScreenSources]);

    return (
        <>
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-border-strong bg-bg-primary/80 px-4 py-2.5 shadow-2xl backdrop-blur-xl">
            <Tooltip
                content={
                    isPttMode
                        ? pttEngaged ? 'Transmitting (PTT)' : 'Push to Talk (muted)'
                        : selfMute ? 'Unmute' : 'Mute'
                }
                side="top"
            >
                <button
                    aria-label={
                        isPttMode
                            ? pttEngaged ? 'Transmitting with push to talk' : 'Push to talk muted'
                            : selfMute ? 'Unmute microphone' : 'Mute microphone'
                    }
                    onClick={() => { if (!isPttMode) toggleMute(); }}
                    className={cn(
                        'flex h-12 w-12 items-center justify-center rounded-full transition-all group',
                        isPttMode
                            ? pttEngaged
                                ? 'bg-accent-success/20 text-accent-success ring-2 ring-accent-success/50'
                                : 'bg-accent-danger/20 text-accent-danger'
                            : selfMute
                                ? 'bg-accent-danger/20 text-accent-danger hover:bg-accent-danger/30'
                                : 'bg-bg-mod-strong text-text-primary hover:bg-bg-mod-subtle'
                    )}
                    style={{ cursor: isPttMode ? 'default' : undefined }}
                >
                    {isPttMode
                        ? pttEngaged
                            ? <Radio size={22} className="animate-pulse" />
                            : <MicOff size={22} />
                        : selfMute
                            ? <MicOff size={22} className="group-hover:scale-110 transition-transform" />
                            : <Mic size={22} className="group-hover:scale-110 transition-transform" />
                    }
                </button>
            </Tooltip>

            <Tooltip content={selfDeaf ? 'Undeafen' : 'Deafen'} side="top">
                <button
                    aria-label={selfDeaf ? 'Undeafen audio' : 'Deafen audio'}
                    onClick={() => toggleDeaf()}
                    className={cn(
                        'flex h-12 w-12 items-center justify-center rounded-full transition-all group',
                        selfDeaf
                            ? 'bg-accent-danger/20 text-accent-danger hover:bg-accent-danger/30'
                            : 'bg-bg-mod-strong text-text-primary hover:bg-bg-mod-subtle'
                    )}
                >
                    {selfDeaf ? <HeadphoneOff size={22} className="group-hover:scale-110 transition-transform" /> : <Headphones size={22} className="group-hover:scale-110 transition-transform" />}
                </button>
            </Tooltip>

            <div className="h-8 w-px bg-border-strong mx-1" />

            {/* Screen Share Dropdown logic */}
            <div className="relative flex items-center" ref={streamMenuRef}>
                <div className="flex bg-bg-mod-strong rounded-full overflow-hidden hover:bg-bg-mod-subtle transition-colors">
                    <Tooltip content={selfStream ? 'Stop Streaming' : 'Share Screen'} side="top">
                        <button
                            aria-label={selfStream ? 'Stop streaming' : streamStarting ? 'Starting screen share' : 'Share screen'}
                            disabled={streamStarting}
                            onClick={selfStream ? handleStopStream : () => {
                                if (mediaEngine?.supportsNativeSourcePicker()) {
                                    void openSourcePicker();
                                    return;
                                }
                                void handleStartStream();
                            }}
                            className={cn(
                                'flex h-12 items-center gap-2 px-4 transition-all group',
                                selfStream
                                    ? 'bg-accent-primary text-white hover:bg-accent-primary/90'
                                    : 'text-text-primary'
                            )}
                        >
                            {selfStream ? (
                                <MonitorOff size={20} className="group-hover:scale-110 transition-transform" />
                            ) : streamStarting ? (
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            ) : (
                                <MonitorUp size={20} className="group-hover:scale-110 transition-transform" />
                            )}
                            <span className="font-semibold text-[15px] hidden sm:block">
                                {selfStream ? 'Stop Stream' : streamStarting ? 'Starting...' : 'Share Screen'}
                            </span>
                        </button>
                    </Tooltip>

                    {!selfStream && (
                        <button
                            aria-label={showStreamMenu ? 'Hide stream quality menu' : 'Show stream quality menu'}
                            onClick={() => setShowStreamMenu(!showStreamMenu)}
                            className="flex items-center justify-center px-2 border-l border-border-strong hover:bg-white/10 transition-colors"
                        >
                            <ChevronUp size={18} className="text-text-muted" />
                        </button>
                    )}
                </div>

                {/* Stream Menu Popup */}
                {showStreamMenu && (
                    <div className="absolute bottom-full mb-3 right-0 w-64 rounded-2xl border border-border-strong bg-bg-primary p-3 shadow-2xl backdrop-blur-xl">
                        <div className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted px-2">
                            Stream Quality
                        </div>
                        <div className="flex flex-col gap-1">
                            {[
                                { value: '720p30', label: '720p 30fps' },
                                { value: '1080p60', label: '1080p 60fps' },
                                { value: '1440p60', label: '1440p 60fps' },
                                { value: '4k60', label: '4K 60fps' },
                                { value: 'movie-50', label: 'Movie 4K (50 Mbps)' },
                                { value: 'movie-100', label: 'Movie 4K (100 Mbps)' },
                            ].map((q) => (
                                <button
                                    key={q.value}
                                    onClick={() => {
                                        setCaptureQuality(q.value);
                                        setShowStreamMenu(false);
                                    }}
                                    className={cn(
                                        "flex items-center justify-between rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                                        captureQuality === q.value
                                            ? "bg-accent-primary text-white"
                                            : "text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary"
                                    )}
                                >
                                    {q.label}
                                    {captureQuality === q.value && <div className="h-2 w-2 rounded-full bg-white" />}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Stream Error Popup */}
                {streamIssueMessage && (
                    <div className="relative ml-2">
                        <button
                            onClick={() => setShowError(!showError)}
                            className="flex h-12 w-12 items-center justify-center rounded-full border border-amber-400/60 bg-amber-500/12 text-amber-300 transition-colors hover:bg-amber-500/24"
                        >
                            <AlertTriangle size={20} />
                        </button>
                        {showError && (
                            <div
                                className="absolute bottom-full right-0 mb-3 w-72 rounded-xl border px-3 py-2 text-xs font-medium leading-relaxed shadow-xl"
                                style={{
                                    borderColor: 'rgba(245, 158, 11, 0.45)',
                                    backgroundColor: 'rgba(17, 24, 39, 0.92)',
                                    color: 'var(--text-primary)',
                                }}
                            >
                                {streamIssueMessage}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="h-8 w-px bg-border-strong mx-1" />

            {onToggleChat && (
                <Tooltip content={isChatOpen ? 'Hide Chat' : 'Show Chat'} side="top">
                    <button
                        onClick={onToggleChat}
                        aria-label={isChatOpen ? 'Hide voice chat' : 'Show voice chat'}
                        className={cn(
                            'flex h-12 w-12 items-center justify-center rounded-full transition-all group',
                            isChatOpen
                                ? 'bg-bg-mod-subtle text-text-primary shadow-inner'
                                : 'bg-transparent text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                        )}
                    >
                        <MessageSquare size={20} className="group-hover:scale-110 transition-transform" />
                    </button>
                </Tooltip>
            )}

            <Tooltip content="Disconnect" side="top">
                <button
                    aria-label="Disconnect from voice"
                    onClick={() => void leaveChannel()}
                    className="flex h-12 items-center justify-center gap-2 rounded-full bg-accent-danger px-5 text-white shadow-lg transition-all hover:bg-accent-danger/90 group"
                >
                    <PhoneOff size={20} className="group-hover:scale-110 transition-transform" />
                    <span className="font-semibold text-[15px] hidden sm:block">Disconnect</span>
                </button>
            </Tooltip>
        </div>
        {showSourcePicker && !selfStream && (
            <ScreenSharePickerModal
                sources={screenSources}
                loading={sourcesLoading}
                error={streamError}
                loadThumbnail={loadThumbnail}
                onClose={() => {
                    if (!streamStarting) {
                        setShowSourcePicker(false);
                    }
                }}
                onRefresh={() => { void loadScreenSources(); }}
                onSelect={(source) => { void handleStartStream(source.id); }}
            />
        )}
        </>
    );
}
