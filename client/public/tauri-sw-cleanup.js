// In Tauri desktop, assets are embedded in the exe. An active PWA service
// worker caches stale assets that override updates. Unregister before the
// app module loads so the current build's assets are used immediately.
(function () {
  if (window.__TAURI_INTERNALS__ && navigator.serviceWorker) {
    var originalRegister = navigator.serviceWorker.register;
    navigator.serviceWorker.register = function () {
      // The generated web bootstrap calls register() without awaiting it. Make
      // that desktop-only call a resolved no-op so no worker is installed and
      // no expected rejection leaks into the global error handler.
      return navigator.serviceWorker.getRegistration();
    };

    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      registrations.forEach(function (registration) {
        registration.unregister();
      });
    });

    if (window.caches) {
      window.caches.keys().then(function (keys) {
        keys.forEach(function (key) {
          window.caches.delete(key);
        });
      });
    }

    window.__PARACORD_RESTORE_SW_REGISTER__ = function () {
      navigator.serviceWorker.register = originalRegister;
    };
  }
})();
