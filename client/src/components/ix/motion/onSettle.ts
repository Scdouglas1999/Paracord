/**
 * Settling (docs/index-spec.md §5: "Animations are canceled and committed if a
 * newer event of the same kind starts (no queueing)").
 *
 * Every Index moment is a handful of Web Animations followed by one cleanup:
 * remove the pane that slid out, drop the tint layer that was faded over, take
 * the poster off a native surface. `onSettle` runs that cleanup exactly once,
 * when all of them have finished OR been canceled, so a moment that is cut short
 * by a newer one still cleans up. `commit` is how the newer one cuts it short:
 * it jumps each running animation to its end state (which settles it).
 */

type Maybe<T> = T | null | undefined;

/**
 * Run `done` once every animation has finished or been canceled. With nothing
 * to wait for (`[]`, or only nulls: reduced motion, jsdom, an element that was
 * gone) `done` runs synchronously. Returns a disposer that stops `done` from
 * running (call it on unmount when the cleanup would touch unmounted state).
 */
export function onSettle(animations: ReadonlyArray<Maybe<Animation>>, done: () => void): () => void {
  const live = animations.filter((animation): animation is Animation => animation != null);
  let disposed = false;
  if (live.length === 0) {
    done();
    return () => {};
  }
  let pending = live.length;
  const settleOne = () => {
    pending -= 1;
    if (pending === 0 && !disposed) {
      disposed = true;
      done();
    }
  };
  for (const animation of live) {
    // `finished` resolves on finish and rejects (AbortError) on cancel: both settle.
    animation.finished.then(settleOne, settleOne);
  }
  return () => {
    disposed = true;
  };
}

/**
 * Commit running animations: jump each to its end state now. Their `finished`
 * promises resolve, so any `onSettle` cleanup waiting on them runs. Used when a
 * newer event of the same kind starts (a second dock click mid-slide).
 */
export function commit(animations: ReadonlyArray<Maybe<Animation>>): void {
  for (const animation of animations) {
    if (!animation) continue;
    try {
      animation.finish();
    } catch {
      // An animation that cannot finish (no end: infinite iterations) is canceled.
      animation.cancel();
    }
  }
}
