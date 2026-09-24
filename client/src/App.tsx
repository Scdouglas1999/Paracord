import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router';
import { AppMark } from './components/brand/AppMark';
import { BrandSplash } from './components/brand/BrandSplash';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ServerConnectPage } from './pages/ServerConnectPage';
import { AccountSetupPage } from './pages/AccountSetupPage';
import { InstanceSetupPage } from './pages/InstanceSetupPage';
import { AccountUnlockPage } from './pages/AccountUnlockPage';
import { AccountRecoverPage } from './pages/AccountRecoverPage';
import { TermsPage } from './pages/TermsPage';
import { PrivacyPage } from './pages/PrivacyPage';

// Lazy-loaded route surfaces keep the initial auth/server bootstrap bundle small.
const AppShell = lazy(() => import('./pages/AppShell').then(m => ({ default: m.AppShell })));
const HomePage = lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const GuildHomePage = lazy(() => import('./pages/GuildHomePage').then(m => ({ default: m.GuildHomePage })));
const GuildPage = lazy(() => import('./pages/GuildPage').then(m => ({ default: m.GuildPage })));
const GuildSettingsPage = lazy(() => import('./pages/GuildSettingsPage').then(m => ({ default: m.GuildSettingsPage })));
const GuildSportsPage = lazy(() => import('./pages/GuildSportsPage').then(m => ({ default: m.GuildSportsPage })));
const GuildSportsGamePage = lazy(() => import('./pages/GuildSportsGamePage').then(m => ({ default: m.GuildSportsGamePage })));
const GuildDailyWordPage = lazy(() => import('./pages/GuildDailyWordPage').then(m => ({ default: m.GuildDailyWordPage })));
const DMPage = lazy(() => import('./pages/DMPage').then(m => ({ default: m.DMPage })));
const FriendsPage = lazy(() => import('./pages/FriendsPage').then(m => ({ default: m.FriendsPage })));
const InvitePage = lazy(() => import('./pages/InvitePage').then(m => ({ default: m.InvitePage })));
const BotAuthorizePage = lazy(() => import('./pages/BotAuthorizePage').then(m => ({ default: m.BotAuthorizePage })));
const AdminPage = lazy(() => import('./pages/AdminPage').then(m => ({ default: m.AdminPage })));
const DiscoveryPage = lazy(() => import('./pages/DiscoveryPage').then(m => ({ default: m.DiscoveryPage })));
const DeveloperPage = lazy(() => import('./pages/DeveloperPage').then(m => ({ default: m.DeveloperPage })));
const TemplateGalleryPage = lazy(() => import('./pages/TemplateGalleryPage').then(m => ({ default: m.TemplateGalleryPage })));
// Internal media engine harness — dev builds only. The ternary folds to `null`
// in production (import.meta.env.DEV is statically false), so Rollup drops the
// dynamic import and the harness never ships to end users.
const MediaTest = import.meta.env.DEV ? lazy(() => import('./pages/MediaTest')) : null;
// The design-system reference page (docs/lantern-stage-spec.md made visible).
// Dev builds only, by the same fold-to-null trick as the media harness.
const DesignTokensPage = import.meta.env.DEV
  ? lazy(() => import('./pages/DesignTokensPage'))
  : null;
// The Stage, at full size, from fixture models — the WP3 screenshot gate
// (docs/design/wp3-checkpoint.md). Dev builds only, same fold-to-null.
const StagePreviewPage = import.meta.env.DEV
  ? lazy(() => import('./pages/StagePreviewPage'))
  : null;
import { ErrorBoundary } from './components/ErrorBoundary';
import { Button } from './components/ui/Button';
import { gateway } from './gateway/manager';
import { useAccountStore } from './stores/accountStore';
import { useServerListStore } from './stores/serverListStore';
import { useAuthStore } from './stores/authStore';
import { hasAccount } from './lib/account';
import { getStoredServerUrl, resolveApiBaseUrl, resolveServerRootUrl } from './lib/config/apiBaseUrl';
import { isTauri } from './lib/tauriEnv';

/**
 * Checks whether we need a server URL configured before proceeding.
 * Now also considers the multi-server server list.
 */
