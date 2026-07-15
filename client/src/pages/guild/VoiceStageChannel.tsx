import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, EyeOff, Hand, LayoutList, Mic, Monitor, PanelLeft, PictureInPicture2, X } from 'lucide-react';
import { RoomEvent, Track } from 'livekit-client';
import { StreamViewer } from '../../components/voice/StreamViewer';
import { VideoGrid } from '../../components/voice/VideoGrid';
import { SplitPane } from '../../components/voice/SplitPane';
import { VoiceControlBar } from '../../components/voice/VoiceControlBar';
import type { PaneSource } from '../../components/voice/SplitPaneSourcePicker';
import { useVoice } from '../../hooks/useVoice';
import { useStream } from '../../hooks/useStream';
import { useWebcamTiles } from '../../hooks/useWebcamTiles';
import { useScreenShareSubscriptions } from '../../hooks/useScreenShareSubscriptions';
import { useMobile } from '../../hooks/useMobile';
import { useVoiceStore } from '../../stores/voiceStore';
import { stageApi, type StageInstance } from '../../api/stage';
import { extractApiError } from '../../api/client';
import { VoiceLobby } from './VoiceLobby';
import { VoiceChatSidebar } from './VoiceChatSidebar';
import { Button } from '../../components/ui/Button';
import { displayName } from '../../lib/displayName';

type VideoLayout = 'top' | 'side' | 'pip' | 'hidden';

interface VoiceStageChannelProps {
  guildId: string | undefined;
  channelId: string | undefined;
  channelName: string;
  isStage: boolean;
  canManageStage: boolean;
  currentUserId: string | null;
  isPhoneLayout: boolean;
}

