import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';

import { glassKeyAction, keyBelongsElsewhere } from '../../../hooks/useGlassKeybinds';
import { useClip } from '../../../lib/media/clips/useClip';
import { useGlassStore, type OpenStageMode, type StageTarget } from '../../../stores/glassStore';
import { toast } from '../../../stores/toastStore';
import { ClipGlyph, WatchGlyph } from '../primitives';
import { controlsFit, watchingLabel, type ControlsFit } from '../stage/stageModel';
import { StageControls } from '../stage/StageControls';
import { useStageData } from '../stage/useStageData';
import { stopWatching } from '../stage/useStageWatch';

/**
 * What a phone draws over the stream (docs/glass-spec.md §8, `screens/07`).
 *
 * Above the conversation the stream is a card: 16:9, radius 22, with a back
 * button at its top left (stop watching: you stay in the call), the clip button
 * ("30s") and full screen at its top right, "Vincent's screen" at its bottom
 * left and "2 watching" at its bottom right.
 *
 * Full screen is the phone's theater (§6.2): the stream fills the window, back
 * returns to the card, and the stage's controls float as a glass capsule over
 * the stream, the same controls the side-by-side stage has. The stage itself
 * (`components/glass/stage`) draws the stream, its notices, the clip toast and
 * the reactions; on a phone it draws no overlay of its own (glass-phone.css
 * hides it), because this is the one the reference shows.
 */
export function PhoneStageChrome({ target, mode }: { target: StageTarget; mode: OpenStageMode }) {
  const { model, watchers } = useStageData(target);
  const clip = useClip({ ...target, streamerName: model.streamerName });
  const setStageMode = useGlassStore((state) => state.setStageMode);
  const fullScreen = mode === 'theater';
  const count = watchingLabel(watchers);

  const onClip = () => {
    if (!clip.available) {
      toast.info(clip.unavailableReason ?? 'Clips are not available.');
      return;
    }
    clip.clip().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'The clip could not be saved.');
    });
  };

  // Esc in full screen goes back to the card first; the next Esc stops watching
  // (the stage's own key, which only knows the card). Claimed in the capture
  // phase, so the stage's listener on the same window finds the key taken.
  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || glassKeyAction(event) !== 'stop') return;
      if (keyBelongsElsewhere(event) || useGlassStore.getState().sheet !== null) return;
      event.preventDefault();
      setStageMode('side');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullScreen, setStageMode]);

  // The controls give up their labels and then their reactions as the window
  // narrows (the stage's own ladder), measured against the room the capsule has.
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<ControlsFit>(2);
  useLayoutEffect(() => {
    const box = capsuleRef.current;
    if (!fullScreen || !box) return;
    const measure = () => setFit(controlsFit(box.clientWidth - 20, model.controls));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [fullScreen, model.controls]);

  return (
    <div className="glass-phone-stage" data-mode={fullScreen ? 'fullscreen' : 'card'}>
      <span className="glass-phone-stage__shade glass-phone-stage__shade--top" aria-hidden="true" />
      <span className="glass-phone-stage__shade glass-phone-stage__shade--bottom" aria-hidden="true" />

      <button
        type="button"
        className="glass-stage__sbtn glass-phone-stage__btn glass-phone-stage__back glass-focusable"
        aria-label={fullScreen ? 'Exit full screen' : 'Stop watching'}
        aria-keyshortcuts={fullScreen ? undefined : 'Escape'}
        title={fullScreen ? 'Back to the stream card' : 'Stop watching. You stay in the call.'}
        onClick={fullScreen ? () => setStageMode('side') : stopWatching}
      >
        <ChevronLeft size={17} strokeWidth={2} aria-hidden="true" />
      </button>

      <span className="glass-phone-stage__tools">
        {!fullScreen && (
          <button
            type="button"
            className="glass-stage__sbtn glass-phone-stage__btn glass-phone-stage__clip glass-focusable"
            aria-label="Clip the last 30 seconds"
            aria-disabled={!clip.available || clip.saving || undefined}
            title={clip.available ? 'Clip the last 30 seconds' : clip.unavailableReason ?? undefined}
            onClick={onClip}
          >
            <ClipGlyph size={17} />
            <span className="glass-instrument">30s</span>
          </button>
        )}
        <button
          type="button"
          className="glass-stage__sbtn glass-phone-stage__btn glass-focusable"
          aria-label={fullScreen ? 'Exit full screen' : 'Full screen'}
          aria-pressed={fullScreen}
          title={fullScreen ? 'Exit full screen' : 'Full screen'}
          onClick={() => setStageMode(fullScreen ? 'side' : 'theater')}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {fullScreen ? (
              <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
            ) : (
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            )}
          </svg>
        </button>
      </span>

      <span className="glass-phone-stage__who">
        <span className="glass-phone-stage__dot" aria-hidden="true" />
        <span className="glass-phone-stage__label">{model.label}</span>
      </span>
      {count && (
        <span className="glass-phone-stage__count">
          <WatchGlyph size={14} aria-hidden="true" />
          <span className="glass-instrument">{count}</span>
        </span>
      )}

      {fullScreen && (
        <div ref={capsuleRef} className="glass-phone-stage__controls">
          <StageControls target={target} model={model} fit={fit} />
        </div>
      )}
    </div>
  );
}
