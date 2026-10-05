import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { useGlassStore, type OpenStageMode } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { IxGlyph } from '../glyphs';
import { IX_REDUCED_MS, IX_SPRING, canAnimate, invertTransform, ixReduced, onSettle, type RectLike } from '../motion';
import { usePhoneLandscape } from '../shell/phone/phoneLayout';
import { beginCallMove, counterKeyframes, findCallCard, ghostOf, playClose } from './callMotion';

/**
 * The call on a phone (docs/index-spec.md §9 "Call as a sheet"; IX-16): the
 * call view presented as a bottom sheet over everything.
 *
 *   - Top inset: the safe area + 8; radius 24 on the top corners; a grab
 *     handle; the view's own header, content and controls inside it (the
 *     controls above the safe area, ix-phone.css). No chat column on a phone.
 *   - It rises out of what opened it, 420ms on the spring: the call strip on a
 *     pushed page, the room card on the root; from the bottom edge otherwise.
 *     Back to chat (or Leave, or the call ending) shrinks it back into the
 *     strip or the card.
 *   - Drag it down by its header or handle and it follows the finger; let go
 *     past a third of the way, or flick it, and it goes; otherwise it springs
 *     back. A drag that dismisses closes the view like Back to chat (the call
 *     goes on; every video is unsubscribed, §7.3).
 *   - People tiles are one column for one or two people, two above that; a
 *     stream sits 16:9 at the top with people below (ix-phone.css lays the
 *     view's grid and focus out that way).
 *   - Full screen: a phone turned sideways with a stream in focus, or the
 *     header's Full screen control (the stage's theater mode), shows the
 *     stream alone over the whole screen, with Back to chat and Exit full
 *     screen floating over it.
 *
 * The view itself (`CallView`) is the desktop's, unchanged: this is its frame.
 * Moves are transform and opacity only (ids `ix-call-sheet:*`); none fills
 * forwards on anything that stays. Reduced motion: a 150ms fade.
 */

export const CALL_SHEET_OPEN_MS = 420;
export const CALL_SHEET_DISMISS_MS = 360;
/** Let go past this share of the sheet's height and it goes. */
const DISMISS_SHARE = 1 / 3;
/** A downward release faster than this (px/ms) dismisses. */
const DISMISS_FLICK = 0.5;
/** Travel before a press on the header becomes a drag (px). */
const DRAG_SLOP = 6;

export interface CallSheetProps {
  channelId: string;
  mode: OpenStageMode;
  children: ReactNode;
}

