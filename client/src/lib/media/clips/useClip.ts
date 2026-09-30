/**
 * Clips (docs/glass-spec.md §6.4): "Clip saves the last 30 seconds of the
 * stream you're watching without interrupting anything."
 *
 * `useClip(target)` is the Clip button's contract (the stage's controls), and
 * `triggerClip()` is the same action for the C key (`useGlassKeybinds`). The
 * ring, the muxer and the upload are in `clipStore.ts` and the modules it
 * names.
 *
 * Available means a clip can be cut now: this client is watching the target's
 * stream and its ring is armed. It is not available for your own share ("You
 * can clip other people's streams, not your own."), while the watch is still
 * connecting ("Waiting for Vincent's screen."), or when the ring could not
 * start (its error, verbatim).
 */
import { useEffect } from 'react';
import { toast } from '../../../stores/toastStore';
import { screenSourceName } from './clipFilename';
import { saveClip, startClipLifecycle, useClipStore, type ClipStoreState } from './clipStore';

/** The stream a clip is cut from: the watch's target, plus whose screen it is for the toast. */
export interface ClipTarget {
  /** The instance (AccountScope.serverId) whose relay carries the stream. */
  serverId: string;
  guildId: string;
  channelId: string;
  streamerId: string;
  /** "Vincent": for "From Vincent's screen, 9:14 PM". */
  streamerName: string;
}

export interface ClipControl {
  /** A clip can be cut from this stream now. */
  available: boolean;
  /** Why not, in a sentence for the button's tooltip; null when available. */
  unavailableReason: string | null;
  /** A clip is being cut or saved. */
  saving: boolean;
  /**
   * Save the last 30 seconds. Resolves when the clip is saved (the toast then
   * offers "Post to General"); rejects with the reason when it cannot be.
   */
  clip: () => Promise<void>;
}

export const CLIP_SECONDS = 30;

const NOTHING_ON_STAGE = 'Nothing is on the stage to clip.';

function unavailableReason(state: Pick<ClipStoreState, 'armed' | 'blocked' | 'armError'>, target: ClipTarget | null): string | null {
  if (!target) return NOTHING_ON_STAGE;
  if (state.blocked === 'own-stream') return "You can clip other people's streams, not your own.";
  if (state.blocked === 'error') return state.armError ?? 'Clips cannot start.';
  if (!state.armed || state.armed.streamerId !== target.streamerId) return `Waiting for ${screenSourceName(target.streamerName)}.`;
  return null;
}

/**
 * The targets the mounted Clip controls and toasts show (the stage mounts
 * both), newest last: the C key clips the newest.
 */
const registered: ClipTarget[] = [];
const stageTarget = (): ClipTarget | null => registered[registered.length - 1] ?? null;

/** The Clip control for the stream on the stage, or for nothing (`null`). */
export function useClip(target: ClipTarget | null): ClipControl {
  useEffect(() => startClipLifecycle(), []);

  const serverId = target?.serverId;
  const guildId = target?.guildId;
  const channelId = target?.channelId;
  const streamerId = target?.streamerId;
  const streamerName = target?.streamerName;
  useEffect(() => {
    if (!serverId || !guildId || !channelId || !streamerId || streamerName === undefined) return;
    const entry: ClipTarget = { serverId, guildId, channelId, streamerId, streamerName };
    registered.push(entry);
    return () => {
      const at = registered.indexOf(entry);
      if (at >= 0) registered.splice(at, 1);
    };
  }, [serverId, guildId, channelId, streamerId, streamerName]);

  const armed = useClipStore((state) => state.armed);
  const blocked = useClipStore((state) => state.blocked);
  const armError = useClipStore((state) => state.armError);
  const saving = useClipStore((state) => state.saving);
  const reason = unavailableReason({ armed, blocked, armError }, target);

  return {
    available: reason === null,
    unavailableReason: reason,
    saving,
    clip: () => {
      const why = unavailableReason(useClipStore.getState(), target);
      if (why) return Promise.reject(new Error(why));
      return saveClip(target!);
    },
  };
}

/**
 * Clip the stream on the stage, as the C key does: the same as pressing Clip.
 * What goes wrong is said in a toast; the promise never rejects. With nothing
 * on the stage it does nothing and resolves `false`.
 *
 * For `useGlassKeybinds` (WP-G15): call it on C when the stage is open and the
 * key is not someone else's (typing, a menu or a dialog).
 */
export async function triggerClip(): Promise<boolean> {
  const target = stageTarget();
  if (!target) return false;
  const why = unavailableReason(useClipStore.getState(), target);
  if (why) {
    toast.info(why);
    return true;
  }
  try {
    await saveClip(target);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'The clip could not be saved.');
  }
  return true;
}
