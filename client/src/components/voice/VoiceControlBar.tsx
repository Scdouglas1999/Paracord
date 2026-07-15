import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, MonitorUp, PhoneOff, ChevronUp, AlertTriangle, MonitorOff, MessageSquare, Radio, Check, Video, VideoOff, Hand } from 'lucide-react';
import { useVoice } from '../../hooks/useVoice';
import { useStream } from '../../hooks/useStream';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { cn } from '../../lib/utils';
import { Tooltip } from '../ui/Tooltip';
import { ScreenSharePickerModal } from './ScreenSharePickerModal';
import { InCallDeviceMenu } from './InCallDeviceMenu';
import {
  StreamOverlayPortal,
  useAnchoredOverlayCoords,
  useOverlayDismiss,
} from './streamOverlayPortal';
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
    isChatOpen,
    listenOnly = false,
    requestToSpeakPending = false,
    requestBusy = false,
    onToggleRequestToSpeak,
}: {
    onToggleChat?: () => void;
    isChatOpen?: boolean;
    listenOnly?: boolean;
    requestToSpeakPending?: boolean;
    requestBusy?: boolean;
    onToggleRequestToSpeak?: () => void;
}) {
    const {
        selfMute,
        selfDeaf,
        selfVideo,
        micInputActive,
        micInputLevel,
        micUplinkState,
        toggleMute,
        toggleDeaf,
        toggleVideo,
        leaveChannel,
    } = useVoice();
    const { selfStream, startStream, stopStream } = useStream();
    const streamAudioWarning = useVoiceStore((s) => s.streamAudioWarning);
    const mediaEngine = useVoiceStore((s) => s.mediaEngine);
    const pttEngaged = useVoiceStore((s) => s.pttEngaged);
    const rawNotifications = useAuthStore((s) => s.settings?.notifications as Record<string, unknown> | undefined);
    const isPttMode = (rawNotifications?.['voiceInputMode'] ?? 'voice_activity') === 'push_to_talk';

    const [streamStarting, setStreamStarting] = useState(false);
    const [streamError, setStreamError] = useState<string | null>(null);
    // Default to 720p30 for capture cost; all higher presets remain selectable.
    const [captureQuality, setCaptureQuality] = useState('720p30');
    const [showStreamMenu, setShowStreamMenu] = useState(false);
    const [showError, setShowError] = useState(false);
    const [showSourcePicker, setShowSourcePicker] = useState(false);
    const [screenSources, setScreenSources] = useState<ScreenShareSource[]>([]);
    const [sourcesLoading, setSourcesLoading] = useState(false);

    const streamMenuRef = useRef<HTMLDivElement>(null);
    const qualityTriggerRef = useRef<HTMLButtonElement>(null);
    const qualityPanelRef = useRef<HTMLDivElement>(null);
    const warningTriggerRef = useRef<HTMLButtonElement>(null);
    const warningPanelRef = useRef<HTMLDivElement>(null);

    const streamIssueMessage = streamError || streamAudioWarning;

    const closeStreamOverlays = useCallback(() => {
        setShowStreamMenu(false);
        setShowError(false);
    }, []);

    const streamOverlayInside = useCallback(
        (target: Node) =>
            Boolean(
                streamMenuRef.current?.contains(target) ||
                    qualityPanelRef.current?.contains(target) ||
                    warningPanelRef.current?.contains(target),
            ),
        [],
    );

    useOverlayDismiss(
        showStreamMenu || showError,
        closeStreamOverlays,
        streamOverlayInside,
    );

    const qualityCoords = useAnchoredOverlayCoords(
        showStreamMenu,
        qualityTriggerRef,
        'above-end',
        240,
    );
    const warningCoords = useAnchoredOverlayCoords(
        showError,
        warningTriggerRef,
        'above-end',
        288,
    );

    useEffect(() => {
        if (!listenOnly) return;
        setShowStreamMenu(false);
        setShowError(false);
        setShowSourcePicker(false);
    }, [listenOnly]);

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

    // Shared control-button base: 44px touch target, radius-sm, layered focus ring,
    // tactile press (design-spec §7 Icon button + §4 focus + §5 motion).
    const ctrlBase =
        'flex h-11 w-11 items-center justify-center rounded-sm outline-none transition-[background-color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]';

    return (
        <>
        {/* z-[70]: stay above maximized StreamViewer (z-50) and mobile voice chat (z-50). */}
        <div className="absolute bottom-6 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border-subtle bg-bg-secondary px-2 py-2 shadow-md">
            {listenOnly ? (
                <Tooltip
                    content={requestToSpeakPending ? 'Cancel request to speak' : 'Ask the stage moderators to invite you'}
                    side="top"
                >
                    <button
                        type="button"
                        aria-label={requestToSpeakPending ? 'Cancel request to speak' : 'Request to speak'}
                        aria-pressed={requestToSpeakPending}
                        disabled={requestBusy || !onToggleRequestToSpeak}
                        onClick={onToggleRequestToSpeak}
                        className={cn(
                            'flex h-11 items-center gap-2 rounded-sm px-3.5 text-label outline-none transition-[background-color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-60',
                            requestToSpeakPending
                                ? 'bg-accent-tint text-accent-primary'
                                : 'bg-bg-mod-subtle text-interactive-normal hover:bg-bg-mod-strong hover:text-interactive-hover',
                        )}
                    >
                        <Hand size={19} />
                        <span className="hidden whitespace-nowrap sm:block">
                            {requestBusy ? 'Updating…' : requestToSpeakPending ? 'Request sent' : 'Request to speak'}
                        </span>
                    </button>
                </Tooltip>
            ) : (
            <div className="flex items-stretch rounded-sm bg-bg-mod-subtle">
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
                            ctrlBase,
                            'relative rounded-r-none',
                            isPttMode
                                ? pttEngaged
                                    // Transmitting = emerald active-on ring (design-spec speaking cue).
                                    ? 'bg-accent-tint text-accent-primary ring-2 ring-accent-primary'
                                    : 'bg-danger-tint text-accent-danger'
                                : selfMute
                                    ? 'bg-danger-tint text-accent-danger'
                                    : 'text-interactive-normal hover:bg-bg-mod-strong hover:text-interactive-hover'
                        )}
                        style={{ cursor: isPttMode ? 'default' : undefined }}
                    >
                        {isPttMode
                            ? pttEngaged
                                ? <Radio size={20} className="animate-pulse" />
                                : <MicOff size={20} />
                            : selfMute
                                ? <MicOff size={20} />
                                : <Mic size={20} />
                        }
                        {!selfMute && !selfDeaf && (!isPttMode || pttEngaged) && (
                            <span className="absolute bottom-1 left-2 right-2 h-0.5 overflow-hidden rounded-full bg-bg-mod-strong" aria-hidden>
                                <span
                                    className="block h-full rounded-full bg-accent-primary transition-[width] duration-100"
                                    style={{ width: `${Math.round(Math.min(1, Math.max(0, micInputLevel)) * 100)}%` }}
                                />
                            </span>
                        )}
                    </button>
                </Tooltip>
                <InCallDeviceMenu
                    micLevel={micInputLevel}
                    micMuted={selfMute || selfDeaf}
                    micInputActive={micInputActive}
                    micUplinkState={micUplinkState}
                    isPttMode={isPttMode}
                    pttEngaged={pttEngaged}
                />
            </div>
            )}

            <Tooltip content={selfDeaf ? 'Undeafen' : 'Deafen'} side="top">
                <button
                    aria-label={selfDeaf ? 'Undeafen audio' : 'Deafen audio'}
                    onClick={() => toggleDeaf()}
                    className={cn(
                        ctrlBase,
                        selfDeaf
                            ? 'bg-danger-tint text-accent-danger'
                            : 'text-interactive-normal hover:bg-bg-mod-subtle hover:text-interactive-hover'
                    )}
                >
                    {selfDeaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
                </button>
            </Tooltip>

            {!listenOnly && <Tooltip content={selfVideo ? 'Turn Off Camera' : 'Turn On Camera'} side="top">
                <button
                    aria-label={selfVideo ? 'Turn off camera' : 'Turn on camera'}
                    onClick={() => { void toggleVideo(); }}
                    className={cn(
                        ctrlBase,
                        selfVideo
                            ? 'bg-accent-tint text-accent-primary'
                            : 'text-interactive-normal hover:bg-bg-mod-subtle hover:text-interactive-hover'
                    )}
                >
                    {selfVideo ? <Video size={20} /> : <VideoOff size={20} />}
                </button>
            </Tooltip>}

            {!listenOnly && <div className="mx-1 h-6 w-px bg-border-subtle" />}

            {/* Screen-share split button — opens the device-picker menu (design-spec §7). */}
            {!listenOnly && <div className="relative flex items-center" ref={streamMenuRef}>
                <div
                    className={cn(
                        'flex items-stretch overflow-hidden rounded-sm',
                        selfStream ? 'bg-accent-tint' : 'bg-bg-mod-subtle'
                    )}
                >
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
                                'flex h-11 items-center gap-2 px-3.5 outline-none transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] disabled:opacity-70',
                                selfStream
                                    // Active-on = emerald tint + emerald icon, never a fill wash.
                                    ? 'text-accent-primary hover:bg-accent-tint-strong'
                                    : 'text-interactive-normal hover:bg-bg-mod-strong hover:text-interactive-hover'
                            )}
                        >
                            {selfStream ? (
                                <MonitorOff size={20} />
                            ) : streamStarting ? (
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            ) : (
                                <MonitorUp size={20} />
                            )}
                            <span className="hidden whitespace-nowrap text-label sm:block">
                                {selfStream ? 'Stop Stream' : streamStarting ? 'Starting…' : 'Share Screen'}
                            </span>
                        </button>
                    </Tooltip>

                    {!selfStream && (
                        <button
                            ref={qualityTriggerRef}
                            aria-label={showStreamMenu ? 'Hide share quality menu' : 'Choose share quality'}
                            onClick={() => setShowStreamMenu(!showStreamMenu)}
                            className="flex items-center justify-center border-l border-border-subtle px-2 text-interactive-normal outline-none transition-colors hover:bg-bg-mod-strong hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
                        >
                            <ChevronUp size={18} />
                        </button>
                    )}
                </div>

                {/* Portaled: leave the control bar / stream compositing stack so
                    the menu paints above the underlay hole with solid fills. */}
                {showStreamMenu && (
                    <StreamOverlayPortal
                        panelRef={qualityPanelRef}
                        className="w-[min(15rem,calc(100vw-1rem))] rounded-md border border-border-subtle bg-bg-secondary p-1 shadow-lg"
                        style={{
                            bottom: qualityCoords?.bottom ?? 72,
                            left: qualityCoords?.left ?? 8,
                        }}
                    >
                        <div className="px-2.5 pb-1.5 pt-1 text-section uppercase text-text-muted">
                            Share quality
                        </div>
                        <p className="px-2.5 pb-2 text-meta leading-snug text-text-secondary">
                            Sets the quality you send. Viewers can adapt playback for their connection.
                        </p>
                        <div className="flex flex-col gap-0.5">
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
                                        'flex items-center justify-between rounded-sm px-2.5 py-1.5 text-label outline-none transition-colors focus-visible:shadow-[var(--focus-ring)]',
                                        captureQuality === q.value
                                            ? 'bg-accent-tint text-accent-primary'
                                            : 'text-text-secondary hover:bg-accent-tint hover:text-text-primary'
                                    )}
                                >
                                    {q.label}
                                    {captureQuality === q.value && <Check size={15} className="text-accent-primary" />}
                                </button>
                            ))}
                        </div>
                    </StreamOverlayPortal>
                )}

                {/* Stream warning affordance — warning semantic, not the emerald accent. */}
                {streamIssueMessage && (
                    <div className="relative ml-1.5">
                        <button
                            ref={warningTriggerRef}
                            aria-label={showError ? 'Hide screen share warning' : 'Show screen share warning'}
                            aria-expanded={showError}
                            onClick={() => setShowError(!showError)}
                            className={cn(ctrlBase, 'bg-warning-tint text-accent-warning')}
                        >
                            <AlertTriangle size={20} />
                        </button>
                        {showError && (
                            <StreamOverlayPortal
                                panelRef={warningPanelRef}
                                role="status"
                                className="w-[min(18rem,calc(100vw-1rem))] rounded-md border border-border-subtle bg-bg-secondary px-3 py-2.5 text-meta leading-relaxed text-text-secondary shadow-lg"
                                style={{
                                    bottom: warningCoords?.bottom ?? 72,
                                    left: warningCoords?.left ?? 8,
                                }}
                            >
                                <span className="font-semibold text-accent-warning">Screen share issue</span>
                                <p className="mt-0.5 text-text-secondary">{streamIssueMessage}</p>
                            </StreamOverlayPortal>
                        )}
                    </div>
                )}
            </div>}

            <div className="mx-1 h-6 w-px bg-border-subtle" />

            {onToggleChat && (
                <Tooltip content={isChatOpen ? 'Hide Chat' : 'Show Chat'} side="top">
                    <button
                        onClick={onToggleChat}
                        aria-label={isChatOpen ? 'Hide voice chat' : 'Show voice chat'}
                        className={cn(
                            ctrlBase,
                            isChatOpen
                                ? 'bg-accent-tint text-accent-primary'
                                : 'text-interactive-normal hover:bg-bg-mod-subtle hover:text-interactive-hover'
                        )}
                    >
                        <MessageSquare size={20} />
                    </button>
                </Tooltip>
            )}

            <Tooltip content="Disconnect" side="top">
                <button
                    aria-label="Disconnect from voice"
                    onClick={() => void leaveChannel()}
                    className="flex h-11 items-center gap-2 rounded-sm bg-accent-danger-fill px-4 text-text-on-danger shadow-sm outline-none transition-[background-color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-[color-mix(in_srgb,var(--accent-danger-fill)_90%,#000)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]"
                >
                    <PhoneOff size={20} />
                    <span className="hidden whitespace-nowrap text-label sm:block">Disconnect</span>
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
