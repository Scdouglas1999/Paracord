/**
 * One session refresh in flight per credential, ever.
 *
 * The server rotates the refresh token on every `/auth/refresh` and detects
 * reuse: presenting a token that has already been spent is indistinguishable
 * from theft, so it revokes **every** session the account has. That is the
 * correct response to theft and a catastrophic response to a race.
 *
 * Paracord used to race itself. Four call sites refreshed the *same* home
 * credential on their own — the legacy `apiClient` singleton, the per-server
 * axios instance built by `createApiClient()` (one per connection, each with
 * its own guard), `connectionManager.refreshServerSession()`, and session
 * bootstrap. Each had, at best, a single-flight guard scoped to itself, which
 * is no guard at all when the credential is shared: one navigation past the
 * access-token expiry fired three or four concurrent refreshes, the first
 * rotated the token, the rest presented the spent one, and the account was
 * signed out mid-use with no message. That is this module's whole reason to
 * exist.
 *
 * Every refresh of a given credential must go through {@link coordinateRefresh}
 * with the same scope key. Callers get the result — access token and rotated
 * refresh token — and apply it to their own store, so a caller that merely
 * joined someone else's flight still ends up holding the fresh credential.
 */

/** What a refresh yields, whoever performed it. */
export interface SessionRefreshResult {
  token: string;
  refreshToken?: string | null;
}

/**
 * How long a settled refresh answers for later callers.
 *
 * A burst of requests does not 401 simultaneously — they land over tens of
 * milliseconds, and the stragglers reach their interceptor after the winner's
 * refresh has already resolved and cleared the in-flight slot. Without this
 * window each straggler starts its own rotation: not a reuse (the previous one
 * finished) but still a needless burst of `/auth/refresh` against the server,
 * and a wider window for the next race. A freshly minted access token is good
 * for minutes, so handing the same one to everyone who asks within a couple of
 * seconds is always correct.
 *
 * Failures are cached for the same window for the same reason: once the server
 * has said "this session is gone", twenty more requests asking again in the
 * same second learn nothing and cost the user twenty error log lines.
 */
const REFRESH_SETTLE_WINDOW_MS = 2_000;

interface SettledRefresh {
  at: number;
  result?: SessionRefreshResult;
  error?: unknown;
}

const inFlight = new Map<string, Promise<SessionRefreshResult>>();
const settled = new Map<string, SettledRefresh>();

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function takeFreshSettled(scopeKey: string): SettledRefresh | null {
  const entry = settled.get(scopeKey);
  if (!entry) return null;
  if (now() - entry.at > REFRESH_SETTLE_WINDOW_MS) {
    settled.delete(scopeKey);
    return null;
  }
  return entry;
}

/**
 * Run `perform` at most once per credential at a time, and at most once per
 * {@link REFRESH_SETTLE_WINDOW_MS} after it settles.
 *
 * `scopeKey` identifies the *credential*, not the axios instance or the URL:
 * two clients that draw on the same stored refresh token must pass the same
 * key, and two clients holding genuinely separate sessions must not.
 *
 * `perform` must read the current refresh token when it runs, never a value
 * captured earlier — a token captured before someone else's rotation is
 * exactly the stale credential that trips reuse detection.
 */
export function coordinateRefresh(
  scopeKey: string,
  perform: () => Promise<SessionRefreshResult>,
): Promise<SessionRefreshResult> {
  const recent = takeFreshSettled(scopeKey);
  if (recent) {
    return recent.error !== undefined
      ? Promise.reject(recent.error)
      : Promise.resolve(recent.result as SessionRefreshResult);
  }

  const existing = inFlight.get(scopeKey);
  if (existing) return existing;

  const flight = (async () => perform())()
    .then(
      (result) => {
        settled.set(scopeKey, { at: now(), result });
        return result;
      },
      (error: unknown) => {
        settled.set(scopeKey, { at: now(), error });
        throw error;
      },
    )
    .finally(() => {
      if (inFlight.get(scopeKey) === flight) inFlight.delete(scopeKey);
    });

  inFlight.set(scopeKey, flight);
  return flight;
}

/**
 * Forget everything remembered about a credential.
 *
 * Called when a session is deliberately replaced — sign-in, sign-out, an
 * account switch — so the next refresh is not answered from the settle window
 * of the session that just ended.
 */
export function resetRefreshCoordination(scopeKey?: string): void {
  if (scopeKey) {
    inFlight.delete(scopeKey);
    settled.delete(scopeKey);
    return;
  }
  inFlight.clear();
  settled.clear();
}

/** The credential scope of the home/local session, shared by every client that speaks for it. */
export const HOME_REFRESH_SCOPE = 'auth:home';

/** The credential scope of a saved server that holds its own session. */
export function serverRefreshScope(serverId: string): string {
  return `auth:server:${serverId}`;
}
