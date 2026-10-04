import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ForwardedRef, type RefObject } from 'react';

import { useGlassKeybinds } from '../../../hooks/useGlassKeybinds';
import { displayName } from '../../../lib/displayName';
import { cn } from '../../../lib/utils';
import { isStreamTarget, useGlassStore, type OpenStageMode, type StageTarget } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { VoiceState } from '../../../types';
import { ErrorBoundary } from '../../ErrorBoundary';
import type { StagePerson } from '../../glass/stage/stageModel';
import { useStageData } from '../../glass/stage/useStageData';
import { TogetherNowPlaying, TogetherWatchStage } from '../../voice/together/TogetherStage';
import { useTogether } from '../../voice/together/useTogether';
import { CallControls } from './CallControls';
import { CallHeader } from './CallHeader';
import { ChatColumn } from './ChatColumn';
import { autoFocusStream, callPeople, callRegionLabel, focusOf } from './callModel';
import { PeopleGrid } from './PeopleGrid';
import { StreamFocus } from './StreamFocus';

/**
 * The Index call view (docs/index-spec.md §7): the call surface over main at
 * inset 10 (over the window in theater), radius 24, `--ix-call`.
 *
 *   header    the channel, the server, chat (H), theater (T), Back to chat (Esc)
 *   content   the people grid; or a stream or a camera in focus above a 112px
 *             filmstrip; or the Watch together player
 *   chat      H: the call's own conversation as a 360px column at the right
 *   controls  joined / audience / watching (`CallControls`)
 *
 * What it shows comes from the Glass stage's data (`useStageData`, the same
 * names, talkers, relation and stream as the room card) and its watch
 * (`useStageWatch`, through `StreamFocus`): the stage target names a streamer
 * while a stream is in focus, and the watch follows it. Showing everyone again
 * stops the watch; closing the view unmounts every tile and the stream, which
 * unsubscribes all video and the stream's own audio, while the voices go on
 * (§7.3). Leaving the call with nothing being watched closes the view.
 *
 * The surface (`.ix-inset-surface`, `data-native-underlay-clear`) and the
 * content layer (`.ix-call__layer`, the counter-layer of §5.8) are handed back
 * through refs: the slot plays the moves (`callMotion.ts`).
 */
export interface CallViewProps {
  target: StageTarget;
  mode: OpenStageMode;
  phone: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
}

const NOBODY: readonly VoiceState[] = [];

