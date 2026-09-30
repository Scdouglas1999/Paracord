import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PanelLeft, X } from 'lucide-react';

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
import { useStageData } from './useStageData';
import { useStageGlow } from './useStageGlow';
import { stopWatching, useStageWatch } from './useStageWatch';

/**
 * The stage (docs/glass-spec.md §6, §6.1; WP-G14). The slot the shell mounts in
 * `section.glass-frame__stage` while `glassStore.stage` is open; the shell
 * owns the pane's place, size, radius and `--deep` fill, and this fills it.
 *
 * Side by side: the stream full width minus 24 at 16:9 (radius 18) with its
 * overlay (sidebar S, the amber live dot, "Vincent's screen" and "Game Night
 * Lounge, live for 42 min"; theater T and Stop watching on the right), then the
 * people row (camera tiles, then chips), then the control row, centered.
 *
 * Watching: the stage starts the watch when it opens and stops it when it
 * closes (`useStageWatch`); watching never joins and Stop watching never leaves
 * (Leave is the only way out of a call). A click on another sharer's tile or
 * chip switches the watch. Esc is Stop watching, unless something above the
 * stage wants it first (a menu, a dialog, the message box, browse).
 *
 * Theater (§6.2) is WP-G15's: until it lands, the stage draws this same layout
 * when `mode === 'theater'`, in the full-window pane the shell gives it.
 */
export function Stage({ target, mode }: StageProps) {
  const layout = useGlassLayout();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { model, watchers } = useStageData(target);
  const { view, watchAgain } = useStageWatch(target);
  const callEngine = useVoiceStore((state) => state.mediaEngine);
  const browseOpen = useGlassStore((state) => state.browseOpen);
  const toggleBrowse = useGlassStore((state) => state.toggleBrowse);
  const setStageMode = useGlassStore((state) => state.setStageMode);
  const openStage = useGlassStore((state) => state.openStage);
  const [hasPicture, setHasPicture] = useState(false);
  const phone = layout === 'phone';

  useStageGlow(rootRef, target.streamerId);

  /* ---- Geometry: the stream takes what the pane allows at 16:9 ------------------ */
  const [geometry, setGeometry] = useState<StageGeometry | null>(null);
  const [fit, setFit] = useState<ControlsFit>(0);
  const cameraCount = model.cameras.length;
  const chipCount = model.chips.length;
  const controls = model.controls;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || phone) return;
    const measure = () => {
      const { width, height } = root.getBoundingClientRect();
      if (!(width > 0) || !(height > 0)) return;
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
  }, [phone, cameraCount, chipCount, controls]);

  /* ---- Esc: Stop watching ------------------------------------------------------------ */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;
      if (escapeBelongsElsewhere(event)) return;
      const glass = useGlassStore.getState();
      if (glass.sheet !== null) return;
      event.preventDefault();
      // Browsing is a layer over the stage: Esc puts the places panel away first.
      if (glass.browseOpen) {
        glass.setBrowseOpen(false);
        return;
      }
      stopWatching();
    };
    // On `window`, so every handler on the way (a menu's, a dialog's focus trap,
    // the message box's) has had the key first and can claim it.
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      <div className="glass-stage__title-group">
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
      <div className="glass-stage__actions">
        {!phone && (
          <button
            type="button"
            className="glass-stage__sbtn glass-focusable"
            aria-label={mode === 'theater' ? 'Show side by side with chat' : 'Theater mode'}
            aria-keyshortcuts="T"
            title={mode === 'theater' ? 'Show side by side with chat (T)' : 'Theater mode (T)'}
            onClick={() => setStageMode(mode === 'theater' ? 'side' : 'theater')}
          >
            {mode === 'theater' ? <SplitGlyph size={18} /> : <TheaterGlyph size={18} />}
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

  const streamStyle = !phone && geometry ? { width: geometry.streamW, height: geometry.streamH } : undefined;

  return (
    <div
      ref={rootRef}
      className="glass-stage"
      data-mode={mode}
      data-layout={phone ? 'phone' : 'pane'}
      data-measured={geometry ? 'true' : undefined}
    >
      <StreamSurface
        engine={view?.phase === 'live' ? view.engine : null}
        streamerId={target.streamerId}
        notice={noticeNode}
        onPicture={setHasPicture}
        style={streamStyle}
      >
        <span className="glass-stage__scrim" aria-hidden="true" />
        {overlay}
        <ClipToast target={clipTarget} />
        <StreamReactionsLayer target={target} />
      </StreamSurface>

      {!phone && (
        <>
          <div className="glass-stage__row" style={geometry ? { height: geometry.rowH } : undefined}>
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
          <StageControls target={target} model={model} fit={fit} />
        </>
      )}
    </div>
  );
}

/** Whether an Escape press is somebody else's: typing, or a layer above the stage is open. */
function escapeBelongsElsewhere(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  }
  const layers = document.querySelectorAll<HTMLElement>(
    '[data-stream-overlay-portal], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  );
  // Only a layer that is actually on screen claims the key.
  return [...layers].some((layer) => layer.getClientRects().length > 0 && getComputedStyle(layer).visibility !== 'hidden');
}
