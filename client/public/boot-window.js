// Desktop only: show the window the moment the loading screen is in the document.
//
// The Tauri window is created hidden (tauri.conf.json, "visible": false) so the
// person never sees an empty white webview. It used to be shown by main.tsx,
// after the whole app bundle had loaded and parsed, by which point the loading
// screen in index.html was already halfway through its sequence. This runs
// straight after that markup is parsed, so the first frame the window shows is
// the loading screen's first frame.
(function () {
  var tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return;
  tauri
    .invoke('plugin:window|show', { label: tauri.metadata.currentWindow.label })
    .catch(function (error) {
      console.error('[boot] the desktop window could not be shown:', error);
    });
})();
