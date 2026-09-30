/**
 * Voice API error helpers, dependency-free so every store and test can use
 * them whatever it mocks.
 */

/**
 * The code a voice route answers with when a channel has listening in turned
 * off (`403 {"code": "LISTEN_IN_DISABLED"}`). The client shows it as it is and
 * never retries the listen as a join: joining is a different thing to do, and
 * only the person may choose it.
 */
export const LISTEN_IN_DISABLED = 'LISTEN_IN_DISABLED';

/** The API error `code` of a failed voice request, or null for anything else. */
export function voiceErrorCode(error: unknown): string | null {
  const data = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data;
  return typeof data?.code === 'string' && data.code ? data.code : null;
}

/** The server's own sentence for a failed voice request, when it sent one. */
export function voiceErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data;
  if (typeof data?.message === 'string' && data.message.trim()) return data.message.trim();
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
