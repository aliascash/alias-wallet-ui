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
ipcMain.handle('alias:open-passphrase', (_event, mode) => {
  return new Promise((resolve) => {
    if (passphrasePending) { resolve(null); return; }
    passphrasePending = resolve;
    const win = new BrowserWindow({
      width: 440, height: 200, useContentSize: true,
      parent: mainWindow || wizardWindow || undefined,
      modal: true,
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
});
ipcMain.handle('alias:passphrase-result', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && typeof win.__resolvePassphrase === 'function') win.__resolvePassphrase(payload);
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
  if (ssIdx === -1 || !process.argv[ssIdx + 1]) return;
  const outPath = process.argv[ssIdx + 1];
  // Optional --hash <tab> navigates to #<tab> (e.g. send / receive / transactions)
  // before capturing, so we can screenshot any tab non-interactively.
  const hIdx = process.argv.indexOf('--hash');
  const hash = (hIdx !== -1 && process.argv[hIdx + 1]) ? process.argv[hIdx + 1] : null;
  // Optional --exec-js <jsFile> runs a JS file in the renderer before capture.
  const xIdx = process.argv.indexOf('--exec-js');
  const xFile = (xIdx !== -1 && process.argv[xIdx + 1]) ? process.argv[xIdx + 1] : null;
  // Optional --settle <ms> overrides the default settle delay before capture.
  const sIdx = process.argv.indexOf('--settle');
  const settleMs = (sIdx !== -1 && process.argv[sIdx + 1]) ? parseInt(process.argv[sIdx + 1], 10) : 10000;

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
        // If exec-js opened a modal child window (passphrase dialog,
        // wizard, etc.), capture that one instead of the main.
        const all = BrowserWindow.getAllWindows();
        const target = all.find((w) => w !== win && w.webContents.getURL().includes('/passphrase/'))
                    || all.find((w) => w !== win && w.webContents.getURL().includes('/wizard/'))
                    || win;
        const img = await target.webContents.capturePage();
        const buf = img.toPNG();
        if (!buf || buf.length === 0) {
          console.error('[screenshot] capturePage returned empty buffer');
        } else {
          fs.writeFileSync(outPath, buf);
          console.log(`[screenshot] wrote ${outPath} (${buf.length} bytes)`);
        }
      } catch (e) { console.error('[screenshot] failed', e); }
      app.quit();
    }, settleMs);
  });
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

async function routeStartup() {
  const firstLaunch = isFirstLaunch();
  startDaemon();
  const ready = await waitForRpcReady(20000);
  if (!ready) { console.error('Daemon RPC never came up — opening main window anyway.'); createMainWindow(); return; }
  if (firstLaunch) {
    console.log('[setup] no wallet.dat — opening Setup Wizard.');
    createWizardWindow();
  } else {
    createMainWindow();
  }
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