export function VoiceStageChannel({
  guildId,
  channelId,
  channelName,
  isStage,
  canManageStage,
  currentUserId,
  isPhoneLayout,
}: VoiceStageChannelProps) {
  const {
    connected: voiceConnected,
    joining: voiceJoining,
    joiningChannelId,
    connectionError,
    connectionErrorChannelId,
    channelId: voiceChannelId,
    participants,
    selfMute,
    selfVideo,
    joinChannel,
    clearConnectionError,
    toggleMute,
    toggleVideo,
  } = useVoice();
  const { selfStream, stopStream } = useStream();
  const watchedStreamerId = useVoiceStore((s) => s.watchedStreamerId);
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const setWatchedStreamer = useVoiceStore((s) => s.setWatchedStreamer);
  const room = useVoiceStore((s) => s.room);
  const previewStreamerId = useVoiceStore((s) => s.previewStreamerId);
  const streamAudioWarning = useVoiceStore((s) => s.streamAudioWarning);
  const mediaEngine = useVoiceStore((s) => s.mediaEngine);
  const isMobile = useMobile();
  const webcamTiles = useWebcamTiles();

  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [videoLayout, setVideoLayout] = useState<VideoLayout>('top');
  const [activeStreamers, setActiveStreamers] = useState<string[]>([]);
  const [showVoiceChat, setShowVoiceChat] = useState(false);
  const [stageInstance, setStageInstance] = useState<StageInstance | null>(null);
  const [stageLoading, setStageLoading] = useState(false);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageRequestBusy, setStageRequestBusy] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [stageTopicDraft, setStageTopicDraft] = useState('');
  const [splitState, setSplitState] = useState<{ left: PaneSource; right: PaneSource }>({
    left: { type: 'none' },
    right: { type: 'none' },
  });

  const inSelectedVoiceChannel = Boolean(voiceConnected && voiceChannelId === channelId);
  const voiceJoinPending = Boolean(voiceJoining && joiningChannelId === channelId);
  const voiceJoinError = connectionErrorChannelId === channelId ? connectionError : null;
  const participantCount = Array.from(participants.values()).filter((p) => p.channel_id === channelId).length;
  const stageParticipants = useMemo(
    () =>
      Array.from(participants.values()).filter(
        (participant) => participant.channel_id === channelId,
      ),
    [participants, channelId],
  );
  const stageSpeakers = useMemo(
    () => stageParticipants.filter((participant) => !participant.suppress),
    [stageParticipants],
  );
  const stageAudience = useMemo(
    () => stageParticipants.filter((participant) => participant.suppress),
    [stageParticipants],
  );
  const currentStageParticipant = useMemo(
    () => (currentUserId ? stageParticipants.find((participant) => participant.user_id === currentUserId) : undefined),
    [currentUserId, stageParticipants],
  );
  const isStageAudience = Boolean(isStage && currentStageParticipant?.suppress !== false);
  const hasRequestedToSpeak = Boolean(currentStageParticipant?.request_to_speak_at);
  const speakerRequests = useMemo(
    () => stageAudience.filter((participant) => participant.request_to_speak_at),
    [stageAudience],
  );

  // Demotion must be privacy-safe on the client as well as enforced by the
  // media server. Stop every local publishing surface so a later promotion
  // never resumes a microphone, camera, or share without an explicit action.
  useEffect(() => {
    if (!inSelectedVoiceChannel || !isStageAudience) return;
    if (!selfMute) void toggleMute();
    if (selfVideo) void toggleVideo();
    if (selfStream) stopStream();
  }, [
    inSelectedVoiceChannel,
    isStageAudience,
    selfMute,
    selfVideo,
    selfStream,
    toggleMute,
    toggleVideo,
    stopStream,
  ]);
  const activeStreamerSet = useMemo(() => new Set(activeStreamers), [activeStreamers]);
  const ownStreamIssueMessage = selfStream ? streamAudioWarning : null;
  const watchedStreamerName = useMemo(() => {
    if (!watchedStreamerId) return undefined;
    if (currentUserId != null && watchedStreamerId === currentUserId) return 'You';
    return participants.get(watchedStreamerId)?.username;
  }, [watchedStreamerId, currentUserId, participants]);

  // Clear the reply target when switching channels.
  useEffect(() => {
    setReplyingTo(null);
  }, [channelId]);

  useEffect(() => {
    if (!channelId || !isStage) {
      setStageInstance(null);
      setStageTopicDraft('');
      setStageError(null);
      return;
    }

    let cancelled = false;
    setStageLoading(true);
    setStageError(null);

    stageApi
      .getForChannel(channelId)
      .then(({ data }) => {
        if (cancelled) return;
        setStageInstance(data);
        setStageTopicDraft(data.topic || '');
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 404) {
          setStageInstance(null);
          setStageTopicDraft('');
          return;
        }
        setStageError(extractApiError(err));
      })
      .finally(() => {
        if (!cancelled) setStageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [channelId, isStage]);

  const refreshStageInstance = useCallback(async () => {
    if (!channelId || !isStage) {
      setStageInstance(null);
      return;
    }
    try {
      const { data } = await stageApi.getForChannel(channelId);
      setStageInstance(data);
      setStageTopicDraft(data.topic || '');
      setStageError(null);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        setStageInstance(null);
        setStageTopicDraft('');
        setStageError(null);
        return;
      }
      setStageError(extractApiError(err));
    }
  }, [channelId, isStage]);

  useEffect(() => {
    if (!channelId || !isStage) return;
    const onStageChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ channel_id?: string; guild_id?: string }>).detail;
      if (detail?.channel_id && detail.channel_id !== channelId) return;
      void refreshStageInstance();
    };
    window.addEventListener('paracord:stage-instance-changed', onStageChanged);
    return () => window.removeEventListener('paracord:stage-instance-changed', onStageChanged);
  }, [channelId, isStage, refreshStageInstance]);

  const createStageInstance = async () => {
    if (!channelId || !isStage) return;
    setStageBusy(true);
    try {
      await stageApi.create({
        channel_id: channelId,
        topic: stageTopicDraft.trim() || channelName,
        privacy_level: 2,
      });
      await refreshStageInstance();
    } catch (err) {
      setStageError(extractApiError(err));
    } finally {
      setStageBusy(false);
    }
  };

  const updateStageInstance = async () => {
    if (!stageInstance) return;
    setStageBusy(true);
    try {
      await stageApi.update(stageInstance.id, {
        topic: stageTopicDraft.trim(),
        privacy_level: stageInstance.privacy_level,
      });
      await refreshStageInstance();
    } catch (err) {
      setStageError(extractApiError(err));
    } finally {
      setStageBusy(false);
    }
  };

  const endStageInstance = async () => {
    if (!stageInstance) return;
    setStageBusy(true);
    try {
      await stageApi.remove(stageInstance.id);
      setStageInstance(null);
      setStageTopicDraft('');
      setStageError(null);
    } catch (err) {
      setStageError(extractApiError(err));
    } finally {
      setStageBusy(false);
    }
  };

  const inviteSpeaker = async (userId: string) => {
    if (!stageInstance) return;
    setStageBusy(true);
    try {
      await stageApi.inviteSpeaker(stageInstance.id, userId);
    } catch (err) {
      setStageError(extractApiError(err));
    } finally {
      setStageBusy(false);
    }
  };

  const removeSpeaker = async (userId: string) => {
    if (!stageInstance) return;
    setStageBusy(true);
    try {
      await stageApi.removeSpeaker(stageInstance.id, userId);
    } catch (err) {
      setStageError(extractApiError(err));
    } finally {
      setStageBusy(false);
    }
  };

  const toggleSpeakerRequest = async () => {
    if (!stageInstance || !isStageAudience) return;
    setStageRequestBusy(true);
    setStageError(null);
    try {
      if (hasRequestedToSpeak) {
        await stageApi.cancelSpeakerRequest(stageInstance.id);
      } else {
        await stageApi.requestToSpeak(stageInstance.id);
      }
    } catch (err) {
      setStageError(extractApiError(err));
    } finally {
      setStageRequestBusy(false);
    }
  };

  const dismissSpeakerRequest = async (userId: string) => {
    if (!stageInstance) return;
    setStageRequestBusy(true);
    setStageError(null);
    try {
      await stageApi.dismissSpeakerRequest(stageInstance.id, userId);
    } catch (err) {
      setStageError(extractApiError(err));
    } finally {
      setStageRequestBusy(false);
    }
  };

  useEffect(() => {
    // Native media path: derive active streamers from voice state flags
    // since there is no LiveKit Room to query for track publications.
    if (mediaEngine && inSelectedVoiceChannel) {
      const computeFromVoiceState = () => {
        const next: string[] = [];
        for (const [userId, vs] of participants) {
          if (vs.self_stream) next.push(userId);
        }
        setActiveStreamers((prev) => {
          if (prev.length === next.length && prev.every((id) => next.includes(id))) return prev;
          return next;
        });
      };
      computeFromVoiceState();
      // Re-check periodically since we don't have track events
      const interval = setInterval(computeFromVoiceState, 1000);
      return () => clearInterval(interval);
    }

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

    return () => {
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
  }, [room, mediaEngine, inSelectedVoiceChannel, currentUserId, participants]);

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

  // Participant name map for source picker display
  const participantNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, p] of participants) {
      if (p.username) map.set(id, p.username);
    }
    return map;
  }, [participants]);

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
      }}
    />
  ) : null;

  return (
    <div data-native-underlay-clear="" className="flex min-h-0 flex-1 flex-col relative text-text-muted">
      {inSelectedVoiceChannel && (
        <VoiceControlBar
          onToggleChat={() => setShowVoiceChat(!showVoiceChat)}
          isChatOpen={showVoiceChat}
          listenOnly={isStageAudience}
          requestToSpeakPending={hasRequestedToSpeak}
          requestBusy={stageRequestBusy}
          onToggleRequestToSpeak={() => { void toggleSpeakerRequest(); }}
        />
      )}

      {!inSelectedVoiceChannel && (
        <VoiceLobby
          channelName={channelName}
          participantCount={participantCount}
          isStage={isStage}
          channelId={channelId}
          guildId={guildId}
          voiceJoinError={voiceJoinError}
          voiceJoinPending={voiceJoinPending}
          onRetryJoin={() => {
            clearConnectionError();
            if (channelId && guildId) {
              void joinChannel(channelId, guildId);
            }
          }}
          onJoin={() => {
            if (channelId && guildId) {
              void joinChannel(channelId, guildId);
            }
          }}
          onWatchStream={(userId) => {
            setWatchedStreamer(userId);
            if (channelId && guildId) {
              void joinChannel(channelId, guildId);
            }
          }}
          canManageStage={canManageStage}
          stageInstance={stageInstance}
          stageLoading={stageLoading}
          stageBusy={stageBusy}
          stageError={stageError}
          stageTopicDraft={stageTopicDraft}
          onStageTopicChange={setStageTopicDraft}
          onCreateStage={() => {
            void createStageInstance();
          }}
          onUpdateStage={() => {
            void updateStageInstance();
          }}
          onEndStage={() => {
            void endStageInstance();
          }}
          onInviteSpeaker={(userId) => {
            void inviteSpeaker(userId);
          }}
          onRemoveSpeaker={(userId) => {
            void removeSpeaker(userId);
          }}
          lobbyParticipants={channelId ? (channelParticipants.get(channelId) || []) : []}
        />
      )}
      {inSelectedVoiceChannel && (
        <div data-native-underlay-clear="" className="flex min-h-0 flex-1 relative bg-black">
          {/* Video Area */}
          <div data-native-underlay-clear="" className="flex min-h-0 flex-1 flex-col relative bg-black/40 group/video">
            {!isStage && (watchedStreamerId || videoLayout === 'side') && (
              <div data-native-overlay-occlude="" className="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 rounded-md border border-border-subtle bg-bg-floating px-1.5 py-1.5 shadow-lg backdrop-blur-md opacity-0 group-hover/video:opacity-100 group-focus-within/video:opacity-100 transition-opacity">
                <span className="px-1 text-section uppercase text-text-muted">View</span>
                <div className="mx-0.5 h-4 w-px bg-border-strong" />
                {([
                  { mode: 'top' as const, icon: LayoutList, label: 'Top' },
                  { mode: 'side' as const, icon: PanelLeft, label: 'Side' },
                  { mode: 'pip' as const, icon: PictureInPicture2, label: 'PiP' },
                  { mode: 'hidden' as const, icon: EyeOff, label: 'Hide' },
                ]).map(({ mode, icon: Icon, label }) => (
                  <button
                    key={mode}
                    title={label}
                    aria-label={`Use ${label} video layout`}
                    onClick={() => setVideoLayout(mode)}
                    className={`flex h-8 w-8 items-center justify-center rounded-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] ${videoLayout === mode
                      ? 'bg-accent-primary text-text-on-accent shadow-sm'
                      : 'text-interactive-normal hover:bg-bg-mod-subtle hover:text-interactive-hover'
                      }`}
                  >
                    <Icon size={16} />
                  </button>
                ))}
              </div>
            )}
            {videoLayout === 'side' ? (
              <div data-native-underlay-clear="" className="flex min-h-0 flex-1 gap-2">
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
                  }}
                />
              </div>
            ) : watchedStreamerId ? (
              videoLayout === 'pip' ? (
                <div data-native-underlay-clear="" className="relative min-h-0 flex-1 overflow-hidden">
                  {streamViewerElement}
                  <div className="absolute bottom-3 right-3 z-10">
                    <VideoGrid layout="pip" />
                  </div>
                </div>
              ) : videoLayout === 'hidden' ? (
                <div data-native-underlay-clear="" className="min-h-0 flex-1 overflow-hidden">
                  {streamViewerElement}
                </div>
              ) : (
                <>
                  <VideoGrid layout="compact" />
                  <div data-native-underlay-clear="" className="min-h-0 flex-1 overflow-hidden">
                    {streamViewerElement}
                  </div>
                </>
              )
            ) : (
              <>
                <VideoGrid layout="grid" />
                <div className="min-h-0 flex-1 overflow-hidden">
                  <div className="flex h-full min-h-[240px] items-center bg-bg-primary px-6 sm:min-h-[300px] sm:px-10">
                    <div className="w-full max-w-md">
                      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
                        {isStage ? <Mic size={20} /> : <Monitor size={20} />}
                      </div>
                      <h3 className="font-display text-heading text-text-primary">
                        {isStage ? (stageInstance?.topic || 'The stage is live') : 'Pick a stream to watch'}
                      </h3>
                      {isStage ? (
                        <>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-meta font-semibold ${isStageAudience ? 'bg-bg-mod-subtle text-text-secondary' : 'bg-accent-tint text-accent-primary'}`}>
                              {isStageAudience ? <Hand size={13} /> : <Mic size={13} />}
                              {isStageAudience ? (hasRequestedToSpeak ? 'Request sent' : 'You’re listening') : 'You’re on stage'}
                            </span>
                            <span className="text-meta text-text-muted">
                              {stageSpeakers.length} {stageSpeakers.length === 1 ? 'speaker' : 'speakers'} · {stageAudience.length} listening
                            </span>
                          </div>
                          <p className="mt-3 max-w-prose text-body text-text-secondary">
                            {isStageAudience
                              ? hasRequestedToSpeak
                                ? 'Moderators can see your request. You can keep listening or cancel it from the control bar.'
                                : 'You joined as an audience member. Raise your hand from the control bar when you want to contribute.'
                              : 'Your microphone, camera, and screen share controls are available while you’re on stage.'}
                          </p>
                          {canManageStage && speakerRequests.length > 0 && (
                            <div className="mt-5 rounded-md border border-border-subtle bg-bg-secondary p-3.5">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-section uppercase text-text-muted">Requests to speak</div>
                                  <p className="mt-0.5 text-meta text-text-secondary">
                                    {speakerRequests.length} {speakerRequests.length === 1 ? 'person is' : 'people are'} waiting.
                                  </p>
                                </div>
                                <span className="rounded-full bg-accent-tint px-2 py-0.5 text-meta font-semibold tabular-nums text-accent-primary">
                                  {speakerRequests.length}
                                </span>
                              </div>
                              <div className="mt-3 flex flex-col gap-1.5">
                                {speakerRequests.map((participant) => (
                                  <div key={participant.user_id} className="flex items-center gap-2 rounded-sm bg-bg-tertiary px-2.5 py-2">
                                    <Hand size={15} className="shrink-0 text-accent-primary" />
                                    <span className="min-w-0 flex-1 truncate text-label text-text-primary">{displayName(participant)}</span>
                                    <Button
                                      size="sm"
                                      disabled={stageBusy || stageRequestBusy}
                                      onClick={() => { void inviteSpeaker(participant.user_id); }}
                                    >
                                      <Check size={14} className="mr-1" /> Invite
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      aria-label={`Dismiss ${displayName(participant)}'s request`}
                                      disabled={stageBusy || stageRequestBusy}
                                      onClick={() => { void dismissSpeakerRequest(participant.user_id); }}
                                    >
                                      <X size={14} />
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {stageError && (
                            <div role="alert" className="mt-4 rounded-sm border border-accent-danger/35 bg-danger-tint px-3 py-2 text-meta text-accent-danger">
                              {stageError}
                            </div>
                          )}
                        </>
                      ) : activeStreamers.length > 0 ? (
                        <div className="mt-4 flex flex-col gap-2">
                          {activeStreamers.map((userId) => {
                            const name =
                              currentUserId != null && userId === currentUserId
                                ? 'You'
                                : participantNames.get(userId) ?? `User ${userId.slice(0, 6)}`;
                            return (
                              <button
                                key={userId}
                                type="button"
                                onClick={() => setWatchedStreamer(userId)}
                                className="flex items-center gap-3 rounded-sm border border-border-subtle bg-bg-secondary px-3 py-2.5 text-left outline-none transition-colors hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                              >
                                <span className="inline-flex items-center rounded-xs bg-danger-tint px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-danger">
                                  Live
                                </span>
                                <span className="truncate text-label text-text-primary">
                                  Watch {name}&rsquo;s stream
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mt-2 max-w-prose text-body text-text-secondary">
                          When someone shares their screen, they show up in this list and in the
                          sidebar under the voice channel so you can watch with one click. You can
                          also use the Side layout source picker.
                        </p>
                      )}
                      <div className="mt-4 font-code text-meta text-text-muted">
                        {!isStage && activeStreamers.length > 0
                          ? `${activeStreamers.length} stream${activeStreamers.length === 1 ? '' : 's'} live right now`
                          : isStage
                            ? `${stageParticipants.length} participant${stageParticipants.length === 1 ? '' : 's'} in this stage`
                            : 'No one is streaming yet'}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Voice Chat Sidebar / Mobile Overlay */}
          {showVoiceChat && (
            <VoiceChatSidebar
              isMobile={isMobile}
              isStage={isStage}
              channelId={channelId!}
              guildId={guildId}
              channelName={channelName}
              replyingTo={replyingTo}
              onReply={setReplyingTo}
              onClose={() => setShowVoiceChat(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
