import { useEffect, useMemo, useRef, useState } from 'react';
import { EyeOff, LayoutList, Monitor, PanelLeft, PictureInPicture2 } from 'lucide-react';
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
    joinChannel,
    clearConnectionError,
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

  const refreshStageInstance = async () => {
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
  };

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
    <div className="flex min-h-0 flex-1 flex-col relative text-text-muted">
      {inSelectedVoiceChannel && (
        <VoiceControlBar onToggleChat={() => setShowVoiceChat(!showVoiceChat)} isChatOpen={showVoiceChat} />
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
        <div className="flex min-h-0 flex-1 relative bg-black">
          {/* Video Area */}
          <div className="flex min-h-0 flex-1 flex-col relative bg-black/40 group/video">
            {!isStage && (watchedStreamerId || videoLayout === 'side') && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 rounded-xl bg-bg-primary/80 px-2 py-1.5 shadow-xl backdrop-blur-xl border border-white/5 opacity-0 group-hover/video:opacity-100 group-focus-within/video:opacity-100 transition-opacity">
                <span className="pl-1 text-xs font-semibold text-text-muted">View</span>
                <div className="h-4 w-px bg-white/10 mx-1" />
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
                    className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${videoLayout === mode
                      ? 'bg-accent-primary text-white shadow-md'
                      : 'text-text-secondary hover:bg-white/10 hover:text-white'
                      }`}
                  >
                    <Icon size={16} />
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
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {streamViewerElement}
                  <div className="absolute bottom-3 right-3 z-10">
                    <VideoGrid layout="pip" />
                  </div>
                </div>
              ) : videoLayout === 'hidden' ? (
                <div className="min-h-0 flex-1 overflow-hidden">
                  {streamViewerElement}
                </div>
              ) : (
                <>
                  <VideoGrid layout="compact" />
                  <div className="min-h-0 flex-1 overflow-hidden">
                    {streamViewerElement}
                  </div>
                </>
              )
            ) : (
              <>
                <VideoGrid layout="grid" />
                <div className="min-h-0 flex-1 overflow-hidden">
                  <div className="relative flex h-full min-h-[240px] items-center justify-center overflow-hidden bg-bg-mod-subtle/30 sm:min-h-[300px]">
                    <div className="pointer-events-none absolute -top-12 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full blur-3xl" style={{ backgroundColor: 'var(--ambient-glow-primary)' }} />
                    <div className="relative mx-3 flex w-full max-w-md flex-col items-center rounded-2xl border border-border-subtle bg-bg-mod-subtle/70 px-8 py-10 text-center sm:mx-4 sm:px-12 sm:py-12">
                      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-bg-primary/70 text-text-secondary">
                        <Monitor size={20} />
                      </div>
                      <div className="text-base font-semibold text-text-primary">
                        {isStage ? 'Stage discussion is live' : 'Choose a stream from the sidebar'}
                      </div>
                      <div className="mt-1 text-sm text-text-secondary">
                        {isStage ? (
                          <>
                            Speakers: <span className="font-semibold text-text-primary">{stageSpeakers.length}</span> · Audience:{' '}
                            <span className="font-semibold text-text-primary">{stageAudience.length}</span>
                          </>
                        ) : (
                          <>
                            Use the red <span className="font-semibold text-accent-danger">LIVE</span> buttons beside voice participants to switch streams.
                          </>
                        )}
                      </div>
                      <div className="mt-4 text-xs text-text-muted">
                        {!isStage && activeStreamers.length > 0
                          ? `${activeStreamers.length} stream${activeStreamers.length === 1 ? '' : 's'} currently live`
                          : isStage
                            ? `${stageParticipants.length} participant${stageParticipants.length === 1 ? '' : 's'} in this stage`
                            : 'No active streams right now'}
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
