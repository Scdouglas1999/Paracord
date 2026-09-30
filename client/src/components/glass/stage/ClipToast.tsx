import type { ClipTarget } from '../../../lib/media/clips/useClip';

/**
 * The clip toast (docs/glass-spec.md §6.4): centered at the top of the stream,
 * 488px, thumbnail, "Saved the last 30 seconds", "From Vincent's screen,
 * 9:14 PM", Post to General (text) and dismiss.
 *
 * STUB (WP-G14). WP-G16 fills it and owns this file. The stage mounts it inside
 * the stream box (chrome over the video, inside the native-surface boundary),
 * with the stream it clips. Where "Post to General" posts (the conversation
 * beside the stage, i.e. the route's channel) is the toast's to decide.
 */
export interface ClipToastProps {
  target: ClipTarget;
}

export function ClipToast(props: ClipToastProps) {
  void props;
  return null;
}
