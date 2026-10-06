# Session recovery: "This server is not available" after a relaunch

Owner report (2026-10-05, desktop build 477020c8): after relaunching, the app
showed "This server is not available." The LAN server was healthy. The
diagnostics log showed `connectServer FAILED ... 401` at launch and then
nothing for 30 minutes.

## Root cause (reproduced)

Reproduced exactly in the release desktop binary (the 477020c8 bundle,
`index-BXGFBhBJ.js`) in a nested KWin session with its own HOME and D-Bus,
against throwaway servers: two saved servers (the first one slow to answer
`/health`, like the owner's `127.0.0.1:8443` entry), signed in to the second,
app closed until the access token had expired, relaunched. Same log lines, same
screen, and the server never saw a refresh request.

1. **The launch refresh never left the machine.** The desktop shell refuses
   every native request to an origin it has not verified yet, and at a cold
   start it has verified none until the first trust sync (a `/health` probe per
   server, in order) finishes. Session bootstrap (`initializeSession`) fires the
   home refresh within milliseconds of boot. With a fast keychain and a slow
   probe, the refresh lost the race:
   `POST /auth/refresh ... ERR_NETWORK "Native fetch target is not in the
   trusted server list"` (captured from the page console).
2. **The refresh coordinator replayed that failure.** It cached every failure
   for 2 s. The saved server's connect met its expired access token a moment
   later (401), joined the same credential's flight and was handed the cached
   refusal, so the connect failed with the original 401.
3. **Nothing retried.** A connect that failed was logged and forgotten: no
   connection was registered, so neither the stream's reconnect loop nor the
   global recovery timer ever ran, and the access token was never refreshed.
4. **The UI said the wrong thing.** The sidebar for the remembered server read
   "This server is not available" for any server it could not see yet.

Found on the way, all in the same family:

- A rotation of the home credential by the home client (settings, account
  pages, the settings retry) updated only the home slot; the saved-server entry
  for the same server kept the retired refresh token and presented it on its
  next refresh. The server reads a spent token as theft and revokes every
  session (`handle_refresh_token_reuse`). This is the likely cause of the
  owner's sign-out at 22:02:47 that evening ("saved server refresh failed 401"
  one minute after a launch).
- The loopback probe (`verifyLocalSessionForServer`, which offers the home
  token to a `127.0.0.1` entry) went through a full API client in the home
  refresh flight: its expected 401 refreshed the *home* credential against the
  other server, and that refusal was then replayed to the real home refresh.
- In the browser, writes to a second saved server carried this page's CSRF
  header; the other server's CORS does not allow it, so its realtime session
  could never be created. Refreshes and the in-app sign-in also carried ambient
  cookies, which the server reads before the body token.

## Fix (client only; no server change, no redeploy)

- `lib/trustedHosts.ts`, `lib/tauriAxiosAdapter.ts`: the adapter waits for the
  launch's first trust sync before its first request (`trustSettled`). Later
  syncs do not hold requests. `main.tsx` includes the stored home URL in the
  boot sync.
- `lib/authRefreshCoordinator.ts`: only a verdict is cached (400/401/403 or no
  refresh credential, `isRefreshVerdict`); a refresh that got no answer is not
  replayed.
- `lib/connectionManager.ts`:
  - per-server state in `stores/serverConnectionStore.ts`: `connecting`,
    `connected` (once READY or RESUMED is applied), `retrying` (with
    `retryAt`), `signed-out` (with `endedHere` when the server refused a
    session this run);
  - a failed connect without a verdict is retried through `connectAll` (which
    re-verifies origins with the shell) with back-off 1, 2, 4 ... 60 s, minus up
    to a fifth of jitter; a refused credential (401/403 on refresh, or no
    refresh credential at all, now `onAuthFailed` too) is `signed-out` and not
    retried; a signed-out server with nothing to sign in with stays signed out
    through later reconciles (no "Connecting" flash);
  - `retryServer(id)` (Try now) and `adoptServerSession(id, token, refresh)`
    (Sign in again: stores the session on the entry, makes it the home session
    when the entry is the home server, connects);
  - the home entry refreshes with the home slot's credential first; the
    loopback probe is a bare request that never refreshes.
- `api/client.ts`: a home rotation is handed to every entry carrying the home
  credential and to `authStore.token`; CSRF only to same-origin writes; a
  refresh with a body token sends no cookies (`refreshRequestOptions`).
