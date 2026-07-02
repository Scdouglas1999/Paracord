import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/globals.css';
import { AppProviders } from './lib/AppProviders';
import { ErrorBoundary } from './components/ErrorBoundary';
import { getDesktopDiagnosticsLogPath, logVoiceDiagnostic } from './lib/desktopDiagnostics';
import { isTauri } from './lib/tauriEnv';
import { syncTrustedHosts } from './lib/trustedHosts';
import { useServerListStore } from './stores/serverListStore';

// In Tauri, assets are embedded in the exe. The PWA service worker caches stale
// assets in WebView2 storage that override the exe's embedded files, preventing
// updates from taking effect. Unregister it immediately.
if (isTauri() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const reg of registrations) {
      reg.unregister();
    }
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
