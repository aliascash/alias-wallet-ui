// Bridge between Electron's IPC and the renderer. Exposes a minimal
// `aliasBridge` object that the wallet UI (via qwebchannel-shim), the Setup
// Wizard, and the passphrase dialog all consume.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aliasBridge', {
  rpc:             (method, params) => ipcRenderer.invoke('alias:rpc', method, params),
  daemonStatus:    () => ipcRenderer.invoke('alias:daemon-status'),
  openExternal:    (url) => ipcRenderer.invoke('alias:open-external', url),
  // Wizard
  pickWalletDat:   () => ipcRenderer.invoke('alias:pick-wallet-dat'),
  importWalletDat: (srcPath) => ipcRenderer.invoke('alias:import-wallet-dat', srcPath),
  wizardComplete:  () => ipcRenderer.invoke('alias:wizard-complete'),
  wizardCancel:    () => ipcRenderer.invoke('alias:wizard-cancel'),
  // Passphrase dialog
  openPassphrase:    (mode) => ipcRenderer.invoke('alias:open-passphrase', mode),
  passphraseResult:  (payload) => ipcRenderer.invoke('alias:passphrase-result', payload),
  quitApp:           () => ipcRenderer.invoke('alias:quit'),
  confirmSend:       (opts) => ipcRenderer.invoke('alias:confirm-send', opts),
  openAbout:         () => ipcRenderer.invoke('alias:open-about'),
  openEditAddress:   (opts) => ipcRenderer.invoke('alias:open-edit-address', opts),
  editAddressResult: (payload) => ipcRenderer.invoke('alias:edit-address-result', payload),
  backupWallet:      () => ipcRenderer.invoke('alias:backup-wallet'),
  openCoinControl:   () => ipcRenderer.invoke('alias:open-coin-control'),
  openDebug:         () => ipcRenderer.invoke('alias:open-debug'),
  loadTranslation:   (locale) => ipcRenderer.invoke('alias:load-translation', locale),
  getOptions:        () => ipcRenderer.invoke('alias:get-options'),
  setOptions:        (changes) => ipcRenderer.invoke('alias:set-options', changes),
  // Splash receives status updates pushed from main via send().
  onSplashStatus:    (cb) => ipcRenderer.on('alias:splash-status', (_e, text) => cb(text)),
});
