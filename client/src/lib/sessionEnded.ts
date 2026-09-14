/**
 * Why the user is looking at a sign-in screen they did not ask for.
 *
 * A session can end under the user mid-sentence — the server revoked it, an
 * admin signed every device out, the refresh token expired. Paracord used to
 * answer that by emptying itself: "Unknown user", no buildings, a red
 * "Connection lost — retrying automatically" bar above a shell retrying a
 * refresh that would never succeed. The app knew exactly what had happened and
 * said none of it.
 *
 * Whoever tears a session down records the reason here; the sign-in screen
 * reads it once and says it. It is kept in `sessionStorage` so a reload on the
 * way to the login route does not lose the sentence, and it carries no
 * credential — only a message meant for a human.
 */

const NOTICE_KEY = 'paracord:auth:session-ended';

/** Survives a reload; falls back to a module value when storage is unavailable. */
let inMemoryNotice: string | null = null;

export function noteSessionEnded(message: string): void {
  inMemoryNotice = message;
  try {
    sessionStorage.setItem(NOTICE_KEY, message);
  } catch {
    // Private mode / storage disabled: the in-memory copy still serves this tab.
  }
}

/** Read the notice without consuming it. */
export function peekSessionEndedNotice(): string | null {
  if (inMemoryNotice) return inMemoryNotice;
  try {
    return sessionStorage.getItem(NOTICE_KEY);
  } catch {
    return null;
  }
}

/** Read the notice and forget it, so it is shown once and not on every later visit. */
export function takeSessionEndedNotice(): string | null {
  const notice = peekSessionEndedNotice();
  clearSessionEndedNotice();
  return notice;
}

export function clearSessionEndedNotice(): void {
  inMemoryNotice = null;
  try {
    sessionStorage.removeItem(NOTICE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The message shown when the server says the session no longer exists. */
export const SESSION_REVOKED_MESSAGE =
  'Your session ended on the instance, so Paracord signed you out. Sign in again to pick up where you left off.';
