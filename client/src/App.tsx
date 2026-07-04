import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { AppMark } from './pages/authScaffold';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ServerConnectPage } from './pages/ServerConnectPage';
import { AccountSetupPage } from './pages/AccountSetupPage';
import { AccountUnlockPage } from './pages/AccountUnlockPage';
import { AccountRecoverPage } from './pages/AccountRecoverPage';
import { TermsPage } from './pages/TermsPage';
import { PrivacyPage } from './pages/PrivacyPage';

// Lazy-loaded route surfaces keep the initial auth/server bootstrap bundle small.
const AppShell = lazy(() => import('./pages/AppShell').then(m => ({ default: m.AppShell })));
const HomePage = lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const GuildHub = lazy(() => import('./pages/GuildHub').then(m => ({ default: m.GuildHub })));
const GuildPage = lazy(() => import('./pages/GuildPage').then(m => ({ default: m.GuildPage })));
const GuildSettingsPage = lazy(() => import('./pages/GuildSettingsPage').then(m => ({ default: m.GuildSettingsPage })));
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
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isUnlocked = useAccountStore((s) => s.isUnlocked);
  const servers = useServerListStore((s) => s.servers);
  const token = useAuthStore((s) => s.token);
  const sessionBootstrapComplete = useAuthStore((s) => s.sessionBootstrapComplete);
  const settings = useAuthStore((s) => s.settings);
  const hasFetchedSettings = useAuthStore((s) => s.hasFetchedSettings);
  const fetchSettings = useAuthStore((s) => s.fetchSettings);
  const serverStatus = useServerStatus();
  const cryptoAuthEnabled = settings?.crypto_auth_enabled === true;

  useEffect(() => {
    if (token && !hasFetchedSettings) {
      void fetchSettings();
    }
  }, [token, hasFetchedSettings, fetchSettings]);

  if (!sessionBootstrapComplete) {
    return <BrandedSplash label="Restoring session..." />;
  }

  if (serverStatus === 'loading') {
    return <BrandedSplash label="Connecting..." />;
  }

  if (token && !hasFetchedSettings) {
    return <BrandedSplash label="Loading account settings..." />;
  }

  // Optional crypto-auth mode (server-controlled, default false).
  if (cryptoAuthEnabled) {
    const target = resolveCryptoAuthRedirect({
      hasAccount: hasAccount(),
      isUnlocked,
      hasServers: servers.length > 0,
      hasToken: Boolean(token),
      serverReady: serverStatus === 'ready',
    });
    return target ? <Navigate to={target} /> : <>{children}</>;
  }

  // Password mode: valid token can enter directly.
  if (token && serverStatus === 'ready') {
    return <>{children}</>;
  }

  // Password mode without token.
  if (serverStatus === 'needed') {
    return <Navigate to="/connect" />;
  }
  return <Navigate to="/login" />;
}

export function AuthRoute({ children }: { children: React.ReactNode }) {
  const serverStatus = useServerStatus();
  const sessionBootstrapComplete = useAuthStore((s) => s.sessionBootstrapComplete);
  const token = useAuthStore((s) => s.token);

  if (!sessionBootstrapComplete) {
    return <BrandedSplash label="Restoring session..." />;
  }

  if (serverStatus === 'loading') {
    return <BrandedSplash label="Connecting..." />;
  }

  if (serverStatus === 'needed') {
    return <Navigate to="/connect" />;
  }

  // Already authenticated: don't show the login/register forms.
  if (token && serverStatus === 'ready') {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}

/**
 * Full-viewport branded boot state shown while auth/session resolves. A real
 * loading moment (app mark on the deepest `--bg-tertiary` base, Fraunces
 * wordmark, muted status line) rather than a bare spinner — and it matches the
 * document's first-paint surface so there is no flash while the app hydrates.
 * The mark breathes gently; `useReducedMotion` collapses it to a static mark.
 */
function BrandedSplash({ label }: { label: string }) {
  const reduce = useReducedMotion();
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-5 bg-bg-tertiary px-6">
      <motion.div
        animate={reduce ? { opacity: 1 } : { opacity: [0.6, 1, 0.6], scale: [1, 1.04, 1] }}
        transition={reduce ? undefined : { duration: 2.2, ease: 'easeInOut', repeat: Infinity }}
      >
        <AppMark size={52} />
      </motion.div>
      <div className="flex flex-col items-center gap-1.5">
        <span className="font-display text-heading text-text-primary">Paracord</span>
        <p className="text-meta text-text-muted" role="status" aria-live="polite">
          {label}
        </p>
      </div>
    </div>
  );
}

/**
 * In-shell fallback while a lazily-loaded route surface streams in. Sits inside
 * the already-painted frame, so it stays quiet: just the mark, gently fading.
 */
function LazyFallback() {
  const reduce = useReducedMotion();
  return (
    <div className="flex h-full w-full items-center justify-center">
      <motion.div
        animate={reduce ? { opacity: 0.85 } : { opacity: [0.4, 0.9, 0.4] }}
        transition={reduce ? undefined : { duration: 1.6, ease: 'easeInOut', repeat: Infinity }}
      >
        <AppMark size={32} />
      </motion.div>
    </div>
  );
}

function lazyRoute(children: React.ReactNode) {
  return <Suspense fallback={<LazyFallback />}>{children}</Suspense>;
}

export default function App() {
  return (
    <Routes>
      {/* Optional device crypto identity */}
      <Route path="/setup" element={<AccountSetupPage />} />
      <Route path="/unlock" element={<AccountUnlockPage />} />
      <Route path="/recover" element={<AccountRecoverPage />} />

      {/* Server connection */}
      <Route path="/connect" element={<ServerConnectPage />} />

      {/* Password auth */}
      <Route path="/login" element={<AuthRoute><LoginPage /></AuthRoute>} />
      <Route path="/register" element={<AuthRoute><RegisterPage /></AuthRoute>} />

      {/* Invites, legal */}
      <Route path="/invite/:code" element={lazyRoute(<InvitePage />)} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />

      {/* Main app */}
      <Route path="/app" element={<ProtectedRoute>{lazyRoute(<AppShell />)}</ProtectedRoute>}>
        <Route index element={lazyRoute(<HomePage />)} />
        <Route path="guilds/:guildId" element={lazyRoute(<GuildHub />)} />
        <Route path="guilds/:guildId/settings" element={lazyRoute(<GuildSettingsPage />)} />
        <Route path="guilds/:guildId/channels/:channelId" element={lazyRoute(<GuildPage />)} />
        <Route path="dms" element={lazyRoute(<DMPage />)} />
        <Route path="dms/:channelId" element={lazyRoute(<DMPage />)} />
        <Route path="friends" element={lazyRoute(<FriendsPage />)} />
        <Route path="admin" element={lazyRoute(<AdminPage />)} />
        <Route path="discovery" element={lazyRoute(<DiscoveryPage />)} />
        <Route path="templates" element={lazyRoute(<TemplateGalleryPage />)} />
        <Route path="oauth2/authorize" element={lazyRoute(<BotAuthorizePage />)} />
        <Route path="developers" element={lazyRoute(<DeveloperPage />)} />
      </Route>

      {/* Media engine test harness — registered in dev builds only, stripped from production. */}
      {import.meta.env.DEV && MediaTest && (
        <Route path="/media-test" element={lazyRoute(<MediaTest />)} />
      )}

      {/* Default: send to app (which handles auth redirects) */}
      <Route path="*" element={<Navigate to="/app" />} />
    </Routes>
  );
}
