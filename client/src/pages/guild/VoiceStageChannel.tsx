import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  EyeOff,
  Hand,
  LayoutList,
  MoreHorizontal,
  PanelLeft,
  PictureInPicture2,
  UserPlus,
  X,
} from 'lucide-react';
import { RoomEvent, Track } from 'livekit-client';
import { useNavigate } from 'react-router';

import { StreamViewer } from '../../components/voice/StreamViewer';
import { SplitPane } from '../../components/voice/SplitPane';
import { VoiceControlBar } from '../../components/voice/VoiceControlBar';
import { StageSpeakers } from '../../components/voice/StageSpeakers';
import {
  StageHeader,
  StageLayout,
  StageNotice,
  StageStatus,
  callTransport,
  transportReadout,
  type StagePhase,
} from '../../components/voice/stage';
import { VoiceConnectionCheckButton } from '../../components/voice/VoiceConnectionCheckButton';
import type { PaneSource } from '../../components/voice/SplitPaneSourcePicker';
import { AvatarStack, HereNowStrip } from '../../components/light';
import { Button, IconButton, MenuItem, Popover, Raised } from '../../components/ui';
import { InviteModal } from '../../components/guild/InviteModal';
import { useVoice } from '../../hooks/useVoice';
import { useStream } from '../../hooks/useStream';
import { useWebcamTiles } from '../../hooks/useWebcamTiles';
import { useScreenShareSubscriptions } from '../../hooks/useScreenShareSubscriptions';
import { useBuildingLight, useHereNow, useLightClock } from '../../hooks/useLights';
import { useVoiceStore } from '../../stores/voiceStore';
import { stageApi, type StageInstance } from '../../api/stage';
import { extractApiError } from '../../api/client';
import { VoiceLobby } from './VoiceLobby';
import { RoomChat } from './RoomChat';
import { displayName } from '../../lib/displayName';
import { roomSharedName, walkOutOfRoom } from '../../lib/motion';
import { ErrorBoundary } from '../../components/ErrorBoundary';

type VideoLayout = 'top' | 'side' | 'pip' | 'hidden';