function useServerStatus() {
  const servers = useServerListStore((s) => s.servers);
  const [status, setStatus] = useState<'loading' | 'ready' | 'needed'>(() => {
    if (servers.length > 0) return 'ready';
    if (getStoredServerUrl()) return 'ready';
    if (import.meta.env.VITE_API_URL || import.meta.env.VITE_WS_URL) return 'ready';
    return 'loading';
  });

  useEffect(() => {
    if (status !== 'loading') return;

    // Under Tauri the app is served from a local bundle (tauri://localhost), so
    // a same-origin `/health` probe would target the desktop shell rather than a
    // Paracord server. Resolve the API base first; when it is only the relative
    // fallback there is no server origin to probe, so require an explicit connect.
    const base = resolveApiBaseUrl();
    if (isTauri() && !base.startsWith('http')) {
      setStatus('needed');
      return;
    }
    const healthUrl = resolveServerRootUrl('/health');

    let cancelled = false;
    fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.service === 'paracord' || data?.status === 'ok') {
          setStatus('ready');
        } else {
          setStatus('needed');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('needed');
      });

    return () => {
      cancelled = true;
    };
  }, [status]);

  return status;
}

function hasHydratedServerSession(servers: Array<{ token?: string | null; refreshToken?: string | null }>): boolean {
  return servers.some((server) => Boolean(server.token || server.refreshToken));
}

/** Where the crypto-auth flow should send the user, or `null` to let them in. */
export type CryptoAuthRedirect = '/setup' | '/unlock' | '/login' | '/connect' | null;

/**
 * Pure decision for the optional device-key ("crypto auth") flow.
 * Returns the path to redirect to, or `null` when the user may proceed.
 */
export function resolveCryptoAuthRedirect(params: {
  hasAccount: boolean;
  isUnlocked: boolean;
  hasServers: boolean;
  hasToken: boolean;
  serverReady: boolean;
}): CryptoAuthRedirect {
  const { hasAccount, isUnlocked, hasServers, hasToken, serverReady } = params;
  if (!hasAccount) return '/setup';
  if (!isUnlocked) return '/unlock';
  if (hasServers || (hasToken && serverReady)) return null;
  if (!hasToken) return '/login';
  return '/connect';
}

