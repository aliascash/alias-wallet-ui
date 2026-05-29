// Electron main process — launches aliaswalletd, exposes JSON-RPC bridge
// to the renderer, owns the BrowserWindow.

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const crypto = require('crypto');
const os = require('os');
const Store = require('electron-store');

const isDev      = process.argv.includes('--dev');
const forceSetup = process.argv.includes('--first-run');  // dev: force-show wizard
const skipSetup  = process.argv.includes('--skip-wizard'); // dev: skip wizard even if first launch

// ---------- single-instance lock ----------
//
// Two wallet processes on the same datadir corrupt wallet.dat. requestSingleInstanceLock
// returns false when another instance already holds the lock; in that case quit
// immediately. When a second copy is launched, the first receives 'second-instance'
// and focuses its main window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  const win = mainWindow || wizardWindow;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ---------- persistent settings ----------
//
// Saved at <userData>/config.json. Currently tracks window bounds so the app
// reopens at the user's last size/position.
const settings = new Store({
  name: 'config',
  defaults: { mainBounds: { width: 1280, height: 720 } },
});

const RPC_PORT = 36657;
const RPC_HOST = '127.0.0.1';
const RPC_USER = 'aliaswallet';
const RPC_PASS = crypto.randomBytes(24).toString('hex');

let daemonProc = null;
let mainWindow = null;
let wizardWindow = null;
let splashWindow = null;

// App icon — resolved against the project root in dev, the app.asar in prod.
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

function getDaemonPath() {
  if (isDev) {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const platform = process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64';
    const exe = process.platform === 'win32' ? 'aliaswalletd.exe' : 'aliaswalletd';
    return path.join(repoRoot, 'alias-modernized', 'dist', platform, exe);
  }
  const exe = process.platform === 'win32' ? 'aliaswalletd.exe' : 'aliaswalletd';
  return path.join(process.resourcesPath, 'daemon', exe);
}

function getDataDir() {
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Roaming', 'Alias');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Alias');
  return path.join(os.homedir(), '.alias');
}

function writeAliasConf() {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const confPath = path.join(dataDir, 'alias.conf');
  const lines = [
    `rpcuser=${RPC_USER}`,
    `rpcpassword=${RPC_PASS}`,
    `rpcport=${RPC_PORT}`,
    `rpcallowip=127.0.0.1`,
    `server=1`,
  ].join('\n');
  fs.writeFileSync(confPath, lines, { mode: 0o600 });
  return dataDir;
}

