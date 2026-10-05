import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import type { StreamStageTarget } from '../../../stores/glassStore';
import { ClipToast } from '../../glass/stage/ClipToast';
import { watchingLabel, watchNotice, type StageModel, type StagePerson } from '../../glass/stage/stageModel';
import { StreamSoundButton } from '../../glass/stage/StreamSound';
import { StreamSurface } from '../../glass/stage/StreamSurface';
import { SurfacingMessages } from '../../glass/stage/SurfacingMessages';
import { useStageWatch } from '../../glass/stage/useStageWatch';
import { IxGlyph } from '../glyphs';
import { CallTile } from './CallTile';
import { focusBox, tileFocus, type CallFocus } from './callModel';
import { activateLabelOf, ListeningRow } from './PeopleGrid';

/**
 * Something in focus (docs/index-spec.md §7.2): a stream, or somebody's
 * camera, 16:9 at radius 20, as large as the content area allows above a 112px
 * filmstrip of everyone else (camera video, or a 52px avatar). A click on a
 * filmstrip tile focuses it; "Show everyone" on the picture goes back to the
 * people grid.
 *
 * The stream is the Glass stage's `StreamSurface`, composed unchanged: it
 * subscribes the watched stream on the watch's engine and, in the desktop app,
 * mirrors its box to a native surface (poster while the hole is closed). Over
 * it, on hover: whose screen it is, the stream's sound and quality
 * (`StreamSoundButton`) and Show everyone; the clip toast; in theater with the
 * chat off, messages surfacing bottom left (`SurfacingMessages`).
 *
 * Theater and full screen (`immersive`, §7.7): the stream fills the content
 * area edge to edge, letterboxed only by its own aspect, and the filmstrip
 * becomes a row of 64px faces (`mini`, no cameras) that comes and goes with
 * the chrome (`useIdleChrome`). The stream's label and tools move to the
 * header there. A double click on the stream goes full screen and back.
 */
export interface StreamFocusProps {
  focus: Exclude<CallFocus, { kind: 'grid' }>;
  /** The stage target when a stream is in focus. */
  streamTarget: StreamStageTarget | null;
  model: StageModel;
  watchers: number;
  /** Everyone with a tile, and the listening row. */
  tiles: readonly StagePerson[];
  listening: readonly StagePerson[];
  engine: MediaEngine | null;
  realVoice: boolean;
  /** Theater with the chat column off: messages surface over the stream. */
  surfacing: boolean;
  onShowChat: () => void;
  onFocus: (person: StagePerson, kind: 'stream' | 'camera') => void;
  onShowEveryone: () => void;
  /** The name a person's monogram is drawn from (yours is your name, not "You"). */
  faceName: (person: StagePerson) => string;
  /** Where "Stream volume and quality" in More finds the overlay's button. */
  soundRef?: React.RefObject<HTMLDivElement | null>;
  /** The stream fills the window (theater or full screen): no 16:9 box, faces only in the filmstrip. */
  immersive?: boolean;
  /** The stream is full screen. */
  fullscreen?: boolean;
  /** Full screen and back (the overlay's button, a double click on the stream). */
  onToggleFullscreen?: () => void;
}