export const CallView = forwardRef(function CallView(
  { target, mode, phone, contentRef }: CallViewProps,
  surfaceRef: ForwardedRef<HTMLElement>,
) {
  const { model, watchers } = useStageData(target);
  const callEngine = useVoiceStore((state) => state.mediaEngine);
  const states = useVoiceStore((state) => state.channelParticipants.get(target.channelId) ?? NOBODY);
  const chat = useGlassStore((state) => state.stage.chat);
  const theater = mode === 'theater' && !phone;

  const joined = model.relation === 'joined';
  const realVoice = model.relation === 'joined' || model.relation === 'listening';
  const engine = joined ? callEngine : null;

  // Who sits where: tiles in join order; listeners and a stage channel's audience in one row.
  const { joinedAt, audience } = useMemo(() => {
    const at = new Map<string, number>();
    const held = new Set<string>();
    for (const state of states) {
      const ms = state.joined_at ? Date.parse(state.joined_at) : Number.NaN;
      if (Number.isFinite(ms)) at.set(state.user_id, ms);
      if (model.stageChannel && state.suppress !== false) held.add(state.user_id);
    }
    return { joinedAt: at, audience: held };
  }, [states, model.stageChannel]);
  const { tiles, listening, anyCamera } = useMemo(() => callPeople(model, audience, joinedAt), [model, audience, joinedAt]);
  // Your tile says "You"; its monogram is your own initial (as on the room card).
  const ownName = useMemo(() => {
    const own = states.find((state) => state.user_id === useVoiceStore.getState().callScope?.userId);
    return own ? displayName(own) : null;
  }, [states]);
  const faceName = useCallback((person: StagePerson) => (person.self && ownName ? ownName : person.name), [ownName]);

  /* ---- Focus ------------------------------------------------------------------ */
  const [cameraFocus, setCameraFocus] = useState<string | null>(null);
  // Streams put away with "Show everyone" during this view: not focused again on their own.
  const dismissed = useRef<Set<string>>(new Set());
  const focus = focusOf(target.streamerId, cameraFocus, tiles);
  const openStage = useGlassStore((state) => state.openStage);

  const showStream = useCallback(
    (streamerId: string | null) => openStage({ ...target, streamerId }),
    [openStage, target],
  );

  // Somebody shares: their stream comes into focus (§7.2), unless it was put away.
  const autoStream = target.streamerId === null && cameraFocus === null ? autoFocusStream(tiles, dismissed.current) : null;
  useEffect(() => {
    if (autoStream) showStream(autoStream);
  }, [autoStream, showStream]);

  // Nothing is watched while no stream is in focus.
  useEffect(() => {
    if (target.streamerId === null && useVoiceStore.getState().watchView) void useVoiceStore.getState().stopWatch();
  }, [target.streamerId]);

  // Out of the call with nothing to watch (Leave, the call ended): the view goes.
  useEffect(() => {
    if (target.streamerId === null && model.relation === 'idle') useGlassStore.getState().closeStage();
  }, [target.streamerId, model.relation]);

  const onFocus = useCallback(
    (person: StagePerson, kind: 'stream' | 'camera') => {
      if (kind === 'stream') {
        setCameraFocus(null);
        dismissed.current.delete(person.userId);
        showStream(person.userId);
        return;
      }
      if (target.streamerId !== null) {
        dismissed.current.add(target.streamerId);
        showStream(null);
      }
      setCameraFocus(person.userId);
    },
    [showStream, target.streamerId],
  );

  const showEveryone = useCallback(() => {
    if (target.streamerId !== null) {
      dismissed.current.add(target.streamerId);
      showStream(null);
    }
    setCameraFocus(null);
  }, [showStream, target.streamerId]);

  /* ---- Keys and header -------------------------------------------------------- */
  const close = useCallback(() => {
    useGlassStore.getState().closeStage();
    if (useVoiceStore.getState().watchView) void useVoiceStore.getState().stopWatch();
  }, []);
  useGlassKeybinds({ enabled: true, phone, stream: focus.kind === 'stream', onStop: close });

  const toggleChat = useCallback(() => useGlassStore.getState().toggleChat(), []);
  const toggleTheater = useCallback(() => {
    const glass = useGlassStore.getState();
    glass.setStageMode(glass.stage.mode === 'theater' ? 'side' : 'theater');
  }, []);

  /* ---- Together ----------------------------------------------------------------- */
  const togetherInCall = useTogether();
  const together = togetherInCall && togetherInCall.channelId === target.channelId ? togetherInCall : null;
  const watchTogether = together?.session?.kind === 'watch' ? together : null;
  const listenTogether = together?.session && together.session.kind !== 'watch' ? together : null;

  /* ---- Stream sound, from More ------------------------------------------------------ */
  const soundRef = useRef<HTMLDivElement | null>(null);
  const openStreamSound = useCallback(() => {
    soundRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.click();
  }, []);

  const showChat = chat && !phone;
  let content;
  if (watchTogether && focus.kind === 'grid') {
    content = (
      <div className="ix-call-together">
        <ErrorBoundary variant="section" label="Watch together">
          <TogetherWatchStage together={watchTogether} phone={phone} />
        </ErrorBoundary>
      </div>
    );
  } else if (focus.kind === 'grid') {
    content = (
      <PeopleGrid tiles={tiles} listening={listening} anyCamera={anyCamera} engine={engine} realVoice={realVoice} onFocus={onFocus} faceName={faceName} />
    );
  } else {
    content = (
      <StreamFocus
        focus={focus}
        streamTarget={isStreamTarget(target) ? target : null}
        model={model}
        watchers={watchers}
        tiles={tiles}
        listening={listening}
        engine={engine}
        realVoice={realVoice}
        surfacing={theater && !showChat}
        onShowChat={() => {
          if (!useGlassStore.getState().stage.chat) useGlassStore.getState().toggleChat();
        }}
        onFocus={onFocus}
        onShowEveryone={showEveryone}
        faceName={faceName}
        soundRef={soundRef}
      />
    );
  }

  return (
    <section
      ref={surfaceRef}
      className={cn('ix-inset-surface', 'ix-call')}
      data-testid="ix-call"
      aria-label={callRegionLabel(model)}
      data-native-underlay-clear=""
      data-mode={theater ? 'theater' : 'main'}
      data-focus={focus.kind}
      data-chat={showChat ? 'true' : undefined}
      data-relation={model.relation}
    >
      <div ref={contentRef} className="ix-call__layer">
        <CallHeader
          model={model}
          chat={showChat}
          theater={theater}
          phone={phone}
          onToggleChat={toggleChat}
          onToggleTheater={toggleTheater}
          onBack={close}
        />
        <div className="ix-call__body">
          <div className="ix-call__main">{content}</div>
          {showChat && (
            <ChatColumn
              channelId={target.channelId}
              guildId={target.guildId}
              channelName={model.channelName}
              stageChannel={model.stageChannel}
            />
          )}
        </div>
        {listenTogether && (
          <div className="ix-call__together-line">
            <ErrorBoundary variant="section" label="Listen together">
              <TogetherNowPlaying together={listenTogether} phone={phone} />
            </ErrorBoundary>
          </div>
        )}
        <CallControls
          target={target}
          model={model}
          streamFocused={focus.kind === 'stream'}
          onStreamSound={openStreamSound}
        />
      </div>
    </section>
  );
});
