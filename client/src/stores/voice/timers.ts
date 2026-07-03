/**
 * Pure state-transition helpers for the voice store's periodic timers
 * (local mic analyser and uplink monitor).
 *
 * Decomposed out of voiceStore.ts so the smoothing, hysteresis, and stall
 * classification can be unit tested without live LiveKit tracks or intervals.
 */

/** Exponential moving average used to smooth the local mic volume readings. */
export function smoothVolume(previous: number, raw: number, smoothing = 0.55): number {
  const prev = Number.isFinite(previous) ? previous : 0;
  const sample = Number.isFinite(raw) ? raw : 0;
  const factor = Number.isFinite(smoothing) ? Math.min(1, Math.max(0, smoothing)) : 0.55;
  return prev * factor + sample * (1 - factor);
}

/**
 * Speaking detection with hysteresis: once speaking, stay speaking until the
 * smoothed volume drops below the (lower) off-threshold; once quiet, only
 * become speaking after crossing the (higher) on-threshold. This avoids
 * flicker around a single threshold.
 */
export function computeSpeaking(params: {
  smoothedVolume: number;
  wasSpeaking: boolean;
  locallyMuted: boolean;
  onThreshold: number;
  offThreshold: number;
}): boolean {
  const { smoothedVolume, wasSpeaking, locallyMuted, onThreshold, offThreshold } = params;
  if (locallyMuted) return false;
  return wasSpeaking ? smoothedVolume > offThreshold : smoothedVolume > onThreshold;
}

/**
 * Whether a given consecutive-stall count is one where the uplink monitor
 * should emit a warning (at 2, 4, and 6 stalled intervals). Keeps the noisy
 * logging cadence out of the interval body.
 */
export function isStallWarningInterval(stalledIntervals: number): boolean {
  return stalledIntervals === 2 || stalledIntervals === 4 || stalledIntervals === 6;
}