export function StreamFocus(props: StreamFocusProps) {
  const { focus, tiles, listening, engine, realVoice, onFocus, faceName, immersive = false, onToggleFullscreen } = props;
  const areaRef = useRef<HTMLDivElement | null>(null);
  const strip = tiles.filter((person) => !(focus.kind === 'camera' && person.userId === focus.userId));
  const hasStrip = strip.length > 0 || listening.length > 0;
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  // The layout size, never the painted box (the surface may be mid-move).
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => {
      const next = focusBox(area.clientWidth, area.clientHeight, hasStrip);
      setBox((previous) => (previous && previous.width === next.width && previous.height === next.height ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [hasStrip]);

  // Immersive: the stream's box is the whole area (CSS), its picture letterboxed inside.
  const pictureStyle = box && !immersive ? { width: box.width, height: box.height } : undefined;
  const focused = focus.kind === 'camera' ? tiles.find((person) => person.userId === focus.userId) ?? null : null;

  return (
    <div ref={areaRef} className="ix-call-focus" data-focus={focus.kind} data-strip={hasStrip ? 'true' : undefined}>
      <div className="ix-call-focus__stage" onDoubleClick={onToggleFullscreen ? (event) => toggleOnStream(event, onToggleFullscreen) : undefined}>
        {focus.kind === 'stream' && props.streamTarget ? (
          <StreamPicture {...props} streamTarget={props.streamTarget} style={pictureStyle} />
        ) : focused ? (
          <div className="ix-call-focus__camera" style={pictureStyle}>
            <CallTile
              person={focused}
              engine={engine}
              realVoice={realVoice}
              variant="focus"
              faceName={faceName(focused)}
              onActivate={props.onShowEveryone}
              activateLabel="Show everyone"
            />
          </div>
        ) : null}
      </div>
      {hasStrip && (
        <div className="ix-call-strip" role="list" aria-label="People in the call">
          {strip.map((person) => {
            const kind = tileFocus(person);
            const current =
              (focus.kind === 'stream' && kind === 'stream' && person.userId === focus.userId) ||
              (focus.kind === 'camera' && person.userId === focus.userId);
            return (
              <CallTile
                key={person.userId}
                person={person}
                engine={engine}
                realVoice={realVoice}
                variant={immersive ? 'mini' : 'strip'}
                faceName={faceName(person)}
                current={current}
                onActivate={kind && !current ? () => onFocus(person, kind) : null}
                activateLabel={kind && !current ? activateLabelOf(person, kind) : undefined}
              />
            );
          })}
          {listening.length > 0 && !immersive && <ListeningRow people={listening} faceName={faceName} />}
        </div>
      )}
    </div>
  );
}

/** A double click on the stream itself (not on a control over it) goes full screen and back. */
function toggleOnStream(event: MouseEvent<HTMLElement>, toggle: () => void): void {
  const target = event.target as Element | null;
  if (!target?.closest('.ix-call-stream')) return;
  if (target.closest('button, a, input, [role="button"], .ix-call-stream__overlay, .glass-clip-toast')) return;
  event.preventDefault();
  toggle();
}

function StreamPicture({
  streamTarget,
  model,
  watchers,
  surfacing,
  onShowChat,
  onShowEveryone,
  soundRef,
  style,
  immersive = false,
  fullscreen = false,
  onToggleFullscreen,
}: StreamFocusProps & { streamTarget: StreamStageTarget; style: React.CSSProperties | undefined }) {
  const { view, watchAgain } = useStageWatch(streamTarget);
  const [hasPicture, setHasPicture] = useState(false);
  const notice = watchNotice({
    phase: view?.phase ?? null,
    error: view?.error ?? null,
    endReason: view?.endReason ?? null,
    streamerName: model.streamerName,
    streamerSharing: model.streamerSharing,
    hasPicture,
  });
  const watching = watchingLabel(watchers);
  const noticeNode: ReactNode = notice.text ? (
    <span className="ix-call-notice" data-pending={notice.pending ? 'true' : undefined}>
      <span>{notice.text}</span>
      {notice.retry && (
        <button type="button" className="ix-call-notice__retry" onClick={watchAgain}>
          Watch again
        </button>
      )}
    </span>
  ) : null;

  return (
    <StreamSurface
      engine={view?.phase === 'live' ? view.engine : null}
      streamerId={streamTarget.streamerId}
      notice={noticeNode}
      onPicture={setHasPicture}
      className="ix-call-stream"
      style={style}
    >
      {/* Immersive: the label and these tools are the header's (CallView). */}
      {!immersive && (
        <div className="ix-call-stream__overlay" ref={soundRef}>
          <StreamLabel label={model.label} watching={watching} />
          <span className="ix-call-stream__tools">
            <StreamTools onShowEveryone={onShowEveryone} />
            {onToggleFullscreen && (
              <button
                type="button"
                className="ix-call-stream__tool"
                aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
                aria-keyshortcuts="F"
                title={fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
                data-testid="ix-call-stream-fullscreen"
                onClick={onToggleFullscreen}
              >
                <IxGlyph name={fullscreen ? 'fullScreenExit' : 'fullScreen'} size={17} />
              </button>
            )}
          </span>
        </div>
      )}
      <ClipToast target={{ ...streamTarget, streamerName: model.streamerName }} />
      <SurfacingMessages active={surfacing} onShowChat={onShowChat} />
    </StreamSurface>
  );
}

/** "Vincent's screen · 3 watching": over the stream, or leading the header when the stream fills the window. */
export function StreamLabel({ label, watching }: { label: string; watching: string | null }) {
  return (
    <span className="ix-call-stream__label">
      <span className="ix-call-stream__who">{label}</span>
      {watching && <span className="ix-call-stream__count">{watching}</span>}
    </span>
  );
}

/** The stream's own tools: its sound and quality, and Show everyone. */
export function StreamTools({ onShowEveryone }: { onShowEveryone: () => void }) {
  return (
    <>
      <StreamSoundButton className="ix-call-stream__tool" />
      <button
        type="button"
        className="ix-call-stream__tool"
        aria-label="Show everyone"
        title="Show everyone. You stay in the call."
        onClick={onShowEveryone}
      >
        <IxGlyph name="people" size={17} />
      </button>
    </>
  );
}
