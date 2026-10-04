import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
}

export function StreamFocus(props: StreamFocusProps) {
  const { focus, tiles, listening, engine, realVoice, onFocus, faceName } = props;
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

  const pictureStyle = box ? { width: box.width, height: box.height } : undefined;
  const focused = focus.kind === 'camera' ? tiles.find((person) => person.userId === focus.userId) ?? null : null;

  return (
    <div ref={areaRef} className="ix-call-focus" data-focus={focus.kind} data-strip={hasStrip ? 'true' : undefined}>
      <div className="ix-call-focus__stage">
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
                variant="strip"
                faceName={faceName(person)}
                current={current}
                onActivate={kind && !current ? () => onFocus(person, kind) : null}
                activateLabel={kind && !current ? activateLabelOf(person, kind) : undefined}
              />
            );
          })}
          {listening.length > 0 && <ListeningRow people={listening} faceName={faceName} />}
        </div>
      )}
    </div>
  );
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
      <div className="ix-call-stream__overlay" ref={soundRef}>
        <span className="ix-call-stream__label">
          <span className="ix-call-stream__who">{model.label}</span>
          {watching && <span className="ix-call-stream__count">{watching}</span>}
        </span>
        <span className="ix-call-stream__tools">
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
        </span>
      </div>
      <ClipToast target={{ ...streamTarget, streamerName: model.streamerName }} />
      <SurfacingMessages active={surfacing} onShowChat={onShowChat} />
    </StreamSurface>
  );
}
