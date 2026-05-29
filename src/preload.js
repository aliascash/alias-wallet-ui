// Bridge between Electron's IPC and the renderer. Exposes a minimal
// `aliasBridge` object that both the wallet UI (via qwebchannel-shim) and
// the Setup Wizard consume.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aliasBridge', {
  rpc:             (method, params) => ipcRenderer.invoke('alias:rpc', method, params),
  daemonStatus:    () => ipcRenderer.invoke('alias:daemon-status'),
  openExternal:    (url) => ipcRenderer.invoke('alias:open-external', url),
  // Wizard-only IPC.
  pickWalletDat:   () => ipcRenderer.invoke('alias:pick-wallet-dat'),
  importWalletDat: (srcPath) => ipcRenderer.invoke('alias:import-wallet-dat', srcPath),
  wizardComplete:  () => ipcRenderer.invoke('alias:wizard-complete'),
  wizardCancel:    () => ipcRenderer.invoke('alias:wizard-cancel'),
});
