import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ServerConnectPage } from './pages/ServerConnectPage';
import { AccountSetupPage } from './pages/AccountSetupPage';
import { AccountUnlockPage } from './pages/AccountUnlockPage';
import { AccountRecoverPage } from './pages/AccountRecoverPage';
import { AppLayout } from './pages/AppLayout';
import { GuildPage } from './pages/GuildPage';
import { DMPage } from './pages/DMPage';
import { FriendsPage } from './pages/FriendsPage';
import { SettingsPage } from './pages/SettingsPage';
import { GuildSettingsPage } from './pages/GuildSettingsPage';
import { AdminPage } from './pages/AdminPage';
import { InvitePage } from './pages/InvitePage';
import { TermsPage } from './pages/TermsPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { useAccountStore } from './stores/accountStore';
import { useServerListStore } from './stores/serverListStore';
import { useAuthStore } from './stores/authStore';
import { hasAccount } from './lib/account';
import { getStoredServerUrl } from './lib/apiBaseUrl';
import { connectionManager } from './lib/connectionManager';

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
        if (data?.service === 'paracord') {
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
 * Route guard: requires an unlocked account.
 * If no account exists, redirect to setup.
 * If account exists but is locked, redirect to unlock.
 */
function AccountRoute({ children }: { children: React.ReactNode }) {
  const isUnlocked = useAccountStore((s) => s.isUnlocked);
  const accountExists = hasAccount();

  if (!accountExists) {
    return <Navigate to="/setup" />;
  }
  if (!isUnlocked) {
    return <Navigate to="/unlock" />;
  }
  return <>{children}</>;
}

/**
 * Route guard for the main app: requires unlocked account + at least one server.
 * Falls back to legacy auth (token-based) for backward compatibility.
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isUnlocked = useAccountStore((s) => s.isUnlocked);
  const servers = useServerListStore((s) => s.servers);
  const token = useAuthStore((s) => s.token);
  const serverStatus = useServerStatus();

  // New account system: unlocked + has servers
  if (isUnlocked && servers.length > 0) {
    return <>{children}</>;
  }

  // Legacy path: token-based auth with single server
  if (serverStatus === 'loading') {
    return (
      <div className="auth-shell">
        <p className="text-text-muted">Connecting...</p>
      </div>
    );
  }

  if (token && serverStatus === 'ready') {
    return <>{children}</>;
  }

  // No account at all — go to setup
  if (!hasAccount()) {
    return <Navigate to="/setup" />;
  }

  // Account exists but locked
  if (!isUnlocked) {
    return <Navigate to="/unlock" />;
  }

  // Unlocked but no servers
  return <Navigate to="/connect" />;
}

function AuthRoute({ children }: { children: React.ReactNode }) {
  const serverStatus = useServerStatus();

  if (serverStatus === 'loading') {
    return (
      <div className="auth-shell">
        <p className="text-text-muted">Connecting...</p>
      </div>
    );
  }

  if (serverStatus === 'needed') {
    return <Navigate to="/connect" />;
  }

  return <>{children}</>;
}

/**
 * Hook to auto-connect to all servers when account is unlocked.
 */
function useAutoConnect() {
  const isUnlocked = useAccountStore((s) => s.isUnlocked);
  const servers = useServerListStore((s) => s.servers);

  useEffect(() => {
    if (!isUnlocked || servers.length === 0) return;
    connectionManager.connectAll().catch(() => {
      // Individual server connection errors are handled per-server
    });
    return () => {
      connectionManager.disconnectAll();
    };
  }, [isUnlocked, servers.length]);
}

export default function App() {
  useAutoConnect();

  return (
    <Routes>
      {/* Account management */}
      <Route path="/setup" element={<AccountSetupPage />} />
      <Route path="/unlock" element={<AccountUnlockPage />} />
      <Route path="/recover" element={<AccountRecoverPage />} />

      {/* Server connection */}
      <Route path="/connect" element={<AccountRoute><ServerConnectPage /></AccountRoute>} />

      {/* Legacy auth routes (kept for backward compat) */}
      <Route path="/login" element={<AuthRoute><LoginPage /></AuthRoute>} />
      <Route path="/register" element={<AuthRoute><RegisterPage /></AuthRoute>} />

      {/* Invites, legal */}
      <Route path="/invite/:code" element={<InvitePage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />

      {/* Main app */}
      <Route path="/app" element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route index element={<FriendsPage />} />
        <Route path="guilds/:guildId/channels/:channelId" element={<GuildPage />} />
        <Route path="dms" element={<DMPage />} />
        <Route path="dms/:channelId" element={<DMPage />} />
        <Route path="friends" element={<FriendsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="guilds/:guildId/settings" element={<GuildSettingsPage />} />
      </Route>

      {/* Default: send to app (which handles auth redirects) */}
      <Route path="*" element={<Navigate to="/app" />} />
    </Routes>
  );
}
