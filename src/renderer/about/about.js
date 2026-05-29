(function () {
  'use strict';
  // Populate version from the daemon's getinfo.
  if (window.aliasBridge && window.aliasBridge.rpc) {
    window.aliasBridge.rpc('getinfo', []).then((info) => {
      if (info && info.version) {
        document.getElementById('versionLabel').textContent = info.version;
      }
    }).catch(() => {});
  }
  // Route in-doc <a> clicks through the OS browser so we don't navigate.
  document.querySelectorAll('a[href^="http"], a[href^="mailto:"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.aliasBridge && window.aliasBridge.openExternal) {
        window.aliasBridge.openExternal(a.href);
      }
    });
  });
  document.getElementById('btn-ok').addEventListener('click', () => window.close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); window.close(); }
  });
})();
