import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, EyeOff, Headphones, HeadphoneOff, LayoutList, MicOff, Monitor, MonitorOff, PanelLeft, PhoneOff, PictureInPicture2, Users, Video } from 'lucide-react';
import { RoomEvent, Track } from 'livekit-client';
import { TopBar } from '../components/layout/TopBar';
import { MessageList } from '../components/message/MessageList';
import { MessageInput } from '../components/message/MessageInput';
import { ThreadPanel } from '../components/message/ThreadPanel';
import { ForumView } from '../components/channel/ForumView';
import { StreamViewer } from '../components/voice/StreamViewer';
import { VideoGrid } from '../components/voice/VideoGrid';
import { SplitPane } from '../components/voice/SplitPane';
import type { PaneSource } from '../components/voice/SplitPaneSourcePicker';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { useUIStore } from '../stores/uiStore';
import { useVoice } from '../hooks/useVoice';
import { useStream } from '../hooks/useStream';
import { useWebcamTiles } from '../hooks/useWebcamTiles';
import { useScreenShareSubscriptions } from '../hooks/useScreenShareSubscriptions';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { SearchPanel } from '../components/message/SearchPanel';
import { ConnectionStatusBar } from '../components/layout/ConnectionStatusBar';
import { GuildWelcomeScreen } from '../components/guild/GuildWelcomeScreen';
import { channelApi } from '../api/channels';
import type { Message } from '../types';

function getStreamErrorMessage(error: unknown): string {
  const err = error as { name?: string; message?: string };
  const name = err?.name || '';
  const rawMessage = err?.message || '';
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

  if (name) {
    return `Unable to start stream (${name}). ${rawMessage || 'Check browser permissions and try again.'}`;
  }
  return `Unable to start stream. ${rawMessage || 'Check browser permissions and try again.'}`;
}

type VideoLayout = 'top' | 'side' | 'pip' | 'hidden';

