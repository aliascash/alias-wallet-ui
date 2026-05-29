// Receive status updates from main via ipcRenderer (exposed in preload).
// Falls back gracefully if the wiring isn't in place.

(function () {
  'use strict';
  const msg = document.getElementById('message');
  if (window.aliasBridge && typeof window.aliasBridge.onSplashStatus === 'function') {
    window.aliasBridge.onSplashStatus((text) => { msg.textContent = text || ''; });
  }
})();