/**
 * Route guard for the main app.
 *
 * Default mode is username/password auth. Device key unlock is only enforced
 * when the user has explicitly enabled crypto auth in server-side account settings.
 */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isUnlocked = useAccountStore((s) => s.isUnlocked);
  const servers = useServerListStore((s) => s.servers);
  const tokensHydrated = useServerListStore((s) => s.tokensHydrated);
  const token = useAuthStore((s) => s.token);
  const sessionBootstrapComplete = useAuthStore((s) => s.sessionBootstrapComplete);
  const settings = useAuthStore((s) => s.settings);
  const hasFetchedSettings = useAuthStore((s) => s.hasFetchedSettings);
  const settingsUnavailable = useAuthStore((s) => s.settingsUnavailable);
  const fetchSettings = useAuthStore((s) => s.fetchSettings);
  const serverStatus = useServerStatus();
  const hasServerSession = tokensHydrated && hasHydratedServerSession(servers);
  const hasSession = Boolean(token || hasServerSession);
  /**
   * Is the device-key gate on? Unknown must fail closed.
   *
   * `crypto_auth_enabled` is a security control, and the two ways this app had
   * of not knowing its value both read as "off": a settings GET that 401'd was
   * recorded as a completed fetch, and a session held only by a server-list
   * entry (no home token) never triggered a fetch at all. Either way an account
   * that had asked for device-key sign-in walked straight into the app with no
   * unlock prompt, and nothing said so.
   *
   * With no answer, an enrolled device identity decides — it is the credential
   * this feature exists to enforce, and the only one readable without a
   * session. A device that has no identity has nothing to unlock, so gating it
   * would lock the account out with no way back in; that case stays on the
   * password path, which is where it already was.
   */
  const cryptoAuthEnabled = hasFetchedSettings
    ? settings?.crypto_auth_enabled === true
    : hasSession && hasAccount();

  useEffect(() => {
    if (hasSession && !hasFetchedSettings) {
      void fetchSettings();
    }
  }, [hasSession, hasFetchedSettings, fetchSettings]);

  // A failed read is retried rather than accepted: the gate above is holding
  // the door shut on a guess until the instance answers for itself.
  useEffect(() => {
    if (!hasSession || hasFetchedSettings || !settingsUnavailable) return;
    const timer = window.setInterval(() => {
      void useAuthStore.getState().fetchSettings();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [hasSession, hasFetchedSettings, settingsUnavailable]);

  if (!sessionBootstrapComplete || (servers.length > 0 && !tokensHydrated)) {
    return <BrandSplash label="Restoring session..." />;
  }

  if (serverStatus === 'loading') {
    return <BrandSplash label="Connecting..." />;
  }

  // Wait for the first answer, but only while one is still coming. Once the
  // read has failed, the fail-closed default above decides rather than leaving
  // an unreachable instance holding the app on a splash screen forever.
  if (hasSession && !hasFetchedSettings && !settingsUnavailable) {
    return <BrandSplash label="Loading account settings..." />;
  }

  // Optional crypto-auth mode (server-controlled, default false).
  if (cryptoAuthEnabled) {
    const target = resolveCryptoAuthRedirect({
      hasAccount: hasAccount(),
      isUnlocked,
      hasServers: servers.length > 0,
      hasToken: Boolean(token || hasServerSession),
      serverReady: serverStatus === 'ready',
    });
    return target ? <GuardRedirect to={target} /> : <>{children}</>;
  }

  // Password mode: a valid local token or a hydrated per-server session can enter directly.
  if ((token || hasServerSession) && serverStatus === 'ready') {
    return <>{children}</>;
  }

  // Password mode without token.
  if (serverStatus === 'needed') {
    return <GuardRedirect to="/connect" />;
  }

  // A device identity is a credential in its own right, and the only one this
  // app can read before it has a session: `crypto_auth_enabled` lives in
  // account settings, which need the very token we are missing. So an enrolled
  // identity decides. Locked, the way back in is its unlock password — not the
  // server password the feature exists to replace. Unlocked, the gateway is
  // signing the server's challenge right now and a session is moments away.
  if (hasAccount()) {
    if (!isUnlocked) return <GuardRedirect to="/unlock" />;
    return <DeviceKeySignIn />;
  }
  return <GuardRedirect to="/login" />;
}

export function AuthRoute({ children }: { children: React.ReactNode }) {
  const serverStatus = useServerStatus();
  const servers = useServerListStore((s) => s.servers);
  const tokensHydrated = useServerListStore((s) => s.tokensHydrated);
  const sessionBootstrapComplete = useAuthStore((s) => s.sessionBootstrapComplete);
  const token = useAuthStore((s) => s.token);
  const hasServerSession = tokensHydrated && hasHydratedServerSession(servers);

  if (!sessionBootstrapComplete || (servers.length > 0 && !tokensHydrated)) {
    return <BrandSplash label="Restoring session..." />;
  }

  if (serverStatus === 'loading') {
    return <BrandSplash label="Connecting..." />;
  }

  if (serverStatus === 'needed') {
    return <GuardRedirect to="/connect" />;
  }

  // Already authenticated: don't show the login/register forms.
  if ((token || hasServerSession) && serverStatus === 'ready') {
    return <GuardRedirect to="/app" />;
  }

  return <>{children}</>;
}

/**
 * In-shell fallback while a lazily-loaded route surface streams in. Sits inside
 * the already-painted frame, so it stays quiet: just the mark, gently fading.
 */
function LazyFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="pc-mark-breathe">
        <AppMark size={32} />
      </div>
    </div>
  );
}

/**
 * Every lazily-loaded route surface gets its own boundary.
 *
 * The app previously had exactly one ErrorBoundary, at the root in `main.tsx`.
 * Any render throw anywhere therefore replaced the ENTIRE UI with the recovery
 * screen and dropped all in-memory state — an unrecoverable page-level failure
 * for what was often a single bad row. Per-route boundaries keep the shell,
 * the sidebar and the gateway connection alive while one surface recovers.
 */
function lazyRoute(children: React.ReactNode) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LazyFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/** Same per-route isolation for the eagerly-imported auth/legal surfaces. */
function route(children: React.ReactNode) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