const LAYOUT_OPTIONS = [
  { mode: 'top' as const, icon: LayoutList, label: 'Focus' },
  { mode: 'side' as const, icon: PanelLeft, label: 'Split' },
  { mode: 'pip' as const, icon: PictureInPicture2, label: 'Picture in picture' },
  { mode: 'hidden' as const, icon: EyeOff, label: 'Share only' },
];

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
  const callPhase = useVoiceStore((s) => s.callPhase);
  const previewStreamerId = useVoiceStore((s) => s.previewStreamerId);
  const streamAudioWarning = useVoiceStore((s) => s.streamAudioWarning);
  const mediaEngine = useVoiceStore((s) => s.mediaEngine);
  const webcamTiles = useWebcamTiles();
  const navigate = useNavigate();

  // The room, as light (WP1). Who is here, how long it has been lit and what
  // the header says all come from here — the Stage never re-derives a light.
  const building = useBuildingLight(guildId);
  const roomLight = useMemo(
    () => building?.rooms.find((entry) => entry.channelId === channelId) ?? null,
    [building, channelId],
  );
  const hereNow = useHereNow(guildId, channelId);

  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [videoLayout, setVideoLayout] = useState<VideoLayout>('top');
  const [activeStreamers, setActiveStreamers] = useState<string[]>([]);
  const [showRoomChat, setShowRoomChat] = useState(!isPhoneLayout);
  const [chatSheetExpanded, setChatSheetExpanded] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const layoutAnchor = useRef<HTMLButtonElement>(null);
  const moreAnchor = useRef<HTMLButtonElement>(null);
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

  // How long this client has been trying to get back in — the reconnect count
  // in "Reconnecting to Shop floor · 3 s". Observed here, never guessed.
  const reconnecting = inSelectedVoiceChannel && callPhase === 'reconnecting';
  const reconnectSinceRef = useRef<number | null>(null);
  if (reconnecting && reconnectSinceRef.current == null) reconnectSinceRef.current = Date.now();
  if (!reconnecting && reconnectSinceRef.current != null) reconnectSinceRef.current = null;
  const clockNow = useLightClock(reconnecting || voiceJoinPending);
  const reconnectElapsedMs =
    reconnectSinceRef.current != null ? clockNow - reconnectSinceRef.current : 0;

  const transport = transportReadout({
    transport: callTransport({ hasMediaEngine: Boolean(mediaEngine), hasRoom: Boolean(room) }),
  });

  const retryJoin = () => {
    clearConnectionError();
    if (channelId && guildId) void joinChannel(channelId, guildId);
  };

  // The call surface drives WebGL/native video. A throw in here must not take
  // the channel (or the app) down — the user needs the controls to leave.
  const streamViewerElement = watchedStreamerId ? (
    <ErrorBoundary variant="section" label="the stream">
    <StreamViewer
      streamerId={watchedStreamerId}
      streamerName={watchedStreamerName}
      transport={transport}
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
    </ErrorBoundary>
  ) : null;

  const splitElement = (
    <div data-native-underlay-clear="" className="flex min-h-0 h-full gap-[var(--gutter)]">
      {(['left', 'right'] as const).map((side) => (
        <SplitPane
          key={side}
          source={splitState[side]}
          onSourceChange={(src) => setSplitState((prev) => ({ ...prev, [side]: src }))}
          otherPaneSource={splitState[side === 'left' ? 'right' : 'left']}
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
      ))}
    </div>
  );

  const occupants = roomLight?.occupants ?? [];
  const canChooseLayout = !isStage && Boolean(watchedStreamerId || videoLayout === 'side');
  // Split view fills the whole area; picture-in-picture and share-only hide the
  // strip while a share is on the dominant tile. Everything else keeps it.
  const showSpeakerStrip =
    videoLayout === 'side' ? false : videoLayout === 'top' || !watchedStreamerId;

  const header = (
    <StageHeader
      // §5.1: the header is chrome. It rises 80ms behind the tile you walked
      // into, staggered with the speaker strip and the control bar.
      data-motion-chrome=""
      compact={isPhoneLayout}
      roomName={roomLight?.name ?? channelName}
      buildingName={building?.name ?? null}
      durationMs={roomLight?.durationMs ?? null}
      leading={
        isPhoneLayout ? (
          <IconButton
            label="Back to the building"
            size="md"
            tone="ghost"
            onClick={(event) => {
              const go = () => navigate(guildId ? `/app/guilds/${guildId}` : '/app');
              if (!channelId) {
                go();
                return;
              }
              // Leaving folds the dominant tile into the on-air pill, which is
              // the same shared element the other way round (§5.1).
              void walkOutOfRoom({
                channelId,
                origin: event.currentTarget.closest('[data-motion-shared]'),
                go,
              });
            }}
          >
            <ChevronLeft size={20} />
          </IconButton>
        ) : undefined
      }
      hereCaption={hereNow.here > 0 ? `${hereNow.here} here` : null}
      hereNow={
        isPhoneLayout ? (
          <AvatarStack
            people={hereNow.people}
            size={26}
            max={3}
            context={`in ${roomLight?.name ?? channelName}`}
            room={channelId ?? null}
          />
        ) : (
          <HereNowStrip
            hereNow={hereNow}
            context={`in ${roomLight?.name ?? channelName}`}
            room={channelId ?? null}
          />
        )
      }
      actions={
        <>
          {!isPhoneLayout && guildId && channelId && (
            <Button variant="ghost" onClick={() => setShowInvite(true)}>
              <UserPlus size={16} className="mr-1.5" />
              Invite
            </Button>
          )}
          {canChooseLayout && (
            <>
              <Button
                ref={layoutAnchor}
                variant="ghost"
                aria-haspopup="menu"
                aria-expanded={layoutMenuOpen}
                onClick={() => setLayoutMenuOpen((open) => !open)}
              >
                <LayoutList size={16} className="mr-1.5" />
                Layout
              </Button>
              <Popover
                anchor={layoutAnchor}
                open={layoutMenuOpen}
                onClose={() => setLayoutMenuOpen(false)}
                side="bottom"
                align="end"
                role="menu"
                label="Video layout"
                className="w-56 p-1.5"
              >
                {LAYOUT_OPTIONS.filter((option) => !(isPhoneLayout && option.mode === 'side')).map(
                  ({ mode, icon: Icon, label }) => (
                    <MenuItem
                      key={mode}
                      icon={<Icon size={16} />}
                      trailing={videoLayout === mode ? <Check size={15} /> : undefined}
                      onClick={() => {
                        setVideoLayout(mode);
                        setLayoutMenuOpen(false);
                      }}
                    >
                      {label}
                    </MenuItem>
                  ),
                )}
              </Popover>
            </>
          )}
          <IconButton
            ref={moreAnchor}
            label="More room actions"
            size="md"
            tone="ghost"
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            onClick={() => setMoreMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={18} />
          </IconButton>
          <Popover
            anchor={moreAnchor}
            open={moreMenuOpen}
            onClose={() => setMoreMenuOpen(false)}
            side="bottom"
            align="end"
            label="Room actions"
            className="w-64 p-2"
          >
            <div className="flex flex-col items-stretch gap-2">
              {isPhoneLayout && guildId && channelId && (
                <Button variant="ghost" onClick={() => { setShowInvite(true); setMoreMenuOpen(false); }}>
                  <UserPlus size={16} className="mr-1.5" />
                  Invite people
                </Button>
              )}
              <VoiceConnectionCheckButton variant="ghost" label="Run a connection check" />
            </div>
          </Popover>
        </>
      }
    />
  );

  const ribbon =
    showRoomChat && channelId ? (
      <RoomChat
        isPhone={isPhoneLayout}
        channelId={channelId}
        guildId={guildId}
        channelName={roomLight?.name ?? channelName}
        replyingTo={replyingTo}
        onReply={setReplyingTo}
        onClose={() => setShowRoomChat(false)}
        expanded={chatSheetExpanded}
        onToggleExpanded={() => setChatSheetExpanded((open) => !open)}
      />
    ) : undefined;

  const requestsRow =
    isStage && canManageStage && speakerRequests.length > 0 ? (
      <Raised bare className="flex shrink-0 flex-col gap-1.5 p-2.5">
        <div className="flex items-center gap-2">
          <Hand size={14} className="shrink-0 text-text-secondary" aria-hidden />
          <span className="text-label text-text-primary">
            {speakerRequests.length === 1
              ? 'One person wants to speak'
              : `${speakerRequests.length} people want to speak`}
          </span>
        </div>
        <ul className="flex flex-col gap-1">
          {speakerRequests.map((participant) => (
            <li
              key={participant.user_id}
              className="flex items-center gap-2 rounded-[var(--radius-control)] bg-bg-well px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-label text-text-primary">
                {displayName(participant)}
              </span>
              <Button
                size="sm"
                variant="light"
                disabled={stageBusy || stageRequestBusy}
                onClick={() => { void inviteSpeaker(participant.user_id); }}
              >
                <Check size={14} className="mr-1" /> Let them speak
              </Button>
              <IconButton
                label={`Dismiss ${displayName(participant)}'s request`}
                size="sm"
                tone="ghost"
                disabled={stageBusy || stageRequestBusy}
                onClick={() => { void dismissSpeakerRequest(participant.user_id); }}
              >
                <X size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
        {stageError && (
          <p role="alert" className="text-meta text-accent-danger">{stageError}</p>
        )}
      </Raised>
    ) : null;

  const speakersArrangement = (dominant: boolean) => (dominant ? 'strip' : 'grid');
  // `h-full`, because on a phone the speakers region is a plain block that hands
  // this wrapper the whole remaining plate — and a flex column with no height of
  // its own shrank to its content instead, leaving ~390px of empty plate between
  // a single speaker tile and the control bar (§7.2: the room fills the Stage).
  // The desktop grid cell stretches its child either way, so this is the same
  // height there as before.
  const renderSpeakers = (withDominant: boolean) => (
    <div className="flex h-full min-h-0 flex-col gap-[var(--gutter)]" data-motion-chrome="">
      {requestsRow}
      <StageSpeakers
        className="min-h-0 flex-1"
        occupants={occupants}
        currentUserId={currentUserId}
        arrangement={speakersArrangement(withDominant)}
        compact={isPhoneLayout}
        onWatch={setWatchedStreamer}
        watchingUserId={watchedStreamerId}
      />
    </div>
  );

  // A reconnect is a notice above the tiles, never a replacement for them:
  // unmounting a live share would tear its subscriptions down and rebuild them
  // for a blip the transport is already handling.
  const reconnectNotice = reconnecting ? (
    <Raised bare className="shrink-0 px-3 py-2">
      <StageNotice
        phase="reconnecting"
        roomName={roomLight?.name ?? channelName}
        elapsedMs={reconnectElapsedMs}
      />
    </Raised>
  ) : undefined;

  const dominant = (() => {
    if (videoLayout === 'side') return splitElement;
    if (!watchedStreamerId) return null;
    if (videoLayout === 'pip') {
      return (
        <div data-native-underlay-clear="" className="relative h-full min-h-0 overflow-hidden">
          {streamViewerElement}
          <div className="absolute bottom-3 right-3 z-10">
            <ErrorBoundary variant="section" label="the video tiles">
              <StageSpeakers
                occupants={occupants}
                currentUserId={currentUserId}
                arrangement="pip"
                compact={isPhoneLayout}
              />
            </ErrorBoundary>
          </div>
        </div>
      );
    }
    return streamViewerElement;
  })();

  const inviteModal =
    showInvite && channelId ? (
      <InviteModal
        guildName={channelName}
        channelId={channelId}
        onClose={() => setShowInvite(false)}
      />
    ) : null;

  // --- Not in the room yet ------------------------------------------------
  if (!inSelectedVoiceChannel) {
    const pendingPhase: StagePhase | null = voiceJoinPending
      ? 'joining'
      : voiceJoinError
        ? 'failed'
        : null;

    if (pendingPhase) {
      return (
        <div data-native-underlay-clear="" className="flex min-h-0 flex-1 flex-col bg-bg-base p-[var(--gutter)]">
          <StageLayout
            phone={isPhoneLayout}
            sharedName={channelId ? roomSharedName(channelId) : null}
            header={header}
            dominant={
              <StageStatus
                phase={pendingPhase}
                roomName={roomLight?.name ?? channelName}
                elapsedMs={null}
                reason={voiceJoinError}
                actions={
                  pendingPhase === 'failed' ? (
                    <>
                      <Button variant="light" onClick={retryJoin}>
                        Try joining again
                      </Button>
                      <VoiceConnectionCheckButton variant="ghost" label="Run a connection check" autoStart />
                    </>
                  ) : undefined
                }
              />
            }
            speakers={occupants.length > 0 ? renderSpeakers(true) : undefined}
            controls={null}
            ribbon={ribbon}
          />
          {inviteModal}
        </div>
      );
    }

    return (
      <div data-native-underlay-clear="" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg-base">
        <VoiceLobby
          channelName={channelName}
          participantCount={participantCount}
          isStage={isStage}
          channelId={channelId}
          guildId={guildId}
          room={roomLight}
          voiceJoinError={voiceJoinError}
          voiceJoinPending={voiceJoinPending}
          onRetryJoin={retryJoin}
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
      </div>
    );
  }

  // --- On the Stage -------------------------------------------------------
  return (
    <div data-native-underlay-clear="" className="flex min-h-0 flex-1 flex-col bg-bg-base p-[var(--gutter)]">
      <StageLayout
        phone={isPhoneLayout}
        sharedName={channelId ? roomSharedName(channelId) : null}
        header={header}
        notice={reconnectNotice}
        dominant={dominant}
        speakers={showSpeakerStrip ? renderSpeakers(Boolean(dominant)) : undefined}
        controls={
          <VoiceControlBar
            onToggleChat={() => {
              setShowRoomChat((open) => !open);
              setChatSheetExpanded(true);
            }}
            isChatOpen={showRoomChat}
            listenOnly={isStageAudience}
            requestToSpeakPending={hasRequestedToSpeak}
            requestBusy={stageRequestBusy}
            onToggleRequestToSpeak={() => { void toggleSpeakerRequest(); }}
          />
        }
        ribbon={ribbon}
      />
      {inviteModal}
    </div>
  );
}