- UI:
  - `components/ix/sidebar/ServerUnavailable.tsx` (from `ServerSidebar`):
    "Connecting to <server>…", "Can't reach <server> right now. Trying again."
    with Try now, "You're signed out of <server>." with Sign in again; "This
    server is not available." only once its server is connected and the place
    is still not in your list. The saved server of a place comes from
    `hooks/useGuildServerState.ts` (the server's record, else the last-place
    memory, else the active server).
  - `components/ix/session/`: the signed-out strip in the banner stack (only for
    a session that ended this run, and only while some session is live), the
    Sign in again dialog (password, then the second factor), and
    `ServerSignedOutPage` for main.
  - `pages/GuildPage.tsx`: a place on a saved server that is not connected
    shows the loading page (or the signed-out page), never "This channel is
    gone".
  - `components/ix/people/lastPlace.ts`: the memory also keeps the saved
    server of the place (`serverId`, optional, old memories still read).
    `/app` already waits while the remembered server's account is not
    available, so it never lands on a dead route; a test now says so.
  - `hooks/useFreshRelationships.ts`: waits for the selected server's own
    connection (it toasted "This server is not connected" while another server
    was up).

Files outside this fix's own new files, each a small change: `api/client.ts`,
`lib/connectionManager.ts`, `lib/authRefreshCoordinator.ts`,
`lib/tauriAxiosAdapter.ts`, `lib/trustedHosts.ts`, `main.tsx`,
`lib/AppProviders.tsx` (two mounts), `components/ix/sidebar/ServerSidebar.tsx`
(the unavailable branch), `components/ix/people/{lastPlace,useRememberRoute}.ts`,
`pages/GuildPage.tsx` (one early return), `hooks/useFreshRelationships.ts`,
`playwright.config.ts` (the real-server project's match).

## Verification

- Desktop, nested KWin, release `paracord-desktop` with the fixed bundle served
  as its dev URL: relaunch with an expired token and the slow first server:
  requests waited for the trust sync (~600 ms), the refresh went out and
  succeeded, the remembered channel opened. Server down at launch: "Can't
  reach … Trying again" in the sidebar, reconnected by itself when it came back.
  Restart while running: reconnected. Home session revoked: sign-in screen;
  signing in connected without a restart. Shots in the session scratchpad
  (`rf/desk/shots/`).
- Unit: `lib/connectionManager.reconnect.test.ts` (real connection manager and
  per-server client against a scripted server: silent refresh, the bootstrap's
  unanswered refresh not replayed, retry with back-off on 503 and on
  unreachable, signed out on a refused refresh and with no refresh credential,
  restart, Sign in again, home sign-in, rotation reaching every copy, the probe
  never refreshing), `lib/trustedHosts.test.ts`,
  `lib/authRefreshCoordinator.test.ts`, `lib/serverSignIn.test.ts`,
  `api/client.csrf.test.ts`, `components/ix/sidebar/ServerUnavailable.test.tsx`,
  `components/ix/session/session.test.tsx`, last-place and relationship tests.
- E2E: `e2e/index-connection.spec.ts` (mocked scene plus a scripted second
  server: connecting, retrying with Try now and the silent refresh, signed out
  with the strip, the dialog and the connect after it), shots in
  `output/design-reference/index-build/ixconn/`.
- Real server: `e2e/real-server.session-recovery.spec.ts` (two real servers it
  starts, client from source cross-origin: an expired access token refreshed,
  a restart reconnected, a revoked session signed out, Sign in again
  connected).

## Left open

- The owner's 2-second-window race is closed on the client; the shell still
  replaces its trusted set wholesale on every sync (`update_trusted_server_hosts`),
  so a server that is down during a sync is untrusted until the next one (the
  30 s re-probe while any server is not connected brings it back). Committing
  each origin as it is verified, in Rust, would remove that window.
- A synchronous `getApi()` in an effect throws "This server is not connected"
  into the root error boundary when the selected server has no connection
  (`EventList` `fetchEvents`/`EventsIndicator`; the owner's log shows the root
  boundary catching exactly that at 00:34). With the connection fixed this is
  rare; those call sites should go through a promise.
- Two fresh servers can mint the same snowflake for their first guild; the
  dock keys places by guild id. Not new, seen only in the test.
- The sign-in screen on the desktop can say "Could not reach" for up to 30 s
  after a server that was down at launch comes back (its origin is re-trusted
  on the next re-probe).
