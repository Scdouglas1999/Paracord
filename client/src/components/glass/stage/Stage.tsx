import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { MessageSquareText, PanelLeft, X } from 'lucide-react';

import { useGlassKeybinds } from '../../../hooks/useGlassKeybinds';
import { useGlassStore } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { GlassButton, SplitGlyph, TheaterGlyph } from '../primitives';
import type { StageProps } from '../shell/slots';
import { useGlassLayout } from '../shell/useGlassLayout';
import { ClipToast } from './ClipToast';
import {
  controlsFit,
  stageGeometry,
  watchingLabel,
  watchNotice,
  STAGE_INSET,
  type ControlsFit,
  type StageGeometry,
} from './stageModel';
import { StageControls } from './StageControls';
import { StagePeople } from './StagePeople';
import { StreamReactionsLayer } from './StreamReactionsLayer';
import { StreamSurface } from './StreamSurface';
import { SurfacingMessages } from './SurfacingMessages';
import { useStreamPoster } from './stageTransition';
import { TheaterPeople } from './TheaterPeople';
import { useStageData } from './useStageData';
import { useStageGlow } from './useStageGlow';
import { stopWatching, useStageWatch } from './useStageWatch';

/**
 * The stage (docs/glass-spec.md §6; WP-G14 side by side, WP-G15 theater and
 * browse). The slot the shell mounts in `section.glass-frame__stage` while
 * `glassStore.stage` is open; the shell owns the pane's place, size, radius and
 * `--deep` fill, and this fills it.
 *
 * Side by side (§6.1): the stream full width minus 24 at 16:9 (radius 18) with
 * its overlay (sidebar S, the amber live dot, "Vincent's screen" and "Game
 * Night Lounge, live for 42 min"; theater T and Stop watching on the right),
 * then the people row (camera tiles, then chips), then the control row.
 *
 * Theater (§6.2): the stream fills the window; the conversation floats as a
 * 380px column on the right and the stream's buttons move left of it (plus the
 * chat button, H). Only the talker gets a tile, top left; everyone else is a
 * face. The controls are a glass capsule centered on what is visible of the
 * stream. With the chat hidden, new messages surface bottom left.
 *
 * Browse (§6.3) is the shell's (the places panel back in, S); in theater it
 * floats over the stream's left edge and the faces, title and controls move
 * over (glass-stage-modes.css reads `data-browse`).
 *
 * The tree keeps the same shape in both modes (stream, people, controls), so
 * switching never remounts the stream: it keeps playing, on the same canvas
 * and the same subscription. The moves between the layouts are
 * `stageTransition.ts`'s, driven from the frame.
 *
 * Watching: the stage starts the watch when it opens and stops it when it
 * closes (`useStageWatch`); watching never joins and Stop watching never leaves.
 * Keys: `useGlassKeybinds` (S, T, H, C, Esc).
 */