function seedTorFiles(daemonPath, dataDir) {
  const torSrcDir = path.join(path.dirname(daemonPath), 'Tor');
  const torDstDir = path.join(dataDir, 'tor');
  fs.mkdirSync(torDstDir, { recursive: true });
  for (const name of ['geoip', 'geoip6']) {
    const src = path.join(torSrcDir, name);
    const dst = path.join(torDstDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
}

function startDaemon() {
  const daemonPath = getDaemonPath();
  if (!fs.existsSync(daemonPath)) {
    console.error(`Daemon binary not found at: ${daemonPath}`);
    return;
  }
  const dataDir = writeAliasConf();
  seedTorFiles(daemonPath, dataDir);
  // cwd must be the daemon's dir — net.cpp CreateProcessA("Tor/tor.exe", ...)
  // resolves the Tor binary relative to the *current* working directory.
  daemonProc = spawn(daemonPath, [`-datadir=${dataDir}`, '-server'], {
    cwd: path.dirname(daemonPath),
    stdio: 'inherit',
  });
  daemonProc.on('exit', (code) => {
    console.log(`aliaswalletd exited with code ${code}`);
    daemonProc = null;
  });
}

async function rpc(method, params = []) {
  const res = await axios.post(`http://${RPC_HOST}:${RPC_PORT}/`, {
    jsonrpc: '1.0',
    id: Date.now(),
    method,
    params,
  }, {
    auth: { username: RPC_USER, password: RPC_PASS },
    timeout: 30000,
  });
  if (res.data.error) throw new Error(res.data.error.message);
  return res.data.result;
}

ipcMain.handle('alias:rpc', async (_event, method, params) => rpc(method, params));
ipcMain.handle('alias:daemon-status', () => ({
  running: daemonProc !== null,
  pid: daemonProc ? daemonProc.pid : null,
}));
ipcMain.handle('alias:open-external', (_event, url) => shell.openExternal(url));

// ---------- wizard IPC ----------

ipcMain.handle('alias:pick-wallet-dat', async () => {
  const r = await dialog.showOpenDialog(wizardWindow || mainWindow, {
    title: 'Choose wallet.dat to import',
    filters: [{ name: 'Wallet', extensions: ['dat'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('alias:import-wallet-dat', async (_event, srcPath) => {
  if (!srcPath || !fs.existsSync(srcPath)) return false;
  const dst = path.join(getDataDir(), 'wallet.dat');
  // Stop daemon so it releases the BDB lock on wallet.dat.
  if (daemonProc) { daemonProc.kill(); await new Promise(r => setTimeout(r, 1500)); }
  fs.copyFileSync(srcPath, dst);
  startDaemon();
  // Give daemon a few seconds to reopen RPC.
  await waitForRpcReady(15000);
  return true;
});

ipcMain.handle('alias:wizard-complete', () => {
  if (wizardWindow) { wizardWindow.close(); wizardWindow = null; }
  createMainWindow();
});
ipcMain.handle('alias:wizard-cancel', () => {
  if (wizardWindow) wizardWindow.close();
  app.quit();
});

// ---------- passphrase dialog ----------
//
// `alias:open-passphrase` opens a small modal child of mainWindow. Resolves
// with the user-entered payload, or null on cancel/close. Mirrors the
// original Qt AskPassphraseDialog modes.

let passphrasePending = null;
function openPassphraseDialog(mode) {
  return new Promise((resolve) => {
    if (passphrasePending) { resolve(null); return; }
    passphrasePending = resolve;
    const parent = mainWindow || wizardWindow;
    const win = new BrowserWindow({
      // Match original askpassphrasedialog.ui geometry: 598×209, min width 550.
      width: 598, height: 209, useContentSize: true,
      minWidth: 550,
      // Modal requires a parent on Linux; if none yet (startup unlock), the
      // dialog is a standalone always-on-top window.
      parent: parent || undefined,
      modal: !!parent,
      alwaysOnTop: !parent,
      resizable: false, minimizable: false, maximizable: false,
      title: 'Alias',
      icon: APP_ICON,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const url = `file://${path.join(__dirname, '..', 'renderer', 'passphrase', 'index.html').replace(/\\/g, '/')}#${mode}`;
    win.loadURL(url);
    win.on('closed', () => { if (passphrasePending) { passphrasePending(null); passphrasePending = null; } });
    attachDevHooks(win);
    win.__resolvePassphrase = (payload) => {
      if (passphrasePending) { passphrasePending(payload); passphrasePending = null; }
      win.close();
    };
  });
}
ipcMain.handle('alias:open-passphrase', (_event, mode) => openPassphraseDialog(mode));
ipcMain.handle('alias:passphrase-result', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && typeof win.__resolvePassphrase === 'function') win.__resolvePassphrase(payload);
});
ipcMain.handle('alias:quit', () => app.quit());

// Options — persisted in electron-store under `options`. UI-side options (e.g.
// MinimizeToTray, DisplayUnit) live entirely here; daemon-side options
// (paytxfee, reservebalance) also call their corresponding RPC on save.
const DEFAULT_OPTIONS = {
  StartAtStartup:    false,
  DetachDatabases:   false,
  Fee:               0.0001,
  Staking:           true,
  StakingDonation:   '0',
  ReserveBalance:    0,
  MinStakeInterval:  '0',
  MinRingSize:       10,
  MaxRingSize:       10,
  MinimizeOnClose:   false,
  MinimizeToTray:    false,
  Notifications:     [],
  ThinMode:          false,
  ThinFullIndex:     false,
  ThinIndexWindow:   4096,
  DisplayUnit:       0,
  DisplayAddresses:  false,
  Language:          'en',
  RowsPerPage:       25,
  VisibleTransactions: [],
};
ipcMain.handle('alias:get-options', () => {
  const stored = settings.get('options') || {};
  return Object.assign({}, DEFAULT_OPTIONS, stored);
});
ipcMain.handle('alias:set-options', async (_event, changes) => {
  if (!changes || typeof changes !== 'object') return false;
  const current = settings.get('options') || {};
  const next    = Object.assign({}, DEFAULT_OPTIONS, current, changes);
  settings.set('options', next);
  // Mirror daemon-side options that have RPC equivalents.
  try {
    if (Object.prototype.hasOwnProperty.call(changes, 'Fee'))
      await rpc('settxfee', [Number(changes.Fee) || 0]);
  } catch (_) {}
  try {
    if (Object.prototype.hasOwnProperty.call(changes, 'ReserveBalance'))
      await rpc('reservebalance', [true, Number(changes.ReserveBalance) || 0]);
  } catch (_) {}
  return true;
});

// Translation loader — returns the {source: translation} map for a locale,
// or null if no map exists. Locale codes match src/translations/<locale>.json
// (derived from alias-modernized's alias_<locale>.ts).
ipcMain.handle('alias:load-translation', (_event, locale) => {
  if (!locale || locale === 'en') return null;
  const file = path.join(__dirname, '..', 'translations', `${locale}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
});

// Debug — opens Chromium DevTools on the main window. The original Qt had a
// debug console window with command-line RPC entry; DevTools serves the same
// purpose for the JS-side bridge + lets devs inspect renderer state.
ipcMain.handle('alias:open-debug', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools({ mode: 'detach' });
});

// Coin Control — UTXO list. Read-only v1; selection not yet wired into sendCoins.
let coinControlWindow = null;
ipcMain.handle('alias:open-coin-control', () => {
  if (coinControlWindow && !coinControlWindow.isDestroyed()) { coinControlWindow.focus(); return; }
  coinControlWindow = new BrowserWindow({
    width: 760, height: 480, useContentSize: true,
    parent: mainWindow || undefined,
    modal: false,
    title: 'Coin Control',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  coinControlWindow.loadFile(path.join(__dirname, '..', 'renderer', 'coincontrol', 'index.html'));
  coinControlWindow.on('closed', () => { coinControlWindow = null; });
  attachDevHooks(coinControlWindow);
});

// About — non-modal info dialog (671×347) showing version + license text.
let aboutWindow = null;
ipcMain.handle('alias:open-about', () => {
  if (aboutWindow && !aboutWindow.isDestroyed()) { aboutWindow.focus(); return; }
  aboutWindow = new BrowserWindow({
    width: 671, height: 347, useContentSize: true,
    parent: mainWindow || undefined,
    modal: false,
    resizable: false, minimizable: false, maximizable: false,
    title: 'About Alias',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  aboutWindow.loadFile(path.join(__dirname, '..', 'renderer', 'about', 'index.html'));
  aboutWindow.on('closed', () => { aboutWindow = null; });
  attachDevHooks(aboutWindow);
});

// Edit Address — modal dialog (457×129) returning {label, address, stealth} or null.
let editAddressPending = null;
ipcMain.handle('alias:open-edit-address', (_event, opts) => {
  opts = opts || {};
  return new Promise((resolve) => {
    if (editAddressPending) { resolve(null); return; }
    editAddressPending = resolve;
    const mode = String(opts.mode || 'new-sending').toLowerCase();
    const qp = new URLSearchParams({
      label:   opts.label   || '',
      address: opts.address || '',
      stealth: opts.stealth ? '1' : '0',
    }).toString();
    const win = new BrowserWindow({
      width: 457, height: 129, useContentSize: true,
      parent: mainWindow || undefined,
      modal: true,
      resizable: false, minimizable: false, maximizable: false,
      title: 'Edit Address',
      icon: APP_ICON,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const url = `file://${path.join(__dirname, '..', 'renderer', 'editaddress', 'index.html').replace(/\\/g, '/')}?${qp}#${mode}`;
    win.loadURL(url);
    win.on('closed', () => { if (editAddressPending) { editAddressPending(null); editAddressPending = null; } });
    attachDevHooks(win);
    win.__resolveEditAddress = (payload) => {
      if (editAddressPending) { editAddressPending(payload); editAddressPending = null; }
      win.close();
    };
  });
});
ipcMain.handle('alias:edit-address-result', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && typeof win.__resolveEditAddress === 'function') win.__resolveEditAddress(payload);
});

// Backup wallet — file save dialog + dumpwallet RPC.
ipcMain.handle('alias:backup-wallet', async () => {
  const r = await dialog.showSaveDialog(mainWindow || undefined, {
    title: 'Backup Wallet',
    defaultPath: 'wallet.dat',
    filters: [{ name: 'Wallet Data', extensions: ['dat'] }],
  });
  if (r.canceled || !r.filePath) return null;
  try {
    // backupwallet <destination> — Bitcoin-core RPC that copies wallet.dat
    await rpc('backupwallet', [r.filePath]);
    return r.filePath;
  } catch (e) {
    dialog.showErrorBox('Backup Failed', 'There was an error trying to save the wallet data to the new location.');
    return null;
  }
});

// Modal Yes/Cancel confirmation for send. Strings come from the renderer
// (built by the bridge to mirror the original QMessageBox::question text).
ipcMain.handle('alias:confirm-send', async (_event, opts) => {
  opts = opts || {};
  const r = await dialog.showMessageBox(mainWindow || splashWindow || undefined, {
    type: 'question',
    title: opts.title || 'Confirm send coins',
    message: opts.message || 'Are you sure?',
    buttons: ['Yes', 'Cancel'],
    defaultId: 1, // Cancel default — matches the original QMessageBox::Cancel default
    cancelId: 1,
    noLink: true,
  });
  return r.response === 0;
});

// ---------- windows ----------

function attachDevHooks(win) {
  if (!isDev) return;
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = ['LOG','INFO','WARN','ERROR'][level] || 'LOG';
    console.log(`[renderer ${lvl}] ${message}  (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer load fail] ${code} ${desc} ${url}`);
  });
}

function attachScreenshotHook(win) {
  const ssIdx = process.argv.indexOf('--screenshot');
  const outPath = (ssIdx !== -1 && process.argv[ssIdx + 1]) ? process.argv[ssIdx + 1] : null;
  // Optional --hash <tab> navigates to #<tab> (e.g. send / receive / transactions).
  const hIdx = process.argv.indexOf('--hash');
  const hash = (hIdx !== -1 && process.argv[hIdx + 1]) ? process.argv[hIdx + 1] : null;
  // Optional --exec-js <jsFile> runs a JS file in the renderer.
  const xIdx = process.argv.indexOf('--exec-js');
  const xFile = (xIdx !== -1 && process.argv[xIdx + 1]) ? process.argv[xIdx + 1] : null;
  // Optional --settle <ms> overrides the default settle delay before
  // capture/quit. Either --screenshot or --exec-js must be present for the
  // hook to run at all.
  const sIdx = process.argv.indexOf('--settle');
  const settleMs = (sIdx !== -1 && process.argv[sIdx + 1]) ? parseInt(process.argv[sIdx + 1], 10) : 10000;
  if (!outPath && !xFile) return;

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (hash) {
          await win.webContents.executeJavaScript(
            `$("#navitems a[href='#${hash}']").trigger('click'); void 0;`
          );
          await new Promise(r => setTimeout(r, 1500));
        }
        if (xFile && fs.existsSync(xFile)) {
          const code = fs.readFileSync(xFile, 'utf8');
          const r = await win.webContents.executeJavaScript(code);
          console.log('[exec-js result]', JSON.stringify(r));
          await new Promise(r => setTimeout(r, 3000));
        }
        if (outPath) {
          // If exec-js opened a modal child window (passphrase dialog,
          // wizard, etc.), capture that one instead of the main.
          const all = BrowserWindow.getAllWindows();
          const target = all.find((w) => w !== win && /\/(passphrase|wizard|about|editaddress|coincontrol)\//.test(w.webContents.getURL()))
                      || win;
          const img = await target.webContents.capturePage();
          const buf = img.toPNG();
          if (!buf || buf.length === 0) {
            console.error('[screenshot] capturePage returned empty buffer');
          } else {
            fs.writeFileSync(outPath, buf);
            console.log(`[screenshot] wrote ${outPath} (${buf.length} bytes)`);
          }
        }
      } catch (e) { console.error('[screenshot/exec-js] failed', e); }
      app.quit();
    }, settleMs);
  });
}

