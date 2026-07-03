/**
 * Pure reconnect / retry helpers for the voice connection.
 *
 * Decomposed out of voiceStore.ts so the retry-classification and backoff math
 * can be unit tested without a live LiveKit room.
 */

/**
 * Whether a LiveKit connect failure is transient enough to warrant an
 * immediate retry against the same candidate.
 *
 * Only page-lifecycle interruptions and aborted fetches qualify. Broad
 * patterns like "connection" or "websocket" match every LiveKit failure and
 * would double the total connection time even when every candidate is
 * permanently unreachable.
 */
export function isTransientVoiceConnectError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('interrupted while the page was loading') ||
    normalized.includes('operation was aborted') ||
    normalized.includes('aborted')
  );
}

/**
 * Linear backoff between connect retries for a single candidate.
 *
 * `retryIndex` is 0-based (0 for the first retry after the initial attempt).
 * The delay grows linearly so later retries wait progressively longer while
 * staying bounded and predictable.
 */
export function computeConnectRetryDelayMs(retryIndex: number, baseDelayMs: number): number {
  const safeIndex = Number.isFinite(retryIndex) && retryIndex >= 0 ? Math.floor(retryIndex) : 0;
  const safeBase = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 0;
  return safeBase * (safeIndex + 1);
}
