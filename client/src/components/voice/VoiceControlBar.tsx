import { useState, useRef, useEffect, useCallback, type CSSProperties, type ReactNode } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, MonitorUp, PhoneOff, ChevronUp, AlertTriangle, MonitorOff, MessageSquare, Radio, Check, Video, VideoOff, Hand, AudioLines } from 'lucide-react';
import { useVoice } from '../../hooks/useVoice';
import { useStream } from '../../hooks/useStream';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { usePermissions } from '../../hooks/usePermissions';
import { hasPermission, Permissions } from '../../types';
import { cn } from '../../lib/utils';
import { useLingering, walkOutOfRoom } from '../../lib/motion';
import { IconButton } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { StageControlBar } from './stage';
import { ScreenSharePickerModal } from './ScreenSharePickerModal';
import { InCallDeviceMenu } from './InCallDeviceMenu';
import { SoundboardPopover } from './SoundboardPopover';
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
    extraControls,
}: {
    onToggleChat?: () => void;
    isChatOpen?: boolean;
    listenOnly?: boolean;
    requestToSpeakPending?: boolean;
    requestBusy?: boolean;
    onToggleRequestToSpeak?: () => void;
    /** Call-specific controls placed before the chat toggle (Watch together). */
    extraControls?: ReactNode;
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
        channelId,
        guildId,
    } = useVoice();
    const { selfStream, startStream, stopStream } = useStream();
    const streamAudioWarning = useVoiceStore((s) => s.streamAudioWarning);
    const mediaEngine = useVoiceStore((s) => s.mediaEngine);
    const pttEngaged = useVoiceStore((s) => s.pttEngaged);
    const rawNotifications = useAuthStore((s) => s.settings?.notifications as Record<string, unknown> | undefined);
    const isPttMode = (rawNotifications?.['voiceInputMode'] ?? 'voice_activity') === 'push_to_talk';

    // Mic on is white light (§7.2): the fill asserts that the room can hear you
    // right now, which is a state, not emphasis. Muted — or push-to-talk with
    // the key up — is the danger well.
    const micLive = !selfMute && !selfDeaf && (!isPttMode || pttEngaged);
    const micOff = isPttMode ? !pttEngaged : selfMute;

    const [streamStarting, setStreamStarting] = useState(false);
    const [streamError, setStreamError] = useState<string | null>(null);
    // Default to 720p30 for capture cost; all higher presets remain selectable.
    const [captureQuality, setCaptureQuality] = useState('720p30');
    const [showStreamMenu, setShowStreamMenu] = useState(false);
    const [showError, setShowError] = useState(false);
    const [showSourcePicker, setShowSourcePicker] = useState(false);
    const [screenSources, setScreenSources] = useState<ScreenShareSource[]>([]);
    const [sourcesLoading, setSourcesLoading] = useState(false);
    const [showSoundboard, setShowSoundboard] = useState(false);
    // The soundboard leaves the way it came (§5.2): kept for its exit beat.
    const soundboardLayer = useLingering(showSoundboard);

    const streamMenuRef = useRef<HTMLDivElement>(null);
    const qualityTriggerRef = useRef<HTMLButtonElement>(null);
    const qualityPanelRef = useRef<HTMLDivElement>(null);
    const warningTriggerRef = useRef<HTMLButtonElement>(null);
    const warningPanelRef = useRef<HTMLDivElement>(null);
    const soundboardTriggerRef = useRef<HTMLButtonElement>(null);
    const soundboardPanelRef = useRef<HTMLDivElement>(null);

    const streamIssueMessage = streamError || streamAudioWarning;

    // The soundboard button rides on the guild-level grant; the server applies
    // channel overwrites authoritatively on play.
    const guildScope = guildId && guildId !== 'dm' ? guildId : null;
    const { permissions: guildPermissions, isAdmin: isGuildAdmin } = usePermissions(guildScope);
    const canUseSoundboard =
        isGuildAdmin || hasPermission(guildPermissions, Permissions.USE_SOUNDBOARD);

    const closeStreamOverlays = useCallback(() => {
        setShowStreamMenu(false);
        setShowError(false);
        setShowSoundboard(false);
    }, []);

    const streamOverlayInside = useCallback(
        (target: Node) =>
            Boolean(
                streamMenuRef.current?.contains(target) ||
                    qualityPanelRef.current?.contains(target) ||
                    warningPanelRef.current?.contains(target) ||
                    soundboardTriggerRef.current?.contains(target) ||
                    soundboardPanelRef.current?.contains(target),
            ),
        [],
    );

    useOverlayDismiss(
        showStreamMenu || showError || showSoundboard,
        closeStreamOverlays,
        streamOverlayInside,
    );

    const soundboardCoords = useAnchoredOverlayCoords(
        showSoundboard,
        soundboardTriggerRef,
        'above-end',
        300,
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

    return (
        <>
        {/* The Stage lays the bar out in flow and centres it (§7.2); the
            controls are 46px (50 on a phone) on the 13px stage radius, mic-on
            is white light and leave is danger. */}
        {/* §5.1: the control bar is chrome — it rises 80ms behind the tile
            you walked into, never with it. */}
        <StageControlBar data-motion-chrome="">
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
                            'pc-focusable inline-flex h-[var(--h-stage-control)] items-center gap-2 rounded-[var(--radius-stage-control)] px-4 text-label',
                            'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                            'disabled:pointer-events-none disabled:opacity-60',
                            requestToSpeakPending
                                ? 'bg-light-white text-text-on-light shadow-[var(--glow-control-on)]'
                                : 'bg-bg-raised text-text-primary shadow-[var(--shadow-lifted)] hover:bg-bg-mod-strong',
                        )}
                    >
                        <Hand size={19} />
                        <span className="hidden whitespace-nowrap sm:block">
                            {requestBusy ? 'Updating…' : requestToSpeakPending ? 'Request sent' : 'Request to speak'}
                        </span>
                    </button>
                </Tooltip>
            ) : (
            <div className="flex items-stretch">
                <Tooltip
                    content={
                        isPttMode
                            ? pttEngaged ? 'Transmitting (PTT)' : 'Push to talk (muted)'
                            : selfMute ? 'Unmute' : 'Mute'
                    }
                    side="top"
                >
                    <IconButton
                        label={
                            isPttMode
                                ? pttEngaged ? 'Transmitting with push to talk' : 'Push to talk muted'
                                : selfMute ? 'Unmute microphone' : 'Mute microphone'
                        }
                        size="stage"
                        tone={micLive ? 'light' : micOff ? 'danger' : 'raised'}
                        onClick={() => { if (!isPttMode) toggleMute(); }}
                        className="relative rounded-r-none"
                        style={{ cursor: isPttMode ? 'default' : undefined }}
                    >
                        {isPttMode
                            ? pttEngaged
                                ? <Radio size={20} />
                                : <MicOff size={20} />
                            : selfMute
                                ? <MicOff size={20} />
                                : <Mic size={20} />
                        }
                        {micLive && (
                            /* Your own level, on your own control — the one place
                               the bar means something you can act on. */
                            <span className="absolute bottom-1.5 left-2.5 right-2.5 h-0.5 overflow-hidden rounded-full bg-text-on-light/25" aria-hidden>
                                {/* A composited slide, not a width: the level
                                    changes many times a second and a width would
                                    re-lay-out the control bar on every one. */}
                                <span
                                    className="pc-meter-fill is-live bg-text-on-light"
                                    style={{ '--pc-fill': Math.min(1, Math.max(0, micInputLevel)).toFixed(3) } as CSSProperties}
                                />
                            </span>
                        )}
                    </IconButton>
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
                <IconButton
                    label={selfDeaf ? 'Undeafen audio' : 'Deafen audio'}
                    size="stage"
                    tone={selfDeaf ? 'danger' : 'raised'}
                    onClick={() => toggleDeaf()}
                >
                    {selfDeaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
                </IconButton>
            </Tooltip>

            {guildScope && canUseSoundboard && (
                <Tooltip content="Soundboard" side="top">
                    <IconButton
                        ref={soundboardTriggerRef}
                        label={showSoundboard ? 'Close soundboard' : 'Open soundboard'}
                        size="stage"
                        tone="raised"
                        active={showSoundboard}
                        onClick={() => setShowSoundboard((v) => !v)}
                    >
                        <AudioLines size={20} />
                    </IconButton>
                </Tooltip>
            )}

            {!listenOnly && <Tooltip content={selfVideo ? 'Turn off camera' : 'Turn on camera'} side="top">
                <IconButton
                    label={selfVideo ? 'Turn off camera' : 'Turn on camera'}
                    size="stage"
                    tone={selfVideo ? 'light' : 'raised'}
                    onClick={() => { void toggleVideo(); }}
                >
                    {selfVideo ? <Video size={20} /> : <VideoOff size={20} />}
                </IconButton>
            </Tooltip>}

            {/* Screen-share split control — the picker menu lives behind the chevron. */}
            {!listenOnly && <div className="relative flex items-center" ref={streamMenuRef}>
                <div className="flex items-stretch">
                    <Tooltip content={selfStream ? 'Stop streaming' : 'Share screen'} side="top">
                        <IconButton
                            label={selfStream ? 'Stop streaming' : streamStarting ? 'Starting screen share' : 'Share screen'}
                            size="stage"
                            tone={selfStream ? 'light' : 'raised'}
                            disabled={streamStarting}
                            onClick={selfStream ? handleStopStream : () => {
                                if (mediaEngine?.supportsNativeSourcePicker()) {
                                    void openSourcePicker();
                                    return;
                                }
                                void handleStartStream();
                            }}
                            className={cn(!selfStream && 'rounded-r-none')}
                        >
                            {selfStream ? (
                                <MonitorOff size={20} />
                            ) : streamStarting ? (
                                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            ) : (
                                <MonitorUp size={20} />
                            )}
                        </IconButton>
                    </Tooltip>

                    {!selfStream && (
                        <button
                            ref={qualityTriggerRef}
                            type="button"
                            aria-label={showStreamMenu ? 'Hide share quality menu' : 'Choose share quality'}
                            onClick={() => setShowStreamMenu(!showStreamMenu)}
                            className="pc-focusable flex h-[var(--h-stage-control)] w-7 items-center justify-center rounded-r-[var(--radius-stage-control)] bg-bg-raised text-text-secondary shadow-[var(--shadow-lifted)] transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                        >
                            <ChevronUp size={18} className={cn('transition-transform', showStreamMenu && 'rotate-180')} />
                        </button>
                    )}
                </div>

                {/* Portaled: leave the control bar / stream compositing stack so
                    the menu paints above the underlay hole with solid fills. */}
                {showStreamMenu && (
                    <StreamOverlayPortal
                        panelRef={qualityPanelRef}
                        className="pc-floating w-[min(15rem,calc(100vw-1rem))] p-1.5"
                        style={{
                            bottom: qualityCoords?.bottom ?? 72,
                            left: qualityCoords?.left ?? 8,
                        }}
                    >
                        <div className="px-2 pb-1 pt-0.5 text-section text-text-faint">
                            Share quality
                        </div>
                        <p className="px-2 pb-2 text-meta leading-snug text-text-secondary">
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
                                    type="button"
                                    onClick={() => {
                                        setCaptureQuality(q.value);
                                        setShowStreamMenu(false);
                                    }}
                                    className={cn(
                                        'pc-focusable flex items-center justify-between rounded-[var(--radius-control)] px-2.5 py-1.5 text-label transition-colors',
                                        captureQuality === q.value
                                            ? 'bg-bg-mod-strong text-text-primary'
                                            : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
                                    )}
                                >
                                    {q.label}
                                    {captureQuality === q.value && <Check size={15} className="text-accent-primary" />}
                                </button>
                            ))}
                        </div>
                    </StreamOverlayPortal>
                )}

                {/* Stream warning affordance — warning semantic, not a light. */}
                {streamIssueMessage && (
                    <div className="relative ml-1.5">
                        <button
                            ref={warningTriggerRef}
                            type="button"
                            aria-label={showError ? 'Hide screen share warning' : 'Show screen share warning'}
                            aria-expanded={showError}
                            onClick={() => setShowError(!showError)}
                            className="pc-focusable inline-flex h-[var(--h-stage-control)] w-[var(--h-stage-control)] items-center justify-center rounded-[var(--radius-stage-control)] bg-warning-tint text-accent-warning shadow-[var(--shadow-lifted)]"
                        >
                            <AlertTriangle size={20} />
                        </button>
                        {showError && (
                            <StreamOverlayPortal
                                panelRef={warningPanelRef}
                                role="status"
                                className="pc-floating w-[min(18rem,calc(100vw-1rem))] px-3 py-2.5 text-meta leading-relaxed text-text-secondary"
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

            {extraControls}

            {onToggleChat && (
                <Tooltip content={isChatOpen ? 'Hide chat' : 'Show chat'} side="top">
                    <IconButton
                        label={isChatOpen ? 'Hide voice chat' : 'Show voice chat'}
                        size="stage"
                        tone="raised"
                        active={isChatOpen}
                        onClick={onToggleChat}
                    >
                        <MessageSquare size={20} />
                    </IconButton>
                </Tooltip>
            )}

            <Tooltip content="Disconnect" side="top">
                <IconButton
                    label="Disconnect from voice"
                    size="stage"
                    tone="danger"
                    // §5.1: leaving reverses the journey. There is no on-air
                    // pill to fold into when you are leaving the room
                    // altogether, so the tile dims out with the page rather
                    // than travelling to a destination that is not there.
                    onClick={() => {
                        if (!channelId) {
                            void leaveChannel();
                            return;
                        }
                        void walkOutOfRoom({ channelId, go: () => void leaveChannel() });
                    }}
                    className="w-[72px] sm:w-16"
                >
                    <PhoneOff size={20} />
                </IconButton>
            </Tooltip>
        </StageControlBar>
        {soundboardLayer.value && guildScope && channelId && (
            <SoundboardPopover
                guildId={guildScope}
                channelId={channelId}
                coords={soundboardCoords}
                panelRef={soundboardPanelRef}
                leaving={soundboardLayer.leaving}
            />
        )}
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
