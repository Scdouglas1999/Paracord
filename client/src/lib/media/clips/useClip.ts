/**
 * Clips (docs/glass-spec.md §6.4): "Clip saves the last 30 seconds of the
 * stream you're watching without interrupting anything."
 *
 * STUB (WP-G14). The signature is the contract the stage's Clip button and the
 * C key use; WP-G16 fills it (the 30 second ring buffer at the decoder intake,
 * the muxer, the upload) and owns this file from then on. Until then a clip is
 * honestly unavailable: `available` is false with a sentence that says so, and
 * `clip()` rejects with that sentence. Nothing pretends to save.
 */

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

const NOT_YET = 'Clips are not available in this version yet.';

const UNAVAILABLE: ClipControl = {
  available: false,
  unavailableReason: NOT_YET,
  saving: false,
  clip: () => Promise.reject(new Error(NOT_YET)),
};

/** The Clip control for the stream on the stage, or for nothing (`null`). */
export function useClip(target: ClipTarget | null): ClipControl {
  void target;
  return UNAVAILABLE;
}
