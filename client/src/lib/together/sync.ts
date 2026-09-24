/**
 * Drift correction: every second, each client compares its player with where
 * the server says playback is, and corrects.
 *
 *   |drift| > 1.5 s                  → seek (any player)
 *   0.25 s ≤ |drift| ≤ 1.5 s         → `<video>`/`<audio>`: nudge playbackRate to
 *                                      0.97 / 1.03 until within 0.1 s
 *   YouTube                          → seek only past 1.5 s (its rate steps are
 *                                      too coarse to nudge with)
 *
 * A client that stalls (buffering) simply falls behind and is seeked forward:
 * nobody else waits for it.
 */

export const SEEK_THRESHOLD_MS = 1500;
export const NUDGE_START_MS = 250;
export const NUDGE_STOP_MS = 100;
export const NUDGE_SLOW = 0.97;
export const NUDGE_FAST = 1.03;
/** Do not seek again this soon after a seek: the player is still landing. */
export const SEEK_SETTLE_MS = 2000;

export type PlayerKind = 'element' | 'youtube';

export type Correction =
  | { kind: 'none'; rate: number }
  | { kind: 'rate'; rate: number }
  | { kind: 'seek'; toMs: number; rate: number };

export interface CorrectionInput {
  expectedMs: number;
  actualMs: number;
  /** The player's playbackRate right now (1 unless we are nudging). */
  currentRate: number;
  player: PlayerKind;
  /** The session's rate; always 1 today. */
  baseRate?: number;
  /** ms since this client last seeked, or null if never. */
  sinceLastSeekMs?: number | null;
}

export function decideCorrection({
  expectedMs,
  actualMs,
  currentRate,
  player,
  baseRate = 1,
  sinceLastSeekMs = null,
}: CorrectionInput): Correction {
  const drift = actualMs - expectedMs; // > 0: we are ahead
  const magnitude = Math.abs(drift);

  if (magnitude > SEEK_THRESHOLD_MS) {
    if (sinceLastSeekMs != null && sinceLastSeekMs < SEEK_SETTLE_MS) {
      return { kind: 'none', rate: baseRate };
    }
    return { kind: 'seek', toMs: expectedMs, rate: baseRate };
  }
  if (player === 'youtube') return { kind: 'none', rate: baseRate };

  const nudging = Math.abs(currentRate - baseRate) > 1e-6;
  if (nudging) {
    if (magnitude < NUDGE_STOP_MS) return { kind: 'rate', rate: baseRate };
    return { kind: 'rate', rate: baseRate * (drift > 0 ? NUDGE_SLOW : NUDGE_FAST) };
  }
  if (magnitude >= NUDGE_START_MS) {
    return { kind: 'rate', rate: baseRate * (drift > 0 ? NUDGE_SLOW : NUDGE_FAST) };
  }
  return { kind: 'none', rate: baseRate };
}