/** Where the sheet grows out of and shrinks back into: the strip on a pushed page, else the card. */
export function findSheetOrigin(channelId: string): RectLike | null {
  if (typeof document === 'undefined') return null;
  const frame = document.querySelector<HTMLElement>(".ix-frame[data-layout='phone']");
  if (frame?.dataset.screen === 'conversation') {
    const strip = frame.querySelector<HTMLElement>('[data-ix-call-strip][data-state="yours"]');
    if (strip && (!strip.dataset.channelId || strip.dataset.channelId === channelId)) {
      const rect = strip.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    return null;
  }
  return findCallCard(channelId)?.getBoundingClientRect() ?? null;
}

/** A drag let go far enough: the close plays on from where the finger left the sheet. */
let dismissFrom: number | null = null;

export function CallSheet({ channelId, mode, children }: CallSheetProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const landscape = usePhoneLandscape();
  const streamFocused = useGlassStore((state) => state.stage.streamerId !== null);
  const fullScreen = streamFocused && (landscape || mode === 'theater');
  const channelRef = useRef(channelId);
  useEffect(() => {
    channelRef.current = channelId;
  }, [channelId]);

  /* ---- Rise ------------------------------------------------------------------- */
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return undefined;
    const end = beginCallMove();
    const played: Animation[] = [];
    const scrim = scrimRef.current;
    if (ixReduced()) {
      if (canAnimate(sheet)) {
        const fade = sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: IX_REDUCED_MS, easing: 'ease-out' });
        fade.id = 'ix-call-sheet:open';
        played.push(fade);
      }
    } else {
      const to = sheet.getBoundingClientRect();
      const origin = findSheetOrigin(channelId);
      if (canAnimate(sheet)) {
        if (origin) {
          const grow = sheet.animate(
            [
              { transform: invertTransform(origin, to, 'xy') ?? 'none', transformOrigin: '0 0', opacity: 0.4 },
              { transform: 'none', transformOrigin: '0 0', opacity: 1 },
            ],
            { duration: CALL_SHEET_OPEN_MS, easing: IX_SPRING },
          );
          grow.id = 'ix-call-sheet:open';
          played.push(grow);
          const layer = sheet.querySelector<HTMLElement>('.ix-call__layer');
          if (canAnimate(layer)) {
            const counter = layer.animate(counterKeyframes(origin, to, 0.35), { duration: CALL_SHEET_OPEN_MS, easing: 'linear' });
            counter.id = 'ix-call-sheet:open-content';
            played.push(counter);
          }
        } else {
          const rise = sheet.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], {
            duration: CALL_SHEET_OPEN_MS,
            easing: IX_SPRING,
          });
          rise.id = 'ix-call-sheet:open';
          played.push(rise);
        }
      }
    }
    if (canAnimate(scrim)) {
      const dim = scrim.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: ixReduced() ? IX_REDUCED_MS : CALL_SHEET_OPEN_MS,
        easing: 'ease-out',
      });
      dim.id = 'ix-call-sheet:scrim';
      played.push(dim);
    }
    const dispose = onSettle(played, end);
    return () => {
      dispose();
      end();
    };
    // Once per sheet: the call it shows is its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Close: a still copy leaves while the view unmounts at once (§7.3) -------- */
  useEffect(() => {
    return useGlassStore.subscribe((state, previous) => {
      if (previous.stage.mode === 'none' || state.stage.mode !== 'none') return;
      const sheet = sheetRef.current;
      const scrim = scrimRef.current;
      if (!sheet || !sheet.isConnected) return;
      const end = beginCallMove();
      const sheetGhost = ghostOf(sheet);
      const scrimGhost = scrim && scrim.isConnected ? ghostOf(scrim) : null;
      const from = dismissFrom;
      dismissFrom = null;
      const finish = () => {
        sheetGhost.remove();
        scrimGhost?.remove();
        end();
      };
      const reduced = ixReduced();
      const duration = reduced ? IX_REDUCED_MS : from !== null ? CALL_SHEET_DISMISS_MS : 450;
      if (scrimGhost && canAnimate(scrimGhost)) {
        const fade = scrimGhost.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'ease-out', fill: 'forwards' });
        fade.id = 'ix-call-sheet:scrim-out';
      }
      if (from !== null && !reduced && canAnimate(sheetGhost)) {
        // The ghost was taken where the finger left it (its rect includes the
        // drag); it goes on down off the screen.
        const rest = Math.max(0, window.innerHeight - sheetGhost.getBoundingClientRect().top);
        const away = sheetGhost.animate([{ transform: 'none' }, { transform: `translateY(${Math.round(rest)}px)` }], {
          duration,
          easing: IX_SPRING,
          fill: 'forwards',
        });
        away.id = 'ix-call-sheet:dismiss';
        onSettle([away], finish);
        setTimeout(finish, duration + 500);
        return;
      }
      playClose(sheetGhost, reduced ? null : findSheetOrigin(channelRef.current), finish);
    });
  }, []);

  /* ---- Drag to dismiss ---------------------------------------------------------- */
  const drag = useRef<{ id: number; startY: number; y: number; dragging: boolean; samples: Array<{ y: number; t: number }> } | null>(null);
  // Native video stays under posters while a finger moves the sheet (§7.6).
  const dragGuard = useRef<(() => void) | null>(null);
  const endDragGuard = useCallback(() => {
    dragGuard.current?.();
    dragGuard.current = null;
  }, []);
  useEffect(() => endDragGuard, [endDragGuard]);

  const close = useCallback(() => {
    useGlassStore.getState().closeStage();
    if (useVoiceStore.getState().watchView) void useVoiceStore.getState().stopWatch();
  }, []);

  const paint = (y: number) => {
    const sheet = sheetRef.current;
    const scrim = scrimRef.current;
    if (sheet) sheet.style.transform = y > 0 ? `translateY(${Math.round(y)}px)` : '';
    if (scrim) scrim.style.opacity = String(Math.max(0, 1 - y / Math.max(1, sheet?.offsetHeight ?? 1)));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (fullScreen || event.button !== 0) return;
    const target = event.target as Element;
    if (!target.closest('.ix-call-sheet__handle, .ix-call-head') || target.closest('button, a, [role="button"]')) return;
    drag.current = { id: event.pointerId, startY: event.clientY, y: 0, dragging: false, samples: [{ y: event.clientY, t: event.timeStamp }] };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const dy = event.clientY - state.startY;
    if (!state.dragging) {
      if (Math.abs(dy) < DRAG_SLOP) return;
      if (dy < 0) {
        drag.current = null;
        return;
      }
      state.dragging = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      endDragGuard();
      dragGuard.current = beginCallMove();
    }
    // Upward past the rest: a little give, never a lift.
    state.y = dy >= 0 ? dy : dy / 6;
    state.samples.push({ y: event.clientY, t: event.timeStamp });
    if (state.samples.length > 5) state.samples.shift();
    paint(Math.max(0, state.y));
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.id !== event.pointerId || !state.dragging) return;
    const sheet = sheetRef.current;
    const height = sheet?.offsetHeight ?? 1;
    const first = state.samples[0];
    const last = state.samples[state.samples.length - 1];
    const velocity = last && first && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    const y = Math.max(0, state.y);
    if (event.type !== 'pointercancel' && (velocity > DISMISS_FLICK || (y > height * DISMISS_SHARE && velocity > -DISMISS_FLICK))) {
      dismissFrom = y;
      close();
      // The close holds its own guard for its move.
      endDragGuard();
      return;
    }
    // Back to rest.
    paint(0);
    if (sheet && canAnimate(sheet) && y > 0) {
      const back = sheet.animate([{ transform: `translateY(${Math.round(y)}px)` }, { transform: 'none' }], {
        duration: ixReduced() ? IX_REDUCED_MS : 300,
        easing: IX_SPRING,
      });
      back.id = 'ix-call-sheet:return';
      onSettle([back], endDragGuard);
    } else {
      endDragGuard();
    }
    const scrim = scrimRef.current;
    if (scrim && canAnimate(scrim) && y > 0) {
      const brighten = scrim.animate([{ opacity: Math.max(0, 1 - y / height) }, { opacity: 1 }], { duration: 300, easing: IX_SPRING });
      brighten.id = 'ix-call-sheet:scrim-return';
    }
  };

  const exitFullScreen = () => useGlassStore.getState().setStageMode('main');

  return (
    <>
      {/* Scenery: the sheet leaves by its drag, Back to chat or Esc. */}
      <div ref={scrimRef} className="ix-call-sheet__scrim" aria-hidden="true" />
      <div
        ref={sheetRef}
        className="ix-call-sheet"
        data-testid="ix-call-sheet"
        data-fullscreen={fullScreen ? 'true' : undefined}
        data-landscape={landscape ? 'true' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div className="ix-call-sheet__handle" aria-hidden="true" />
        {children}
        {fullScreen && (
          <div className="ix-call-sheet__float">
            <button type="button" className="ix-call-sheet__float-btn" data-testid="ix-call-sheet-back" onClick={close}>
              Back to chat
            </button>
            {!landscape && (
              <button
                type="button"
                className="ix-call-sheet__float-btn ix-call-sheet__float-btn--icon"
                aria-label="Exit full screen"
                title="Exit full screen"
                data-testid="ix-call-sheet-exit-full"
                onClick={exitFullScreen}
              >
                <IxGlyph name="theater" size={18} />
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
