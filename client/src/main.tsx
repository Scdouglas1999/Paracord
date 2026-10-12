import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
// Glass type (docs/glass-spec.md §2.3): Instrument Sans, self-hosted, with the
// width axis (75-100) and weights 400-700. Before globals.css so its
// @font-face rules are declared before anything uses the family.
import '@fontsource-variable/instrument-sans/wdth.css';
import './styles/globals.css';
import { AppProviders } from './lib/AppProviders';
import { ErrorBoundary } from './components/ErrorBoundary';
import { getDesktopDiagnosticsLogPath, logVoiceDiagnostic } from './lib/desktopDiagnostics';
import { isTauri } from './lib/tauriEnv';
import { useBootSplashHandoff } from './lib/bootSplash';
import { setTrustSource, syncTrustedHosts } from './lib/trustedHosts';
import { getStoredServerUrl } from './lib/config/apiBaseUrl';
import { sameServerUrl } from './lib/serverScope';
import { useServerListStore } from './stores/serverListStore';
import { toast } from './stores/toastStore';
import { installDeepLinks } from './lib/deepLinks';

// In Tauri, assets are embedded in the exe. The PWA service worker caches stale
// assets in WebView2 storage that override the exe's embedded files, preventing
// updates from taking effect. Unregister it immediately.
if (isTauri() && 'serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      // The desktop WebView deliberately rejects service-worker access. This is
      // the expected secure configuration, not an application failure.
      if (message === 'PWA service workers are disabled in Paracord desktop') {
        return;
      }
      throw reason;
    });
}

// Desktop-only: ask Rust to verify and sync trusted server hosts.
//
// Two things have to be true at once.
//
//  1. **Not on every store write.** Every serverListStore write used to re-enter
//     this — and `setApiReachable` runs one on the response to EVERY API call —
//     so each entry made the shell issue a real `/health` request per server
//     before it would talk. One click on a room cost a dozen extra round-trips,
//     all of them queued ahead of the data the screen was waiting for. The list
//     of URLs is what matters; the rest of the store is not our business.
//
//  2. **But it must keep trying while nothing is connected.** The shell only
//     trusts an origin whose `/health` it can actually reach, and an untrusted
//     origin refuses every native request before it leaves the machine. A
//     server that was down when the app started — a laptop opened before the
//     home server woke, a restart — therefore stayed untrusted forever: the
//     sign-in screen answered "Login failed. Check your credentials" with
//     nothing on the wire, and only relaunching the app fixed it. So re-probe
//     on a slow beat whenever no server is connected, and never while they are.
//     (A server the user already approved no longer needs the beat: the shell
//     keeps trusting it while it is down, `update_trusted_server_hosts`. The beat
//     is for one it has never verified, and a refused request does not wait for
//     it, `recheckTrust`.)
const TRUST_RESYNC_WHILE_DISCONNECTED_MS = 30_000;
if (isTauri()) {
  let syncedUrls = '';
  // The stored home server too: session bootstrap refreshes against it at once,
  // and the shell refuses an origin this sync has not verified.
  const serverUrls = () => {
    const urls = useServerListStore.getState().servers.map((s) => s.url);
    const home = getStoredServerUrl();
    if (home && !urls.some((url) => sameServerUrl(url, home))) urls.push(home);
    return urls;
  };
  const sync = () => {
    const urls = serverUrls();
    syncedUrls = JSON.stringify(urls);
    void syncTrustedHosts(urls);
  };
  // A request the shell refuses for want of a check (a server that was down when the app
  // started, back now) asks for one itself and is sent again, instead of waiting for the
  // beat below: `lib/trustedHosts.ts` `recheckTrust`, called by the desktop HTTP adapter.
  setTrustSource(serverUrls);
  sync();
  useServerListStore.subscribe(() => {
    if (JSON.stringify(serverUrls()) !== syncedUrls) sync();
  });
  setInterval(() => {
    const servers = useServerListStore.getState().servers;
    if (servers.length === 0 || servers.every((server) => server.connected)) return;
    sync();
  }, TRUST_RESYNC_WHILE_DISCONNECTED_MS);
}

// Desktop-only: block default context menu and drag navigation
if (isTauri()) {
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
}

let lastUnhandledRejection = '';
let lastUnhandledRejectionAt = 0;

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'An unexpected error occurred';
  const now = Date.now();
  if (message === lastUnhandledRejection && now - lastUnhandledRejectionAt < 3000) {
    return;
  }
  lastUnhandledRejection = message;
  lastUnhandledRejectionAt = now;
  // A global rejection is a safety net, not a user-facing error. Surfacing raw
  // rejection messages (failed background fetches, updater probes, gateway
  // reconnects) as toasts spams the user — especially on the login screen
  // before anything is connected. Show it only in dev; capture it in the
  // diagnostics log in release builds so we can still debug it.
  if (import.meta.env.DEV) {
    console.error('Unhandled promise rejection:', reason);
    toast.error(message);
  } else {
    void logVoiceDiagnostic('[app] unhandled promise rejection', { message });
  }
});

// paracord:// links: listener, then the queue the shell kept while this loaded.
void installDeepLinks();

logVoiceDiagnostic('[desktop] frontend main.tsx boot');
void getDesktopDiagnosticsLogPath().then((path) => {
  if (path) {
    logVoiceDiagnostic('[desktop] diagnostics log path resolved', { path });
  }
});

/**
 * Outermost, so its effect runs after everything in the first commit —
 * including a root ErrorBoundary's recovery screen, which must never sit
 * hidden behind the loading screen.
 */
function BootHandoff({ children }: { children: React.ReactNode }) {
  useBootSplashHandoff();
  return <>{children}</>;
}

// The desktop window is shown by public/boot-window.js as soon as the loading
// screen is in the document, not here after the bundle has loaded.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BootHandoff>
      <ErrorBoundary>
        <BrowserRouter>
          <AppProviders>
            <App />
          </AppProviders>
        </BrowserRouter>
      </ErrorBoundary>
    </BootHandoff>
  </React.StrictMode>
);
