// In Tauri desktop, assets are embedded in the exe. An active PWA service
// worker caches stale assets that override updates. Unregister before the
// app module loads so the current build's assets are used immediately.
(function () {
  if (window.__TAURI_INTERNALS__ && navigator.serviceWorker) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      registrations.forEach(function (registration) {
        registration.unregister();
      });
    });
  }
})();
