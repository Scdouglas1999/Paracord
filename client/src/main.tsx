import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import './styles/globals.css';
import { AppProviders } from './lib/AppProviders';
import { ErrorBoundary } from './components/ErrorBoundary';
import { getDesktopDiagnosticsLogPath, logVoiceDiagnostic } from './lib/desktopDiagnostics';
import { isTauri } from './lib/tauriEnv';
import { syncTrustedHosts } from './lib/trustedHosts';
import { useServerListStore } from './stores/serverListStore';
import { toast } from './stores/toastStore';

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
const TRUST_RESYNC_WHILE_DISCONNECTED_MS = 30_000;
if (isTauri()) {
  let syncedUrls = '';
  const serverUrls = () => useServerListStore.getState().servers.map((s) => s.url);
  const sync = () => {
    const urls = serverUrls();
    syncedUrls = JSON.stringify(urls);
    void syncTrustedHosts(urls);
  };
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

logVoiceDiagnostic('[desktop] frontend main.tsx boot');
void getDesktopDiagnosticsLogPath().then((path) => {
  if (path) {
    logVoiceDiagnostic('[desktop] diagnostics log path resolved', { path });
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AppProviders>
          <App />
        </AppProviders>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);

// QA-DIAG (temporary): mirror console.warn/error into the diagnostics log.
if (isTauri()) {
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        void logVoiceDiagnostic(`[qa-diag] console.${level}`, {
          msg: args.map((a) => (a instanceof Error ? `${a.message} :: ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 600),
        });
      } catch { /* ignore */ }
    };
  }
  window.addEventListener('error', (e) => {
    void logVoiceDiagnostic('[qa-diag] window error', { message: e.message, file: e.filename, line: e.lineno, stack: (e.error as Error | undefined)?.stack?.slice(0, 400) ?? '' });
  });
}

// QA-DIAG (temporary)
if (isTauri()) {
  setInterval(() => {
    const root = document.getElementById('root');
    const first = root?.firstElementChild as HTMLElement | null;
    void logVoiceDiagnostic('[qa-diag] dom heartbeat', {
      href: location.href,
      rootChildren: root?.childElementCount ?? -1,
      firstTag: first?.tagName ?? 'none',
      firstClass: (first?.className ?? '').slice(0, 120),
      txt: (root?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160),
    });
  }, 4000);
}

// Desktop-only: show window after React renders (prevents white flash)
if (isTauri()) {
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    getCurrentWindow().show();
  });
}
