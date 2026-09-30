/**
 * Home's words (docs/lantern-stage-spec.md §6.9, §7.5, §9).
 *
 * Every count and every state on Home has a sentence here, so light is never
 * the only cue and two rows can never word the same fact differently. The
 * shared vocabulary lives in `lib/attention/lightCaptions.ts` (WP1) — this file
 * only adds the phrases §7.5 asks for and nothing else invents.
 *
 * Pure strings. No React, no stores.
 */

/** "1 mention for you" / "3 mentions for you" (§7.5, a server's text channels). */
export function mentionCaption(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return `${n} mention${n === 1 ? '' : 's'} for you`;
}

/**
 * For-you empty states distinguish a checked inbox from an unknown answer.
 */
export const NEEDS_YOU_QUIET = {
  ready: 'Nothing new for you right now.',
  loading: 'Checking for new messages…',
  error: 'Some activity could not be checked — refresh to try again.',
} as const;