/**
 * This device holds an unlocked identity but the server has not issued a
 * session yet — the gateway is in the middle of challenge-response. Wait for
 * it, visibly; and if it never arrives, say so and offer the password instead
 * of spinning forever.
 */
function DeviceKeySignIn() {
  const [slow, setSlow] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, []);

  if (!slow) return <BrandSplash label="Signing in with this device's key..." />;

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-5 bg-bg-base px-6">
      <div className="flex w-full max-w-md flex-col items-start gap-4">
        <AppMark size={40} />
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-heading text-text-primary">
            This device could not sign in with its key
          </h1>
          <p className="text-label leading-relaxed text-text-secondary">
            Your identity is unlocked, but the instance has not accepted it. The instance may be
            unreachable, or this account may not have this device's key attached to it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setSlow(false);
              void gateway.syncServers().catch(() => undefined);
            }}
          >
            Try again
          </Button>
          <Button variant="secondary" onClick={() => navigate('/login', { replace: true })}>
            Use your password
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Guard redirects that bounce between two screens would spin forever. Count
 * them across mounts so a ping-pong is recognised and stopped rather than run
 * silently at full speed.
 */
let recentGuardRedirects: number[] = [];
function noteGuardRedirect(): boolean {
  const now = Date.now();
  recentGuardRedirects = recentGuardRedirects.filter((at) => now - at < 4_000);
  recentGuardRedirects.push(now);
  return recentGuardRedirects.length <= 8;
}

/**
 * A route guard's redirect — idempotent, and it always paints something.
 *
 * `<Navigate>` renders `null` and fires its navigation once, from an effect
 * whose dependencies are its own props. That is a blank window waiting to
 * happen: if anything else navigates while the redirect is in flight — the
 * sign-in handler's own `navigate('/app')`, arriving after its `await` and
 * after this guard had already sent the account to `/setup` — the router lands
 * back on the guarded path, the guard renders the very same `<Navigate>`, and
 * its effect never runs again because nothing about it changed. The redirect is
 * lost, `null` is all that is left on screen, and there is no way out of the
 * app from inside it.
 *
 * So: re-issue the redirect until the router actually arrives, show a real
 * loading surface while it does, and if the destination never takes, say so and
 * offer a way out instead of a black rectangle.
 */
function GuardRedirect({ to }: { to: CryptoAuthRedirect | '/app' }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (!to || pathname === to) return;
    let attempts = 0;
    // Declared before `attempt` so the very first, synchronous call can clear it
    // — the loop guard can trip on that call, and reading a `const` declared
    // below would throw out of the effect instead.
    let timer = 0;
    const attempt = () => {
      if (!noteGuardRedirect() || attempts >= 5) {
        window.clearInterval(timer);
        setStalled(true);
        return;
      }
      attempts += 1;
      navigate(to, { replace: true });
    };
    attempt();
    timer = window.setInterval(attempt, 700);
    return () => window.clearInterval(timer);
  }, [to, pathname, navigate]);

  if (stalled) return <GuardStalled to={to} />;
  return <BrandSplash label="Just a moment..." />;
}

/**
 * Shown when a guard's redirect never lands. Whatever the state of the app, the
 * person gets a screen that names the problem and two things they can press.
 */