export function Stage({ target, mode }: StageProps) {
  const layout = useGlassLayout();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const posterRef = useRef<HTMLCanvasElement | null>(null);
  const { model, watchers } = useStageData(target);
  const { view, watchAgain } = useStageWatch(target);
  const callEngine = useVoiceStore((state) => state.mediaEngine);
  const browseOpen = useGlassStore((state) => state.browseOpen);
  const chatHidden = useGlassStore((state) => state.chatHidden);
  const toggleBrowse = useGlassStore((state) => state.toggleBrowse);
  const toggleChatHidden = useGlassStore((state) => state.toggleChatHidden);
  const setChatHidden = useGlassStore((state) => state.setChatHidden);
  const setStageMode = useGlassStore((state) => state.setStageMode);
  const openStage = useGlassStore((state) => state.openStage);
  const [hasPicture, setHasPicture] = useState(false);
  const phone = layout === 'phone';
  const theater = mode === 'theater' && !phone;

  useStageGlow(rootRef, target.streamerId);
  useStreamPoster(posterRef, target.streamerId);
  useGlassKeybinds({ enabled: true, phone, onStop: stopWatching });

  /* ---- Geometry: the stream takes what the pane allows at 16:9 ------------------ */
  const [geometry, setGeometry] = useState<StageGeometry | null>(null);
  const [fit, setFit] = useState<ControlsFit>(0);
  const cameraCount = model.cameras.length;
  const chipCount = model.chips.length;
  const controls = model.controls;
  // Re-measured in a layout effect whenever the layout changes (mode, browse,
  // the chat), so the new geometry is committed before the first frame of the
  // move is painted: the move measures where things end from it.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || phone) return;
    const measure = () => {
      const { width, height } = root.getBoundingClientRect();
      if (!(width > 0) || !(height > 0)) return;
      if (theater) {
        // The capsule sits on what is visible of the stream: left of the chat, right of places.
        const covered = (browseOpen ? PLACES_EDGE : 0) + (!chatHidden && !browseOpen ? CHAT_EDGE : 0);
        setFit(controlsFit(width - covered - 2 * THEATER_CONTROLS_SIDE, controls));
        return;
      }
      const next = stageGeometry({ width, height, cameras: cameraCount, chips: chipCount });
      setGeometry((previous) =>
        previous && previous.streamW === next.streamW && previous.streamH === next.streamH && previous.rowH === next.rowH
          ? previous
          : next,
      );
      setFit(controlsFit(width - 2 * STAGE_INSET, controls));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [phone, theater, browseOpen, chatHidden, cameraCount, chipCount, controls]);

  const switchTo = useCallback(
    (streamerId: string) => openStage({ ...target, streamerId }),
    [openStage, target],
  );

  const notice = watchNotice({
    phase: view?.phase ?? null,
    error: view?.error ?? null,
    endReason: view?.endReason ?? null,
    streamerName: model.streamerName,
    streamerSharing: model.streamerSharing,
    hasPicture,
  });
  const watching = watchingLabel(watchers);
  const clipTarget = { ...target, streamerName: model.streamerName };
  const chatShown = theater && !chatHidden && !browseOpen;

  const noticeNode = notice.text ? (
    <span className="glass-stage__notice-body" data-pending={notice.pending ? 'true' : undefined}>
      <span>{notice.text}</span>
      {notice.retry && (
        <GlassButton variant="text" size="md" onClick={watchAgain}>
          Watch again
        </GlassButton>
      )}
    </span>
  ) : null;

  const overlay = (
    <div className="glass-stage__overlay">
      <div className="glass-stage__title-group" data-glass-move="title">
        {!phone && (
          <button
            type="button"
            className="glass-stage__sbtn glass-focusable"
            aria-label={browseOpen ? 'Hide servers and channels' : 'Show servers and channels'}
            aria-pressed={browseOpen}
            aria-keyshortcuts="S"
            title="Servers and channels (S)"
            onClick={toggleBrowse}
          >
            <PanelLeft size={18} strokeWidth={1.7} aria-hidden="true" />
          </button>
        )}
        <span className="glass-stage__live-dot" aria-hidden="true" />
        <span className="glass-stage__titles">
          <span className="glass-stage__title">{model.label}</span>
          <span className="glass-stage__subtitle">
            {model.subtitle}
            {watching && (
              <>
                <span aria-hidden="true"> · </span>
                <span className="glass-stage__watching glass-instrument">{watching}</span>
              </>
            )}
          </span>
        </span>
      </div>
      <div className="glass-stage__actions" data-glass-move="actions">
        {theater && (
          <button
            type="button"
            className="glass-stage__sbtn glass-focusable"
            aria-label={chatShown ? 'Hide chat' : 'Show chat'}
            aria-pressed={chatShown}
            aria-keyshortcuts="H"
            title="Show or hide chat (H)"
            onClick={() => {
              // While browsing the chat is out of the way; the button brings it back.
              if (browseOpen) {
                useGlassStore.getState().setBrowseOpen(false);
                setChatHidden(false);
                return;
              }
              toggleChatHidden();
            }}
          >
            <MessageSquareText size={18} strokeWidth={1.7} aria-hidden="true" />
          </button>
        )}
        {!phone && (
          <button
            type="button"
            className="glass-stage__sbtn glass-focusable"
            aria-label={theater ? 'Show side by side with chat' : 'Theater mode'}
            aria-keyshortcuts="T"
            title={theater ? 'Show side by side with chat (T)' : 'Theater mode (T)'}
            onClick={() => setStageMode(theater ? 'side' : 'theater')}
          >
            {theater ? <SplitGlyph size={18} /> : <TheaterGlyph size={18} />}
          </button>
        )}
        <button
          type="button"
          className="glass-stage__sbtn glass-stage__stop glass-focusable"
          aria-label={phone ? 'Stop watching' : undefined}
          aria-keyshortcuts="Escape"
          title="Stop watching (Esc). You stay in the call."
          onClick={stopWatching}
        >
          <X size={16} strokeWidth={2} aria-hidden="true" />
          {!phone && <span>Stop watching</span>}
        </button>
      </div>
    </div>
  );

  const streamStyle = !phone && !theater && geometry ? { width: geometry.streamW, height: geometry.streamH } : undefined;
  const people = [...model.cameras, ...model.chips];

  return (
    <div
      ref={rootRef}
      className="glass-stage"
      data-mode={theater ? 'theater' : 'side'}
      data-layout={phone ? 'phone' : 'pane'}
      data-measured={geometry && !theater ? 'true' : undefined}
      data-browse={browseOpen ? 'true' : undefined}
      data-chat={theater ? (chatShown ? 'shown' : 'hidden') : undefined}
    >
      <StreamSurface
        engine={view?.phase === 'live' ? view.engine : null}
        streamerId={target.streamerId}
        notice={noticeNode}
        onPicture={setHasPicture}
        style={streamStyle}
      >
        <canvas ref={posterRef} className="glass-stage__poster" aria-hidden="true" width={32} height={18} />
        <span className="glass-stage__scrim" aria-hidden="true" />
        {overlay}
        <ClipToast target={clipTarget} />
        <StreamReactionsLayer target={target} />
        {theater && <SurfacingMessages active={chatHidden && !browseOpen} onShowChat={() => setChatHidden(false)} />}
      </StreamSurface>

      {!phone && (
        <>
          {theater ? (
            <TheaterPeople
              people={people}
              callEngine={callEngine}
              joined={model.relation === 'joined'}
              realVoice={model.relation === 'joined' || model.relation === 'listening'}
              watchedId={target.streamerId}
              onSwitch={switchTo}
            />
          ) : (
            <div
              className="glass-stage__row"
              data-glass-move="people-side"
              style={geometry ? { height: geometry.rowH } : undefined}
            >
              <StagePeople
                cameras={model.cameras}
                chips={model.chips}
                callEngine={callEngine}
                joined={model.relation === 'joined'}
                realVoice={model.relation === 'joined' || model.relation === 'listening'}
                watchedId={target.streamerId}
                onSwitch={switchTo}
              />
            </div>
          )}
          <StageControls target={target} model={model} fit={fit} />
        </>
      )}
    </div>
  );
}

/** Theater: what the places panel covers of the stream's left (16 + 316 + 16), and the chat of its right (380 + 16). */
const PLACES_EDGE = 348;
const CHAT_EDGE = 396;
/** Room kept either side of the controls capsule. */
const THEATER_CONTROLS_SIDE = 24;