export function GuildPage() {
  const { guildId, channelId } = useParams();
  const navigate = useNavigate();
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const channels = useChannelStore((s) => s.channels);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const isLoading = useChannelStore((s) =>
    guildId ? (s.isLoading && !s.guildChannelsLoaded[guildId]) : false
  );
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const channel = channels.find(c => c.id === channelId);
  const {
    connected: voiceConnected,
    joining: voiceJoining,
    joiningChannelId,
    connectionError,
    connectionErrorChannelId,
    channelId: voiceChannelId,
    participants,
    joinChannel,
    leaveChannel,
    clearConnectionError,
  } = useVoice();
  const { selfStream, startStream, stopStream } = useStream();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const searchPanelOpen = useUIStore((s) => s.searchPanelOpen);
  const watchedStreamerId = useVoiceStore((s) => s.watchedStreamerId);
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const setWatchedStreamer = useVoiceStore((s) => s.setWatchedStreamer);
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamStarting, setStreamStarting] = useState(false);
  const [showStreamIssueDetails, setShowStreamIssueDetails] = useState(false);
  const [captureQuality, setCaptureQuality] = useState('1080p60');
  const [videoLayout, setVideoLayout] = useState<VideoLayout>('top');
  const [activeStreamers, setActiveStreamers] = useState<string[]>([]);
  const [isPhoneLayout, setIsPhoneLayout] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });
  const room = useVoiceStore((s) => s.room);
  const previewStreamerId = useVoiceStore((s) => s.previewStreamerId);
  const streamAudioWarning = useVoiceStore((s) => s.streamAudioWarning);

  // Welcome screen state
  const guilds = useGuildStore((s) => s.guilds);
  const currentGuild = guilds.find(g => g.id === guildId);
  const [showWelcome, setShowWelcome] = useState(() => {
    if (!guildId) return false;
    return !localStorage.getItem(`paracord:guild-welcomed:${guildId}`);
  });

  const dismissWelcome = () => {
    if (guildId) {
      localStorage.setItem(`paracord:guild-welcomed:${guildId}`, '1');
    }
    setShowWelcome(false);
  };

  // Split-pane state for Side mode
  const [splitState, setSplitState] = useState<{ left: PaneSource; right: PaneSource }>({
    left: { type: 'none' },
    right: { type: 'none' },
  });

  const webcamTiles = useWebcamTiles();

  const channelName = channel?.name || 'general';
  const isVoice = channel?.type === 2;
  const isForum = channel?.type === 7 || channel?.channel_type === 7;
  const isThread = channel?.type === 6 || channel?.channel_type === 6;
  const parentChannelId = isThread ? channel?.parent_id ?? null : null;
  const parentChannel = parentChannelId ? channels.find((c) => c.id === parentChannelId) : null;
  const showThreadSplit = Boolean(!isVoice && isThread && guildId && parentChannel);
  const inSelectedVoiceChannel = Boolean(isVoice && voiceConnected && voiceChannelId === channelId);
  const voiceJoinPending = Boolean(isVoice && voiceJoining && joiningChannelId === channelId);
  const voiceJoinError = connectionErrorChannelId === channelId ? connectionError : null;
  const participantCount = Array.from(participants.values()).filter((p) => p.channel_id === channelId).length;
  const activeStreamerSet = useMemo(() => new Set(activeStreamers), [activeStreamers]);
  const ownStreamIssueMessage = selfStream ? streamAudioWarning : null;
  const streamIssueMessage = streamError || ownStreamIssueMessage;
  const watchedStreamerName = useMemo(() => {
    if (!watchedStreamerId) return undefined;
    if (currentUserId != null && watchedStreamerId === currentUserId) return 'You';
    return participants.get(watchedStreamerId)?.username;
  }, [watchedStreamerId, currentUserId, participants]);

  // Fetch channels when guildId changes
  useEffect(() => {
    if (guildId) {
      selectGuild(guildId);
      useChannelStore.getState().selectGuild(guildId);
      if (!useChannelStore.getState().guildChannelsLoaded[guildId]) {
        fetchChannels(guildId);
      }
      if (!useMemberStore.getState().membersLoaded[guildId]) {
        void fetchMembers(guildId);
      }
    }
    // Only re-run when guildId changes, not when loaded-state objects change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  useEffect(() => {
    if (channelId) {
      selectChannel(channelId);
      setReplyingTo(null);
      setStreamError(null);
      setShowStreamIssueDetails(false);
      setWatchedStreamer(null);
    }
  }, [channelId, selectChannel, setWatchedStreamer]);

  useEffect(() => {
    if (!channelId) return;
    channelApi
      .get(channelId)
      .then(({ data }) => {
        useChannelStore.getState().updateChannel(data);
      })
      .catch(() => {
        /* keep existing channel cache on failure */
      });
  }, [channelId]);

  useEffect(() => {
    if (!streamIssueMessage) {
      setShowStreamIssueDetails(false);
    }
  }, [streamIssueMessage]);

  useEffect(() => {
    if (!room || !inSelectedVoiceChannel) {
      setActiveStreamers([]);
      return;
    }

    const recomputeActiveStreamers = () => {
      const next = new Set<string>();

      if (currentUserId) {
        for (const publication of room.localParticipant.videoTrackPublications.values()) {
          if (
            publication.source === Track.Source.ScreenShare &&
            publication.track &&
            publication.track.mediaStreamTrack?.readyState !== 'ended'
          ) {
            next.add(currentUserId);
            break;
          }
        }
      }

      for (const participant of room.remoteParticipants.values()) {
        let isStreaming = false;
        for (const publication of participant.videoTrackPublications.values()) {
          const hasUsableTrack =
            publication.track == null ||
            publication.track.mediaStreamTrack?.readyState !== 'ended';
          if (publication.source === Track.Source.ScreenShare && hasUsableTrack) {
            isStreaming = true;
            break;
          }
        }
        if (!isStreaming) continue;
        next.add(participant.identity);
      }

      setActiveStreamers((prev) => {
        if (prev.length === next.size && prev.every((id) => next.has(id))) {
          return prev;
        }
        return Array.from(next);
      });
    };

    recomputeActiveStreamers();

    room.on(RoomEvent.TrackSubscribed, recomputeActiveStreamers);
    room.on(RoomEvent.TrackUnsubscribed, recomputeActiveStreamers);
    room.on(RoomEvent.TrackPublished, recomputeActiveStreamers);
    room.on(RoomEvent.TrackUnpublished, recomputeActiveStreamers);
    room.on(RoomEvent.TrackMuted, recomputeActiveStreamers);
    room.on(RoomEvent.TrackUnmuted, recomputeActiveStreamers);
    room.on(RoomEvent.ParticipantConnected, recomputeActiveStreamers);
    room.on(RoomEvent.ParticipantDisconnected, recomputeActiveStreamers);
    room.on(RoomEvent.LocalTrackPublished, recomputeActiveStreamers);
    room.on(RoomEvent.LocalTrackUnpublished, recomputeActiveStreamers);

    const pollInterval = setInterval(recomputeActiveStreamers, 2000);

    return () => {
      clearInterval(pollInterval);
      room.off(RoomEvent.TrackSubscribed, recomputeActiveStreamers);
      room.off(RoomEvent.TrackUnsubscribed, recomputeActiveStreamers);
      room.off(RoomEvent.TrackPublished, recomputeActiveStreamers);
      room.off(RoomEvent.TrackUnpublished, recomputeActiveStreamers);
      room.off(RoomEvent.TrackMuted, recomputeActiveStreamers);
      room.off(RoomEvent.TrackUnmuted, recomputeActiveStreamers);
      room.off(RoomEvent.ParticipantConnected, recomputeActiveStreamers);
      room.off(RoomEvent.ParticipantDisconnected, recomputeActiveStreamers);
      room.off(RoomEvent.LocalTrackPublished, recomputeActiveStreamers);
      room.off(RoomEvent.LocalTrackUnpublished, recomputeActiveStreamers);
    };
  }, [room, inSelectedVoiceChannel, currentUserId]);

  useEffect(() => {
    if (!watchedStreamerId) return;
    const watchingSelf = currentUserId != null && watchedStreamerId === currentUserId;
    if (watchingSelf && selfStream) {
      return;
    }
    if (activeStreamerSet.has(watchedStreamerId)) {
      return;
    }

    // Track publication/unpublication can briefly flap during reconnects or
    // source switches. Delay auto-clear to avoid visible viewer flicker.
    const timeoutId = window.setTimeout(() => {
      if (!activeStreamerSet.has(watchedStreamerId)) {
        setWatchedStreamer(null);
      }
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [watchedStreamerId, activeStreamerSet, currentUserId, selfStream, setWatchedStreamer]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const updateIsPhoneLayout = () => setIsPhoneLayout(mediaQuery.matches);
    updateIsPhoneLayout();
    mediaQuery.addEventListener('change', updateIsPhoneLayout);
    return () => mediaQuery.removeEventListener('change', updateIsPhoneLayout);
  }, []);

  useEffect(() => {
    if (isPhoneLayout && videoLayout === 'side') {
      setVideoLayout('top');
    }
  }, [isPhoneLayout, videoLayout]);

  // Track previous videoLayout to detect entering/leaving Side mode
  const prevLayoutRef = useRef<VideoLayout>(videoLayout);

  // On entering Side mode: initialize left from watchedStreamerId
  useEffect(() => {
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = videoLayout;

    if (videoLayout === 'side' && prev !== 'side') {
      setSplitState({
        left: watchedStreamerId
          ? { type: 'stream', userId: watchedStreamerId }
          : { type: 'none' },
        right: { type: 'none' },
      });
    }
    // On leaving Side mode: map left pane stream → watchedStreamerId
    if (videoLayout !== 'side' && prev === 'side') {
      setSplitState((s) => {
        if (s.left.type === 'stream') {
          setWatchedStreamer(s.left.userId);
        }
        return s;
      });
    }
  }, [videoLayout, watchedStreamerId, setWatchedStreamer]);

  // watchedStreamerId changes while in Side mode → update left pane
  useEffect(() => {
    if (videoLayout !== 'side') return;
    if (watchedStreamerId) {
      setSplitState((prev) => {
        if (prev.left.type === 'stream' && prev.left.userId === watchedStreamerId) return prev;
        return { ...prev, left: { type: 'stream', userId: watchedStreamerId } };
      });
    }
  }, [watchedStreamerId, videoLayout]);

  // Clean up pane sources when streams/webcams become unavailable (1.2s debounce)
  useEffect(() => {
    if (videoLayout !== 'side') return;

    const timeoutId = window.setTimeout(() => {
      setSplitState((prev) => {
        let { left, right } = prev;
        let changed = false;

        const webcamIds = new Set(webcamTiles.map((t) => t.participantId));

        if (left.type === 'stream' && !activeStreamerSet.has(left.userId)) {
          const isSelf = currentUserId != null && left.userId === currentUserId;
          if (!(isSelf && selfStream)) {
            left = { type: 'none' };
            changed = true;
          }
        }
        if (left.type === 'webcam' && !webcamIds.has(left.userId)) {
          left = { type: 'none' };
          changed = true;
        }
        if (right.type === 'stream' && !activeStreamerSet.has(right.userId)) {
          const isSelf = currentUserId != null && right.userId === currentUserId;
          if (!(isSelf && selfStream)) {
            right = { type: 'none' };
            changed = true;
          }
        }
        if (right.type === 'webcam' && !webcamIds.has(right.userId)) {
          right = { type: 'none' };
          changed = true;
        }

        return changed ? { left, right } : prev;
      });
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [videoLayout, activeStreamerSet, webcamTiles, currentUserId, selfStream]);

  // Centralized screen share subscriptions in Side mode
  const splitSubscribedIds = useMemo(() => {
    if (videoLayout !== 'side') return null;
    const ids = new Set<string>();
    if (splitState.left.type === 'stream' && splitState.left.userId !== currentUserId) {
      ids.add(splitState.left.userId);
    }
    if (splitState.right.type === 'stream' && splitState.right.userId !== currentUserId) {
      ids.add(splitState.right.userId);
    }
    if (previewStreamerId && previewStreamerId !== currentUserId) {
      ids.add(previewStreamerId);
    }
    return ids;
  }, [videoLayout, splitState, currentUserId, previewStreamerId]);

  useScreenShareSubscriptions(splitSubscribedIds);

  // Listen for custom event to re-show welcome screen from sidebar menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.guildId === guildId) {
        setShowWelcome(true);
      }
    };
    window.addEventListener('paracord:show-welcome', handler);
    return () => window.removeEventListener('paracord:show-welcome', handler);
  }, [guildId]);

  // Participant name map for source picker display
  const participantNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, p] of participants) {
      if (p.username) map.set(id, p.username);
    }
    return map;
  }, [participants]);

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <TopBar channelName="Loading..." />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <div className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-3"
              style={{ borderColor: 'var(--text-muted)', borderTopColor: 'var(--accent-primary)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading channels...</p>
          </div>
        </div>
      </div>
    );
  }

  const streamViewerElement = watchedStreamerId ? (
    <StreamViewer
      streamerId={watchedStreamerId}
      streamerName={watchedStreamerName}
      issueMessage={
        currentUserId != null && watchedStreamerId === currentUserId
          ? ownStreamIssueMessage
          : null
      }
      expectingStream={Boolean(
        currentUserId != null &&
        watchedStreamerId === currentUserId &&
        selfStream &&
        !activeStreamerSet.has(watchedStreamerId)
      )}
      onStopWatching={() => setWatchedStreamer(null)}
      onStopStream={() => {
        stopStream();
        setStreamError(null);
        setShowStreamIssueDetails(false);
      }}
    />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        channelName={channelName}
        channelTopic={channel?.topic}
        isVoice={isVoice}
        isForum={isForum}
      />
      <ConnectionStatusBar />
      {showWelcome && currentGuild && (
        <GuildWelcomeScreen
          guild={currentGuild}
          channels={channels}
          onDismiss={dismissWelcome}
        />
      )}
      {isVoice ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5 text-text-muted sm:gap-3 sm:p-4 md:gap-4 md:p-5">
          <div className="glass-panel rounded-2xl border p-3 sm:p-4 md:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-text-secondary">
                  <Users size={19} />
                </div>
                <div>
                  <div className="text-base font-semibold leading-tight text-text-primary">{channelName}</div>
                  <div className="text-xs leading-tight text-text-secondary">Participants: {participantCount}</div>
                </div>
              </div>
              {inSelectedVoiceChannel ? (
                <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-2.5">
                  <button
                    className="control-pill-btn w-full justify-center sm:w-auto"
                    onClick={() => void leaveChannel()}
                  >
                    <PhoneOff size={16} />
                    Leave Voice
                  </button>
                  {!selfStream ? (
                    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                      <select
                        value={captureQuality}
                        onChange={(e) => setCaptureQuality(e.target.value)}
                        className="h-10 w-full rounded-xl border border-border-subtle bg-bg-mod-subtle px-3.5 text-xs font-medium text-text-secondary outline-none transition-colors hover:bg-bg-mod-strong sm:w-auto sm:text-sm"
                        title="Capture quality"
                        disabled={streamStarting}
                      >
                        <option value="720p30">720p 30fps</option>
                        <option value="1080p60">1080p 60fps</option>
                        <option value="1440p60">1440p 60fps</option>
                        <option value="4k60">4K 60fps</option>
                        <option value="movie-50">Movie 4K (50 Mbps)</option>
                        <option value="movie-100">Movie 4K (100 Mbps)</option>
                      </select>
                      <button
                        className="control-pill-btn w-full justify-center border-accent-primary/50 bg-accent-primary/15 hover:bg-accent-primary/25 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                        disabled={streamStarting}
                        onClick={async () => {
                          setStreamError(null);
                          setShowStreamIssueDetails(false);
                          setStreamStarting(true);
                          try {
                            await startStream(captureQuality);
                          } catch (error) {
                            setStreamError(getStreamErrorMessage(error));
                          } finally {
                            setStreamStarting(false);
                          }
                        }}
                      >
                        <Monitor size={16} />
                        {streamStarting ? 'Starting...' : 'Start Stream'}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="control-pill-btn w-full justify-center border-accent-primary/50 bg-accent-primary/20 hover:bg-accent-primary/30 sm:w-auto"
                      onClick={() => {
                        stopStream();
                        setStreamError(null);
                        setShowStreamIssueDetails(false);
                      }}
                    >
                      <MonitorOff size={16} />
                      Stop Stream
                    </button>
                  )}
                  {streamIssueMessage && (
                    <div className="relative self-end sm:self-auto">
                      <button
                        onClick={() => setShowStreamIssueDetails((prev) => !prev)}
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-400/60 bg-amber-500/12 text-amber-300 transition-colors hover:bg-amber-500/24"
                        title="Show stream issue details"
                        aria-label="Show stream issue details"
                      >
                        <AlertTriangle size={16} />
                      </button>
                      {showStreamIssueDetails && (
                        <div
                          className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border px-3 py-2 text-xs font-medium leading-relaxed shadow-xl"
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
              ) : (
                <div className="flex w-full flex-col gap-3">
                  {/* Join / error / pending controls */}
                  <div className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
                    {voiceJoinError ? (
                      <>
                        <div className="w-full rounded-xl border border-accent-danger/40 bg-accent-danger/10 px-3.5 py-2.5 text-sm font-medium text-accent-danger sm:w-auto">
                          Voice join failed: {voiceJoinError}
                        </div>
                        {channelId && guildId && (
                          <button
                            className="control-pill-btn w-full justify-center sm:w-auto"
                            onClick={() => {
                              clearConnectionError();
                              void joinChannel(channelId, guildId);
                            }}
                          >
                            Retry Join
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        className="control-pill-btn w-full justify-center border-accent-primary/50 bg-accent-primary/15 text-text-primary hover:bg-accent-primary/25 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                        disabled={voiceJoinPending || !channelId || !guildId}
                        onClick={() => {
                          if (channelId && guildId) {
                            void joinChannel(channelId, guildId);
                          }
                        }}
                      >
                        {voiceJoinPending ? (
                          <>
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            Connecting...
                          </>
                        ) : (
                          <>
                            <Headphones size={16} />
                            Join Voice
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Lobby: show who's already in the channel */}
                  {(() => {
                    const lobbyParticipants = channelId ? (channelParticipants.get(channelId) || []) : [];
                    if (lobbyParticipants.length === 0) return null;
                    return (
                      <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
                          In Channel — {lobbyParticipants.length}
                        </div>
                        <div className="flex flex-col gap-1.5">
                          {lobbyParticipants.map((p) => (
                            <div key={p.user_id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong text-xs font-semibold text-text-secondary">
                                {(p.username || '?')[0].toUpperCase()}
                              </div>
                              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                                {p.username || p.user_id}
                              </span>
                              <div className="flex items-center gap-1.5 text-text-muted">
                                {p.self_mute && <span title="Muted"><MicOff size={13} className="text-accent-danger" /></span>}
                                {p.self_deaf && <span title="Deafened"><HeadphoneOff size={13} className="text-accent-danger" /></span>}
                                {p.self_video && <span title="Camera on"><Video size={13} className="text-accent-primary" /></span>}
                                {p.self_stream && <span title="Streaming"><Monitor size={13} className="text-accent-primary" /></span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
          {inSelectedVoiceChannel && (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 sm:gap-2">
              {(watchedStreamerId || videoLayout === 'side') && (
                <div className="flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5">
                  <span className="text-xs font-medium text-text-muted">View:</span>
                  {([
                    { mode: 'top' as const, icon: LayoutList, label: 'Top' },
                    { mode: 'side' as const, icon: PanelLeft, label: 'Side' },
                    { mode: 'pip' as const, icon: PictureInPicture2, label: 'PiP' },
                    { mode: 'hidden' as const, icon: EyeOff, label: 'Hide' },
                  ]).map(({ mode, icon: Icon, label }) => (
                    <button
                      key={mode}
                      title={label}
                      onClick={() => setVideoLayout(mode)}
                      className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
                        videoLayout === mode
                          ? 'border-accent-primary/50 bg-bg-mod-strong text-text-primary'
                          : 'border-transparent text-text-muted hover:bg-bg-mod-subtle'
                      }`}
                    >
                      <Icon size={14} />
                      {!isPhoneLayout && label}
                    </button>
                  ))}
                </div>
              )}
              {videoLayout === 'side' ? (
                <div className="flex min-h-0 flex-1 gap-2">
                  <SplitPane
                    source={splitState.left}
                    onSourceChange={(src) => setSplitState((prev) => ({ ...prev, left: src }))}
                    otherPaneSource={splitState.right}
                    activeStreamers={activeStreamers}
                    webcamTiles={webcamTiles}
                    participantNames={participantNames}
                    currentUserId={currentUserId}
                    selfStream={selfStream}
                    streamIssueMessage={ownStreamIssueMessage}
                    activeStreamerSet={activeStreamerSet}
                    onStopStream={() => {
                      stopStream();
                      setStreamError(null);
                      setShowStreamIssueDetails(false);
                    }}
                  />
                  <SplitPane
                    source={splitState.right}
                    onSourceChange={(src) => setSplitState((prev) => ({ ...prev, right: src }))}
                    otherPaneSource={splitState.left}
                    activeStreamers={activeStreamers}
                    webcamTiles={webcamTiles}
                    participantNames={participantNames}
                    currentUserId={currentUserId}
                    selfStream={selfStream}
                    streamIssueMessage={ownStreamIssueMessage}
                    activeStreamerSet={activeStreamerSet}
                    onStopStream={() => {
                      stopStream();
                      setStreamError(null);
                      setShowStreamIssueDetails(false);
                    }}
                  />
                </div>
              ) : watchedStreamerId ? (
                videoLayout === 'pip' ? (
                  <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border-subtle">
                    {streamViewerElement}
                    <div className="absolute bottom-3 right-3 z-10">
                      <VideoGrid layout="pip" />
                    </div>
                  </div>
                ) : videoLayout === 'hidden' ? (
                  <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border-subtle">
                    {streamViewerElement}
                  </div>
                ) : (
                  <>
                    <VideoGrid layout="compact" />
                    <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border-subtle">
                      {streamViewerElement}
                    </div>
                  </>
                )
              ) : (
                <>
                  <VideoGrid layout="grid" />
                  <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border-subtle">
                    <div className="relative flex h-full min-h-[240px] items-center justify-center overflow-hidden bg-bg-mod-subtle/30 sm:min-h-[300px]">
                      <div className="pointer-events-none absolute -top-12 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full blur-3xl" style={{ backgroundColor: 'var(--ambient-glow-primary)' }} />
                      <div className="relative mx-3 flex w-full max-w-md flex-col items-center rounded-2xl border border-border-subtle bg-bg-mod-subtle/70 px-4 py-5 text-center sm:mx-4 sm:px-7 sm:py-7">
                        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-bg-primary/70 text-text-secondary">
                          <Monitor size={20} />
                        </div>
                        <div className="text-base font-semibold text-text-primary">Choose a stream from the sidebar</div>
                        <div className="mt-1 text-sm text-text-secondary">
                          Use the red <span className="font-semibold text-accent-danger">LIVE</span> buttons beside voice participants to switch streams.
                        </div>
                        <div className="mt-4 text-xs text-text-muted">
                          {activeStreamers.length > 0
                            ? `${activeStreamers.length} stream${activeStreamers.length === 1 ? '' : 's'} currently live`
                            : 'No active streams right now'}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : isForum ? (
        <ForumView channelId={channelId!} channelName={channelName} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {showThreadSplit ? (
            isPhoneLayout ? (
              <ThreadPanel
                guildId={guildId!}
                threadChannelId={channelId!}
                threadName={channelName}
                parentChannelName={parentChannel?.name || 'unknown'}
                className="w-full border-l-0"
                onClose={() => {
                  useChannelStore.getState().selectChannel(parentChannel!.id);
                  navigate(`/app/guilds/${guildId}/channels/${parentChannel!.id}`);
                }}
              />
            ) : (
              <>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="panel-divider flex shrink-0 items-center gap-2 border-b border-border-subtle/70 px-4 py-2.5 text-xs text-text-muted">
                    Parent Channel
                    <span className="font-semibold text-text-secondary">#{parentChannel?.name || 'unknown'}</span>
                  </div>
                  <MessageList channelId={parentChannel!.id} />
                </div>
                <ThreadPanel
                  guildId={guildId!}
                  threadChannelId={channelId!}
                  threadName={channelName}
                  parentChannelName={parentChannel?.name || 'unknown'}
                  className="w-[min(460px,42vw)] max-w-[40rem]"
                  onClose={() => {
                    useChannelStore.getState().selectChannel(parentChannel!.id);
                    navigate(`/app/guilds/${guildId}/channels/${parentChannel!.id}`);
                  }}
                />
              </>
            )
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              <MessageList
                channelId={channelId!}
                onReply={(msg: Message) =>
                  setReplyingTo({
                    id: msg.id,
                    author: msg.author.username,
                    content: msg.content || '',
                  })
                }
              />
              <MessageInput
                channelId={channelId!}
                guildId={guildId}
                channelName={channelName}
                replyingTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
              />
            </div>
          )}
          {searchPanelOpen && !showThreadSplit && <SearchPanel />}
        </div>
      )}
    </div>
  );
}
