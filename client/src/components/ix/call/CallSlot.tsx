import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { stageTargetOf, useGlassStore, type OpenStageMode } from '../../../stores/glassStore';
import { onSettle, type RectLike } from '../motion';
import { useIxShell } from '../shell/IxShellContext';
import type { CallSlotProps } from '../shell/slots';
import {
  beginCallMove,
  CALL_CLOSE_MS,
  CALL_OPEN_MS,
  findCallCard,
  ghostOf,
  playClose,
  playOpen,
  playTheater,
} from './callMotion';
import { CallSheet } from './CallSheet';
import { CallView } from './CallView';
import { useWindowFullScreen } from './windowFullScreen';

/**
 * The call slot (index-spec §7; IX-4's `CallSlot` contract): always mounted in
 * `#ix-call-host`, it renders the call view while `glassStore.stage` is open
 * and nothing otherwise, and plays the view's moves (§5.8, §5.9):
 *
 *   - a store listener runs inside `set()`, before React touches the DOM, so it
 *     measures where things ARE: the room card the view grows out of (open),
 *     the surface before the host moves it (theater), and, on close, it takes
 *     a still copy of the surface to shrink into the card while the real view
 *     unmounts at once (every video unsubscribed, §7.3);
 *   - a layout effect plays the open and theater FLIPs once React committed;
 *     going full screen and back is the theater FLIP too (§7.7), from where
 *     the surface was to the whole window, while `useWindowFullScreen` makes
 *     the window (or the document) full screen under it;
 *   - every move holds the native video guard (`beginCallMove`) for its length.
 *
 * A newer move commits the running one first (no queueing). The chat column
 * (H) changes the content's layout without a move: its 250ms guard keeps
 * native video under posters while the tiles settle into their new boxes.
 */

type Pending =
  | { kind: 'open'; origin: RectLike | null; end: () => void }
  | { kind: 'theater'; from: RectLike | null; end: () => void };

interface Running {
  animations: Animation[];
  end: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** How long the native guard covers a chat column change (no animation plays). */
const CHAT_GUARD_MS = 250;

let moving = 0;

/**
 * A move of the call view begins: the native guard (`beginCallMove`, desktop
 * only), and `<html data-ix-call-moving>` on every platform for its length.
 * While the view fills the window and nothing moves, the page under it is not
 * drawn at all (ix-call.css): a sidebar nobody can see does not repaint its
 * waveforms behind a full-screen stream. During a move it stays, so the
 * surface grows over it rather than over a hole.
 */
function beginMove(): () => void {
  const endNative = beginCallMove();
  moving += 1;
  document.documentElement.setAttribute('data-ix-call-moving', '');
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    endNative();
    moving = Math.max(0, moving - 1);
    if (moving === 0) document.documentElement.removeAttribute('data-ix-call-moving');
  };
}

export function CallSlot(_props: CallSlotProps) {
  const { layout } = useIxShell();
  const phone = layout === 'phone';
  const stage = useGlassStore((state) => state.stage);
  const open = stage.mode !== 'none';
  const target = useMemo(
    () => stageTargetOf(stage),
    // The target's fields, not the stage object (chat toggles replace it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, stage.serverId, stage.guildId, stage.channelId, stage.streamerId],
  );
  // §7.7: the window is full screen exactly while the view is (never on a phone).
  useWindowFullScreen(open && !phone && stage.fullscreen);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pending = useRef<Pending | null>(null);
  const running = useRef<Running | null>(null);
  const phoneRef = useRef(phone);
  useEffect(() => {
    phoneRef.current = phone;
  }, [phone]);

  useEffect(() => {
    const settle = () => {
      const run = running.current;
      running.current = null;
      if (!run) return;
      if (run.timer) clearTimeout(run.timer);
      for (const animation of run.animations) animation.cancel();
      run.end();
    };
    const unsubscribe = useGlassStore.subscribe((state, previous) => {
      const was = previous.stage.mode;
      const now = state.stage.mode;
      if (was !== 'none' && now !== 'none' && previous.stage.chat !== state.stage.chat) {
        // H: no move; cover native video while the layout settles.
        settle();
        const end = beginMove();
        running.current = { animations: [], end, timer: setTimeout(() => settle(), CHAT_GUARD_MS) };
        return;
      }
      const fullscreenChanged = was !== 'none' && now !== 'none' && previous.stage.fullscreen !== state.stage.fullscreen;
      if ((was === now && !fullscreenChanged) || phoneRef.current) return;
      settle();
      if (pending.current) {
        pending.current.end();
        pending.current = null;
      }
      if (was === 'none') {
        const card = state.stage.channelId ? findCallCard(state.stage.channelId) : null;
        pending.current = { kind: 'open', origin: card?.getBoundingClientRect() ?? null, end: beginMove() };
        return;
      }
      if (now === 'none') {
        const surface = surfaceRef.current;
        if (!surface || !surface.isConnected) return;
        const end = beginMove();
        const ghost = ghostOf(surface);
        const card = previous.stage.channelId ? findCallCard(previous.stage.channelId) : null;
        const run: Running = {
          animations: [],
          end: () => {
            ghost.remove();
            end();
          },
          timer: null,
        };
        let done = false;
        run.animations = playClose(ghost, card?.getBoundingClientRect() ?? null, () => {
          done = true;
          if (running.current === run) running.current = null;
          end();
        });
        if (!done) running.current = run;
        return;
      }
      pending.current = { kind: 'theater', from: surfaceRef.current?.getBoundingClientRect() ?? null, end: beginMove() };
    });
    return () => {
      unsubscribe();
      settle();
      pending.current?.end();
      pending.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const move = pending.current;
    if (!move) return;
    pending.current = null;
    const surface = surfaceRef.current;
    if (!surface) {
      move.end();
      return;
    }
    const animations =
      move.kind === 'open' ? playOpen(surface, contentRef.current, move.origin) : playTheater(surface, contentRef.current, move.from);
    const run: Running = { animations, end: move.end, timer: null };
    running.current = run;
    const finish = () => {
      if (run.timer) clearTimeout(run.timer);
      run.timer = null;
      if (running.current === run) running.current = null;
      run.end();
    };
    onSettle(animations, finish);
    // A hidden window stops the animation clock; the guard still comes off.
    if (running.current === run) run.timer = setTimeout(finish, Math.max(CALL_OPEN_MS, CALL_CLOSE_MS) + 500);
  }, [stage.mode, stage.fullscreen]);

  if (!target || !open) return null;
  const key = `${target.serverId}:${target.channelId}`;
  const view = (
    <CallView
      key={key}
      ref={surfaceRef}
      target={target}
      mode={stage.mode as OpenStageMode}
      phone={phone}
      contentRef={contentRef}
    />
  );
  // A phone presents the view as a bottom sheet with its own moves (IX-16).
  if (phone) {
    return (
      <CallSheet key={key} channelId={target.channelId} mode={stage.mode as OpenStageMode}>
        {view}
      </CallSheet>
    );
  }
  return view;
}
