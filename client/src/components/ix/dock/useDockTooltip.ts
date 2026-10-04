import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** A hover opens the name after 400ms (§4.8, §6.11); moving to a neighbor while it is open is immediate. */
export const TIP_DELAY_MS = 400;
/** How long after a tooltip closes the next one still opens at once. */
const TIP_GRACE_MS = 300;

export interface DockTip {
  label: string;
  /** The target's center, in the dock's own coordinates. */
  center: number;
}

export interface DockTooltip {
  tip: DockTip | null;
  /** False while the tooltip fades out (it stays mounted with its last words). */
  shown: boolean;
  /** Hover or focus reached `target`. */
  reach: (target: HTMLElement, mode: 'hover' | 'focus') => void;
  /** Hover or focus left `target` (or anything, with no argument). */
  leave: (target?: HTMLElement | null) => void;
}

/**
 * The dock's one tooltip (§4.8). Every item (and the `+`) carries `data-tip`;
 * this opens a single bubble over whichever one is hovered or keyboard-focused.
 * It lives outside the servers' scroller, which clips what pokes out of it.
 */
export function useDockTooltip(root: RefObject<HTMLElement | null>): DockTooltip {
  const [tip, setTip] = useState<DockTip | null>(null);
  const [shown, setShownState] = useState(false);
  const isShown = useRef(false);
  const owner = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedAt = useRef(0);

  const setShown = useCallback((next: boolean) => {
    isShown.current = next;
    setShownState(next);
  }, []);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const open = useCallback(
    (target: HTMLElement) => {
      const frame = root.current?.getBoundingClientRect();
      if (!frame) return;
      const box = target.getBoundingClientRect();
      setTip({ label: target.dataset.tip ?? '', center: box.left - frame.left + box.width / 2 });
      setShown(true);
    },
    [root, setShown],
  );

  const reach = useCallback(
    (target: HTMLElement, mode: 'hover' | 'focus') => {
      if (!target.dataset.tip || owner.current === target) return;
      owner.current = target;
      clear();
      const warm = isShown.current || Date.now() - closedAt.current < TIP_GRACE_MS;
      if (mode === 'focus' || warm) open(target);
      else timer.current = setTimeout(() => open(target), TIP_DELAY_MS);
    },
    [clear, open],
  );

  const leave = useCallback(
    (target?: HTMLElement | null) => {
      if (target && owner.current !== target) return;
      owner.current = null;
      clear();
      if (isShown.current) closedAt.current = Date.now();
      setShown(false);
    },
    [clear, setShown],
  );

  useEffect(() => clear, [clear]);

  return { tip, shown, reach, leave };
}
