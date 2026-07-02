import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ServerConnectPage } from './pages/ServerConnectPage';
import { AccountSetupPage } from './pages/AccountSetupPage';
import { AccountUnlockPage } from './pages/AccountUnlockPage';
import { AccountRecoverPage } from './pages/AccountRecoverPage';
import { TermsPage } from './pages/TermsPage';
import { PrivacyPage } from './pages/PrivacyPage';

// Lazy-loaded route surfaces keep the initial auth/server bootstrap bundle small.
const AppLayout = lazy(() => import('./pages/AppLayout').then(m => ({ default: m.AppLayout })));
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
const MediaTest = lazy(() => import('./pages/MediaTest'));
import { useAccountStore } from './stores/accountStore';
import { useServerListStore } from './stores/serverListStore';
import { useAuthStore } from './stores/authStore';
import { hasAccount } from './lib/account';
import { getStoredServerUrl } from './lib/apiBaseUrl';

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

    let cancelled = false;
    fetch('/health', { signal: AbortSignal.timeout(5_000) })
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
    return <AuthLoadingSpinner label="Restoring session..." />;
  }

  if (serverStatus === 'loading') {
    return <AuthLoadingSpinner label="Connecting..." />;
  }

  if (token && !hasFetchedSettings) {
    return <AuthLoadingSpinner label="Loading account settings..." />;
  }

  // Optional crypto-auth mode (server-controlled, default false).
  if (cryptoAuthEnabled) {
    if (!hasAccount()) {
      return <Navigate to="/setup" />;
    }
    if (!isUnlocked) {
      return <Navigate to="/unlock" />;
    }
    if (servers.length > 0 || (token && serverStatus === 'ready')) {
      return <>{children}</>;
    }
    if (!token) {
      return <Navigate to="/login" />;
    }
    if (servers.length === 0 && serverStatus !== 'ready') {
      return <Navigate to="/connect" />;
    }
    return <Navigate to="/connect" />;
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

function AuthRoute({ children }: { children: React.ReactNode }) {
  const serverStatus = useServerStatus();
  const sessionBootstrapComplete = useAuthStore((s) => s.sessionBootstrapComplete);

  if (!sessionBootstrapComplete) {
    return <AuthLoadingSpinner label="Restoring session..." />;
  }

  if (serverStatus === 'loading') {
    return <AuthLoadingSpinner label="Connecting..." />;
  }

  if (serverStatus === 'needed') {
    return <Navigate to="/connect" />;
  }

  return <>{children}</>;
}

function AuthLoadingSpinner({ label }: { label: string }) {
  return (
    <div className="auth-shell">
      <div className="flex flex-col items-center gap-3">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
        <p className="text-sm font-medium text-text-muted">{label}</p>
      </div>
    </div>
  );
}

function LazyFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
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
      <Route path="/app" element={<ProtectedRoute>{lazyRoute(<AppLayout />)}</ProtectedRoute>}>
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

      {/* Media engine test page (no auth required) */}
      <Route path="/media-test" element={lazyRoute(<MediaTest />)} />

      {/* Default: send to app (which handles auth redirects) */}
      <Route path="*" element={<Navigate to="/app" />} />
    </Routes>
  );
}