function GuardStalled({ to }: { to: CryptoAuthRedirect | '/app' }) {
  const navigate = useNavigate();
  const destination =
    to === '/setup' ? 'the device setup screen'
    : to === '/unlock' ? 'the unlock screen'
    : to === '/connect' ? 'the instance screen'
    : to === '/login' ? 'the sign-in screen'
    : 'the app';
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-5 bg-bg-base px-6">
      <div className="flex w-full max-w-md flex-col items-start gap-4">
        <AppMark size={40} />
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-heading text-text-primary">Paracord could not open {destination}</h1>
          <p className="text-label leading-relaxed text-text-secondary">
            Your sign-in worked, but this device could not move on to the next screen.
            Try again, or sign out and start over.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              recentGuardRedirects = [];
              if (to) navigate(to, { replace: true });
            }}
          >
            Try again
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              recentGuardRedirects = [];
              void useAuthStore.getState().logout().finally(() => navigate('/login', { replace: true }));
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Optional device crypto identity */}
      <Route path="/setup" element={route(<AccountSetupPage />)} />
      <Route path="/unlock" element={route(<AccountUnlockPage />)} />
      <Route path="/recover" element={route(<AccountRecoverPage />)} />
      {/* Legacy unlock-screen link; import lives in User settings → Identity. */}
      <Route path="/import" element={<Navigate to="/app?settings=identity" replace />} />

      {/* Server connection */}
      <Route path="/connect" element={route(<ServerConnectPage />)} />

      {/* First-owner claim. `/setup` above is the per-device crypto identity;
          this is the server itself getting an owner for the first time. */}
      <Route path="/setup-server" element={route(<InstanceSetupPage />)} />

      {/* Password auth */}
      <Route path="/login" element={route(<AuthRoute><LoginPage /></AuthRoute>)} />
      <Route path="/register" element={route(<AuthRoute><RegisterPage /></AuthRoute>)} />

      {/* Invites, legal */}
      <Route path="/invite/:code" element={lazyRoute(<InvitePage />)} />
      <Route path="/terms" element={route(<TermsPage />)} />
      <Route path="/privacy" element={route(<PrivacyPage />)} />

      {/* Main app */}
      {/* The shell's own chunk loads behind the loading screen's final frame:
          there is no shell yet for the quiet in-shell fallback to sit in. */}
      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <ErrorBoundary>
              <Suspense fallback={<BrandSplash label="Loading..." />}>
                <AppShell />
              </Suspense>
            </ErrorBoundary>
          </ProtectedRoute>
        }
      >
        <Route index element={lazyRoute(<HomePage />)} />
        <Route path="guilds/:guildId" element={lazyRoute(<GuildHomePage />)} />
        <Route path="guilds/:guildId/settings" element={lazyRoute(<GuildSettingsPage />)} />
        <Route path="guilds/:guildId/sports" element={lazyRoute(<GuildSportsPage />)} />
        <Route path="guilds/:guildId/sports/:sport/:league/:eventId" element={lazyRoute(<GuildSportsGamePage />)} />
        <Route path="guilds/:guildId/daily-word" element={lazyRoute(<GuildDailyWordPage />)} />
        <Route path="guilds/:guildId/channels/:channelId" element={lazyRoute(<GuildPage />)} />
        <Route path="dms" element={lazyRoute(<DMPage />)} />
        <Route path="dms/:channelId" element={lazyRoute(<DMPage />)} />
        <Route path="friends" element={lazyRoute(<FriendsPage />)} />
        <Route path="admin" element={lazyRoute(<AdminPage />)} />
        <Route path="discovery" element={lazyRoute(<DiscoveryPage />)} />
        <Route path="templates" element={lazyRoute(<TemplateGalleryPage />)} />
        <Route path="oauth2/authorize" element={lazyRoute(<BotAuthorizePage />)} />
        <Route path="developers" element={lazyRoute(<DeveloperPage />)} />
        {/* The Stage inside the real shell, so the Buildings column stands
            beside it as it does in a call (lantern-stage-spec §7.1/§7.2).
            Dev builds only, stripped from production. */}
        {import.meta.env.DEV && StagePreviewPage && (
          <Route path="design-stage" element={lazyRoute(<StagePreviewPage />)} />
        )}
      </Route>

      {/* Media engine test harness — registered in dev builds only, stripped from production. */}
      {import.meta.env.DEV && MediaTest && (
        <Route path="/media-test" element={lazyRoute(<MediaTest />)} />
      )}

      {/* Design-system reference — dev builds only, stripped from production. */}
      {import.meta.env.DEV && DesignTokensPage && (
        <Route path="/design-tokens" element={lazyRoute(<DesignTokensPage />)} />
      )}

      {/* The Stage at full size — dev builds only, stripped from production. */}
      {import.meta.env.DEV && StagePreviewPage && (
        <Route path="/design-stage" element={lazyRoute(<StagePreviewPage />)} />
      )}

      {/* Default: send to app (which handles auth redirects) */}
      <Route path="*" element={<Navigate to="/app" />} />
    </Routes>
  );
}
