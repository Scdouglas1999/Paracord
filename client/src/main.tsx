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

// Desktop-only: ask Rust to verify and sync trusted server hosts on startup and whenever the list changes
if (isTauri()) {
  const syncHosts = () => {
    const urls = useServerListStore.getState().servers.map((s) => s.url);
    void syncTrustedHosts(urls);
  };
  syncHosts();
  useServerListStore.subscribe(syncHosts);
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

// Desktop-only: show window after React renders (prevents white flash)
if (isTauri()) {
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    getCurrentWindow().show();
  });
}
