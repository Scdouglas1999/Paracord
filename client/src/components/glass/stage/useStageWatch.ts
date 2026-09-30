import { useCallback, useEffect, useRef } from 'react';

import { useGlassStore, type StageTarget, type StreamStageTarget } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { MediaViewState } from '../../../stores/voice/viewSessions';
import { voiceGuildOf } from '../pill/pillActions';

/**
 * The stage owns the watch (docs/design/glass-g6-checkpoint.md, "How to use it,
 * G14"; docs/design/glass-g12-checkpoint.md, "For the next packages").
 *
 *   open      `startWatch(target)`: the stream's video and its own audio, never
 *             the voices, counted for everyone. Without the call it is its own
 *             view session; in the call it rides the call. Watching never joins.
 *   switch    another target (a click on another sharer's tile) is `startWatch`
 *             again: the store replaces the running watch. No stop in between.
 *   close     `stopWatch()` once the stage is closed. It never leaves the call.
 *
 * The stop is tied to the stage being CLOSED (`glassStore.stage.mode === 'none'`)
 * rather than to this component unmounting, so React's development double mount
 * (and any remount that keeps the stage open) never tears a watch down.
 *
 * Nothing here clears a watch on a timer. The Lantern stage's 1.2s auto-clear
 * dropped a watch whose join took longer than that (docs/design/glass-fix-rejoin.md,
 * Bug 2 cause 2). A connecting watch is "not yet"; an ended or failed one stays
 * down with its reason until the person asks again (the store never retries).
 */

export function targetKey(target: StageTarget): string {
  return `${target.serverId}:${target.guildId}:${target.channelId}:${target.streamerId}`;
}

/** Start the watch for `target`; errors land in `watchView` (phase `failed`), so the promise is only observed. */
function start(target: StreamStageTarget): void {
  void useVoiceStore
    .getState()
    .startWatch({ serverId: target.serverId, guildId: voiceGuildOf(target.guildId), channelId: target.channelId, streamerId: target.streamerId })
    .catch(() => {});
}

export function useStageWatch(target: StreamStageTarget): { view: MediaViewState | null; watchAgain: () => void } {
  const key = targetKey(target);
  // The target object is rebuilt on every frame render; the key says when it changed.
  const latest = useRef(target);
  useEffect(() => {
    latest.current = target;
  });

  useEffect(() => {
    const current = latest.current;
    start(current);
    void useVoiceStore.getState().fetchWatchers({ serverId: current.serverId, channelId: current.channelId }).catch(() => {});
  }, [key]);

  // Stop when the stage closes. Checked after the unmount, so a remount that
  // keeps the stage open (StrictMode, a layout change) keeps the watch.
  useEffect(
    () => () => {
      if (useGlassStore.getState().stage.mode === 'none') void useVoiceStore.getState().stopWatch();
    },
    [],
  );

  const view = useVoiceStore((state) => {
    const watch = state.watchView;
    if (!watch) return null;
    return watch.channelId === target.channelId && watch.streamerId === target.streamerId ? watch : null;
  });

  const watchAgain = useCallback(() => start(latest.current), []);

  return { view, watchAgain };
}

/** "Stop watching" (and Esc): close the stage; the watch stops with it. Never leaves the call. */
export function stopWatching(): void {
  useGlassStore.getState().closeStage();
  void useVoiceStore.getState().stopWatch();
}