// Splash — borderless 600×686 dark window with the ALIAS Stacked Reverse
// logo, shown during daemon startup. Closed once the main window or wizard
// has finished loading.
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 600, height: 686, useContentSize: true,
    frame: false,
    resizable: false, minimizable: false, maximizable: false,
    movable: false,
    alwaysOnTop: true,
    transparent: false,
    title: 'Alias',
    icon: APP_ICON,
    backgroundColor: '#282829',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, '..', 'renderer', 'splash', 'index.html'));
  splashWindow.on('closed', () => { splashWindow = null; });
}

function splashStatus(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('alias:splash-status', String(text || ''));
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    try { splashWindow.close(); } catch (_) {}
  }
  splashWindow = null;
}

function createWizardWindow() {
  // Match the original Qt SetupWalletWizard exactly: content area 516×456
  // (total window incl Windows title bar = 516×486). useContentSize=true so
  // width/height refer to content, not the outer frame.
  wizardWindow = new BrowserWindow({
    width: 516,
    height: 456,
    useContentSize: true,
    title: 'Alias Wallet Setup',
    icon: APP_ICON,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  wizardWindow.loadFile(path.join(__dirname, '..', 'renderer', 'wizard', 'index.html'));
  wizardWindow.on('closed', () => { wizardWindow = null; });
  attachDevHooks(wizardWindow);
  attachScreenshotHook(wizardWindow);
}

function createMainWindow() {
  // Match the original Alias v4.4.0 client window: ~1280×720 content area
  // (1296×759 outer with Windows chrome — 16:9).
  const saved = settings.get('mainBounds') || { width: 1280, height: 720 };
  mainWindow = new BrowserWindow({
    width:  saved.width,
    height: saved.height,
    x:      Number.isFinite(saved.x) ? saved.x : undefined,
    y:      Number.isFinite(saved.y) ? saved.y : undefined,
    useContentSize: true,
    title: 'Alias - Client',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Persist bounds on close so the next launch reopens at the same size/spot.
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getContentBounds();
      settings.set('mainBounds', b);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  attachDevHooks(mainWindow);
  attachScreenshotHook(mainWindow);
}

// ---------- first-launch routing ----------

async function waitForRpcReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await rpc('getinfo', []); return true; } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Detect first launch BEFORE starting the daemon — the daemon auto-creates
// a default master + account within seconds of first start, so any
// extkey-list-based check is racy and would always look "non-empty".
function isFirstLaunch() {
  if (skipSetup)  return false;
  if (forceSetup) return true;
  const walletPath = path.join(getDataDir(), 'wallet.dat');
  return !fs.existsSync(walletPath);
}

// Long-lived session unlock — 24h. Matches the user expectation that they
// unlock once at launch and the wallet stays usable until they close the app.
const SESSION_UNLOCK_SECS = 86400;

async function promptUnlockAtLogin() {
  const r = await openPassphraseDialog('unlocklogin');
  if (!r || !r.passphrase) return false;
  try {
    // walletpassphrase <pass> <timeout> [stakingOnly]
    const params = [r.passphrase, SESSION_UNLOCK_SECS];
    if (r.stakingOnly) params.push(true);
    await rpc('walletpassphrase', params);
    return true;
  } catch (e) {
    // Show the dialog again with a (TODO) error hint; for now retry once.
    console.error('[startup] unlock failed:', e.message);
    return await promptUnlockAtLogin();
  }
}

async function routeStartup() {
  const firstLaunch = isFirstLaunch();
  // Show splash immediately so the user has visible feedback while the daemon
  // boots. Matches the original Alias QSplashScreen.
  createSplashWindow();
  splashStatus('Loading...');
  startDaemon();
  splashStatus('Starting Tor and daemon...');
  const ready = await waitForRpcReady(20000);
  if (!ready) {
    console.error('Daemon RPC never came up — opening main window anyway.');
    closeSplash();
    createMainWindow();
    return;
  }

  if (firstLaunch) {
    console.log('[setup] no wallet.dat — opening Setup Wizard.');
    splashStatus('Setup required.');
    closeSplash();
    createWizardWindow();
    return;
  }

  // If wallet is encrypted + locked, prompt the user for the passphrase
  // BEFORE opening the main window. Matches the original v4.4.0 launch flow.
  try {
    splashStatus('Update balance...');
    const info = await rpc('getinfo', []);
    const isEncrypted = info && info.unlocked_until !== undefined;
    const isLocked    = isEncrypted && info.unlocked_until === 0;
    if (isLocked) {
      console.log('[startup] wallet encrypted+locked — prompting for passphrase.');
      const ok = await promptUnlockAtLogin();
      if (!ok) { console.log('[startup] unlock cancelled — quitting.'); app.quit(); return; }
    }
  } catch (e) { console.warn('[startup] getinfo failed during unlock check:', e.message); }

  splashStatus('...Start UI...');
  createMainWindow();
  // Close splash once main window has finished loading.
  mainWindow.webContents.once('did-finish-load', () => closeSplash());
}

app.whenReady().then(() => {
  // No menu bar — matches the original Alias 4.4.0 (Qt-based UI had none).
  // The renderer's HTML sidebar IS the navigation; the default File/Edit/View
  // menu just sits unused on every window. Edit-style keyboard shortcuts
  // (Ctrl+C/V/X, etc.) still work because Chromium handles them directly.
  Menu.setApplicationMenu(null);
  return routeStartup();
});
app.on('window-all-closed', () => {
  if (daemonProc) daemonProc.kill();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { settings.set('mainBounds', mainWindow.getContentBounds()); } catch (_) {}
  }
  if (daemonProc) daemonProc.kill();
});
