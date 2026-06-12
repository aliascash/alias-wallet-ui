// Electron main process — launches aliaswalletd, exposes JSON-RPC bridge
// to the renderer, owns the BrowserWindow.

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Tray, Notification, nativeImage } = require('electron');
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
// Global error guards — prevent the app from silently dying on an
// unhandled rejection or uncaught exception. Most often these come from
// renderer RPC calls that fail when the wallet is locked.
process.on('uncaughtException', (e) => {
  console.error('[main] uncaughtException:', e && e.stack || e);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason && reason.stack || reason);
});

app.on('second-instance', (_e, argv) => {
  const win = mainWindow || wizardWindow;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  // On Win/Linux, the alias: URI arrives as a CLI arg on the second instance.
  const uri = (argv || []).find((a) => typeof a === 'string' && a.startsWith('alias:'));
  if (uri && typeof dispatchUriToRenderer === 'function') dispatchUriToRenderer(uri);
});

// First-instance launch may also carry the URI in process.argv.
const initialUriArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('alias:'));

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

// MUST match the daemon's GetDefaultDataDir() in util.cpp:1051-1081 exactly.
// If these diverge, the daemon syncs into a different folder than the one
// the original v4.4.0 wallet (and any pre-extracted blockchain bootstrap)
// uses, forcing a full Initial Block Download from genesis over Tor — which
// takes days instead of minutes.
function getDataDir() {
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Roaming', 'Aliaswallet');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Aliaswallet');
  return path.join(os.homedir(), '.aliaswallet');
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

// One-time migration: earlier builds of this Electron shell pointed the
// daemon at `%APPDATA%\Alias` instead of the daemon's actual default,
// `%APPDATA%\Aliaswallet`. Any wallet that synced under the old path lives
// in the wrong folder. On startup, if the legacy folder exists with the
// real wallet and the canonical folder either doesn't exist or holds only
// stale data, move the legacy folder into place. Older canonical data, if
// any, is renamed to a timestamped backup — nothing is deleted.
function migrateLegacyDataDir() {
  const canonical = getDataDir();
  let legacy;
  if (process.platform === 'win32')      legacy = path.join(os.homedir(), 'AppData', 'Roaming', 'Alias');
  else if (process.platform === 'darwin')legacy = path.join(os.homedir(), 'Library', 'Application Support', 'Alias');
  else                                   legacy = path.join(os.homedir(), '.alias');
  if (legacy === canonical) return;
  const legacyWallet    = path.join(legacy, 'wallet.dat');
  const canonicalWallet = path.join(canonical, 'wallet.dat');
  if (!fs.existsSync(legacyWallet)) return;  // nothing to migrate
  const legacyMtime    = fs.statSync(legacyWallet).mtimeMs;
  const canonicalMtime = fs.existsSync(canonicalWallet) ? fs.statSync(canonicalWallet).mtimeMs : 0;
  if (canonicalMtime >= legacyMtime) return;  // canonical is already newer; user already migrated
  // Back up older canonical (if any), then rename legacy into place.
  if (fs.existsSync(canonical)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = canonical + '.bak-' + stamp;
    fs.renameSync(canonical, backup);
    console.log('[migrate] backed up older canonical data dir to', backup);
  }
  fs.renameSync(legacy, canonical);
  console.log('[migrate] moved active data dir', legacy, '->', canonical);
}

function startDaemon() {
  const daemonPath = getDaemonPath();
  if (!fs.existsSync(daemonPath)) {
    console.error(`Daemon binary not found at: ${daemonPath}`);
    return;
  }
  migrateLegacyDataDir();
  const dataDir = writeAliasConf();
  seedTorFiles(daemonPath, dataDir);
  // cwd must be the daemon's dir — net.cpp CreateProcessA("Tor/tor.exe", ...)
  // resolves the Tor binary relative to the *current* working directory.
  //
  // windowsHide:true suppresses the Windows console window that would
  // otherwise pop up when a GUI process spawns a console subprocess
  // (aliaswalletd is a console app, electron.exe is a GUI app).
  //
  // stdio 'inherit' in dev so the developer sees daemon output in the
  // terminal where they ran `npm start`. In packaged builds Electron
  // has no console, so we 'ignore' the pipes to avoid the OS opening
  // one for buffering.
  // Opt-in faster IBD: set ALIAS_DISABLEWALLET=1 (env var) to launch the
  // daemon with -disablewallet. Wallet still loads (RPC works) but per-block
  // scan is skipped. Next normal launch without the var will rescan forward.
  const daemonArgs = [`-datadir=${dataDir}`, '-server'];
  if (process.env.ALIAS_DISABLEWALLET === '1') {
    daemonArgs.push('-disablewallet');
    console.log('ALIAS_DISABLEWALLET=1 — launching daemon with -disablewallet');
  }
  daemonProc = spawn(daemonPath, daemonArgs, {
    cwd: path.dirname(daemonPath),
    stdio: isDev ? 'inherit' : 'ignore',
    windowsHide: true,
  });
  daemonProc.on('exit', (code, signal) => {
    console.log(`aliaswalletd exited code=${code} signal=${signal}`);
    daemonProc = null;
    // Auto-respawn watchdog: if the daemon dies UNEXPECTEDLY (not
    // because we're shutting down the app, not because gracefulStop is
    // in progress), spawn it again after a short backoff. We've seen
    // the daemon die mid-sync without any shutdown log or Windows
    // crash event (possibly Tor child dying, possibly OOM, possibly an
    // unhandled C++ exception). Whatever the cause, the user shouldn't
    // have to manually relaunch to keep sync going.
    if (!app.isQuiting && !shuttingDown) {
      const backoffMs = 3000;
      console.log(`[watchdog] daemon died unexpectedly — respawning in ${backoffMs} ms`);
      // Kill any lingering Tor child (the daemon spawned it via
      // CreateProcessA so it's not parented to us; if the daemon dies
      // Tor stays orphaned and keeps port 9089 bound, which would
      // prevent a fresh daemon from launching its own Tor).
      try {
        spawn('taskkill', ['/F', '/IM', 'tor.exe'], { windowsHide: true, stdio: 'ignore' });
      } catch (_) {}
      setTimeout(() => {
        if (!app.isQuiting && !shuttingDown && !daemonProc) {
          startDaemon();
        }
      }, backoffMs);
    }
  });
  // NB: log tailer is NOT started here. Callers that want the splash
  // to mirror "Loading block index... / Loading wallet... / Core
  // started!" must call tailDaemonLogToSplash() THEMSELVES *after*
  // createSplashWindow() — otherwise the tailer's setInterval body
  // sees splashWindow=null and immediately clears itself.
}

// One-shot poller: every 400 ms read whatever has been appended to
// debug.log since last tick, scan for the InitMessage-equivalent lines,
// forward each to the splash. Stops when the splash window closes.
let logTailTimer = null;
function tailDaemonLogToSplash(logPath) {
  if (logTailTimer) { clearInterval(logTailTimer); logTailTimer = null; }
  let lastSize = 0;
  // If a previous run left a large log behind, start at the current end
  // so we only surface messages from THIS launch.
  try { lastSize = fs.statSync(logPath).size; } catch (_) { lastSize = 0; }
  logTailTimer = setInterval(() => {
    if (!splashWindow || splashWindow.isDestroyed()) {
      clearInterval(logTailTimer); logTailTimer = null; return;
    }
    let curSize;
    try { curSize = fs.statSync(logPath).size; } catch (_) { return; }
    if (curSize <= lastSize) return;
    let chunk = '';
    try {
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(curSize - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch (_) { return; }
    lastSize = curSize;
    // Original Qt splash shows the daemon's uiInterface.InitMessage(...)
    // strings via an in-process signal. The daemon runs out-of-process for
    // us, so we tail debug.log. Only the messages with a matching LogPrintf
    // appear here; the InitMessage-only ones (per-block progress, etc.)
    // cannot be surfaced without a daemon patch.
    //
    // Each rewrite below uses the ORIGINAL Alias string verbatim — no
    // fabricated text. Sources cited inline.
    const interesting = [
      [/Verifying database integrity/i,  'Verifying database integrity...'],   // init.cpp:668
      [/Loading block index/i,           'Loading block index...'],            // init.cpp:830 LogPrintf
      [/Verifying last (\d+) blocks at level/i, m => 'Validating last ' + m[1] + ' block...'],  // main.cpp Verify + matches init.cpp:847 wording
      [/Loading wallet/i,                'Loading wallet...'],                 // init.cpp:905
      [/Rescanning last (\d+) blocks \(from block (\d+)\)/i, m => 'Rescanning last ' + m[1] + ' blocks (from block ' + m[2] + ')...'],   // daemon's own wording
      [/Done loading/i,                  'Core started!'],                     // init.cpp:1075 InitMessage; debug.log has "Done loading"
    ];
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      for (const [re, out] of interesting) {
        const m = line.match(re);
        if (m) { splashStatus(typeof out === 'function' ? out(m) : out); break; }
      }
    }
  }, 400);
}

// Methods the renderer polls speculatively that the daemon rejects for
// known reasons (listanonoutputs not implemented; getaccount on stealth
// addresses returns 500). The renderer's qwebchannel shim already
// tolerates a null/empty result. Returning null here keeps Electron's
// ipcMain from logging "Error occurred in handler" on every poll.
const SILENT_RPC_METHODS = new Set(['listanonoutputs', 'getaccount']);

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

ipcMain.handle('alias:rpc', async (_event, method, params) => {
  try {
    return await rpc(method, params);
  } catch (e) {
    if (SILENT_RPC_METHODS.has(method)) return null;
    throw e;
  }
});
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

ipcMain.handle('alias:wizard-complete', async (_event, passphrase) => {
  // Persist a flag so isFirstLaunch knows the wizard has been completed,
  // independent of whether the daemon auto-created wallet.dat.
  settings.set('wizardCompleted', true);
  if (wizardWindow) { wizardWindow.close(); wizardWindow = null; }

  // The wizard's last action was `encryptwallet`, which causes the
  // daemon to write the new wallet.dat then call StartShutdown and EXIT
  // (not restart — original Alias's encrypt-and-restart was an in-
  // process Qt action; here the daemon is a separate process). Our
  // child-process exit handler nulled daemonProc. We must re-spawn it
  // explicitly so the wallet UI has something to talk to.
  createSplashWindow();
  // tail BEFORE the daemon starts writing so we don't miss early
  // "Loading block index..." lines.
  tailDaemonLogToSplash(path.join(getDataDir(), 'debug.log'));
  splashStatus('Loading wallet...');

  // CRITICAL RACE: when this IPC arrives, the daemon received
  // encryptwallet and is mid-shutdown (Finalise / Flush / StopNode
  // running) but the process hasn't exited yet — daemonProc is still
  // non-null. A simple `if (!daemonProc) startDaemon()` would skip
  // spawning a fresh daemon, then waitForRpcReady would poll an
  // RPC port that's about to close. Wait for the current process
  // to actually exit (with a 15 s cap in case shutdown hangs) before
  // spawning a fresh one.
  if (daemonProc) {
    splashStatus('Restarting wallet daemon...');
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 15000);
      daemonProc.once('exit', () => { clearTimeout(t); resolve(); });
    });
    // OS needs a beat to release the bound ports (36657, 37347) and
    // wallet.dat file handles before a fresh daemon can bind them.
    await new Promise(r => setTimeout(r, 1500));
  }
  startDaemon();
  // Wait up to 5 min — daemon needs to LoadBlockIndex (~90 s for the
  // bootstrap chain), Verify last 2500 blocks, and load the encrypted
  // wallet before binding RPC.
  await waitForRpcReady(5 * 60 * 1000);

  // Unlock the freshly-encrypted wallet BEFORE opening the main window.
  // Without this, the wallet boots locked and the renderer's first
  // poll catches a half-initialised daemon — sync icon sticks on its
  // HTML default "Checking wallet state with network" and only 4 icons
  // render (encryption padlock stays hidden until poll fires
  // successfully). The user only sees correct state after a manual
  // close + relaunch (which goes through routeStartup's unlock path).
  if (passphrase) {
    try {
      await rpc('walletpassphrase', [passphrase, SESSION_UNLOCK_SECS]);
    } catch (e) {
      // Non-fatal — main window can still open. Most likely cause:
      // wallet ended up unencrypted somehow; user can lock/unlock
      // manually from the UI.
      console.warn('[wizard-complete] walletpassphrase failed:', e.message);
    }
  }

  splashStatus('...Start UI...');
  createMainWindow();
  // mainWindow.once('ready-to-show') closes the splash + shows main.
  mainWindow.webContents.once('did-finish-load', () => { startupComplete = true; });
});
ipcMain.handle('alias:wizard-cancel', () => {
  // Match original Alias behavior: cancelling the wizard exits the app
  // (spectre.cpp:254 `if (!wizard.exec()) return 0;`). Because we don't
  // mark wizardCompleted, the next launch will re-fire the wizard.
  settings.set('wizardCompleted', false);
  if (wizardWindow) wizardWindow.close();
  app.isQuiting = true;
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
      // Original askpassphrasedialog.ui geometry was 598×209; bumped to
      // 280 so the new padded layout shows the OK/Cancel buttons fully.
      width: 620, height: 280, useContentSize: true,
      minWidth: 550, minHeight: 240,
      // Modal requires a parent on Linux; if none yet (startup unlock), the
      // dialog is a standalone always-on-top window.
      parent: parent || undefined,
      modal: !!parent,
      alwaysOnTop: !parent,
      resizable: false, minimizable: false, maximizable: false,
      title: 'ALIAS',
      icon: APP_ICON,
      autoHideMenuBar: true,
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
  Notifications:     ['*'],  // mirrors original OptionsModel default (notify on all tx types)
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

// Debug window — mirrors the original Alias QDialog "Alias - Debug window"
// at 740x480 with Information / Console / Network Traffic tabs.
let debugWindow = null;
ipcMain.handle('alias:open-debug', () => {
  if (debugWindow && !debugWindow.isDestroyed()) { debugWindow.focus(); return; }
  debugWindow = new BrowserWindow({
    width: 740, height: 480, useContentSize: true,
    parent: mainWindow || undefined,
    modal: false,
    title: 'ALIAS - Debug window',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  debugWindow.setMenu(null);
  debugWindow.loadFile(path.join(__dirname, '..', 'renderer', 'debug', 'index.html'));
  attachDevHooks(debugWindow);
  debugWindow.on('closed', () => { debugWindow = null; });
});

ipcMain.handle('alias:open-debug-log', async () => {
  const logPath = path.join(getDataDir(), 'debug.log');
  if (fs.existsSync(logPath)) await shell.openPath(logPath);
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
    autoHideMenuBar: true,
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
    title: 'About ALIAS',
    icon: APP_ICON,
    autoHideMenuBar: true,
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
      autoHideMenuBar: true,
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
    alwaysOnTop: false,  // user must be able to focus other windows during long rescan
    transparent: false,
    title: 'ALIAS',
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
  // The splash renderer registers its IPC listener inside the IIFE that
  // runs on script load — typically ~50 ms after createSplashWindow().
  // Any splashStatus() call we make in that window is silently dropped
  // because Electron's ipcRenderer doesn't buffer. Replay the latest
  // buffered text once the renderer is ready so the first message
  // actually lands.
  splashWindow.webContents.once('did-finish-load', () => {
    if (lastSplashStatusText && splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send('alias:splash-status', lastSplashStatusText);
    }
  });
}

// Latest splash status text — buffered so we can replay it as soon as
// the splash renderer is loaded (see createSplashWindow above).
let lastSplashStatusText = '';
function splashStatus(text) {
  const t = String(text || '');
  lastSplashStatusText = t;
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('alias:splash-status', t);
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    try { splashWindow.close(); } catch (_) {}
  }
  splashWindow = null;
}

function createWizardWindow() {
  // Match the original Qt QWizard ModernStyle proportions: a header band
  // at top (logo + title + subtitle), body below, button footer. Default
  // Qt size is roughly 575×460; we go a bit taller (490) so the 24-word
  // verify grid fits without scrolling.
  wizardWindow = new BrowserWindow({
    width: 575,
    height: 490,
    useContentSize: true,
    title: 'ALIAS Wallet Setup',
    icon: APP_ICON,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
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
  let saved = settings.get('mainBounds') || { width: 1280, height: 720 };
  // Validate saved bounds against current displays — a window restored from
  // a different monitor layout can end up off-screen, looking like the app
  // failed to launch. Drop x/y if the rect doesn't overlap any display.
  const { screen } = require('electron');
  const onScreen = screen.getAllDisplays().some((d) => {
    const r = d.workArea;
    return Number.isFinite(saved.x) && Number.isFinite(saved.y)
        && saved.x + 60 < r.x + r.width
        && saved.x + saved.width  - 60 > r.x
        && saved.y + 20 < r.y + r.height
        && saved.y + 20 > r.y;
  });
  if (!onScreen) saved = { width: saved.width || 1280, height: saved.height || 720 };
  mainWindow = new BrowserWindow({
    width:  saved.width,
    height: saved.height,
    x:      Number.isFinite(saved.x) ? saved.x : undefined,
    y:      Number.isFinite(saved.y) ? saved.y : undefined,
    useContentSize: true,
    // Title format mirrors original SpectreGUI ctor:
    //   setWindowTitle(tr("Alias") + " - " + tr("Client") + " - " + CLIENT_PLAIN_VERSION)
    title: `ALIAS - Client - v${app.getVersion()}.0`,
    icon: APP_ICON,
    show: false,  // shown explicitly after did-finish-load to avoid white flash
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Keep our window title — Electron otherwise replaces it with the page's
  // <title> on load. Matches original SpectreGUI::setWindowTitle().
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); });
  // ready-to-show fires on the first paint — well before did-finish-load
  // (which waits for every CSS/JS/image to settle). Close the splash here
  // so the main window doesn't appear underneath the alwaysOnTop splash
  // for the seconds it takes the renderer to finish loading.
  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow.show();
    mainWindow.focus();
  });

  // Mirror SpectreGUI::changeEvent — minimize-to-tray when option is enabled.
  // QT version hid the window on WindowStateChange + isMinimized + option flag.
  mainWindow.on('minimize', (e) => {
    const opts = settings.get('options') || {};
    if (opts.MinimizeToTray && process.platform !== 'darwin') {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Mirror SpectreGUI::closeEvent — if neither minimize-to-tray nor
  // minimize-on-close is set, the X button quits. Otherwise X just hides
  // (the tray icon is the way back).
  mainWindow.on('close', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getContentBounds();
      settings.set('mainBounds', b);
    }
    const opts = settings.get('options') || {};
    const wantsHide = process.platform !== 'darwin'
                   && (opts.MinimizeToTray || opts.MinimizeOnClose)
                   && !app.isQuiting;
    if (wantsHide) {
      e.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      return;
    }
    // Full quit. The X-click path used to rely on window-all-closed to
    // chain into gracefulStopDaemon + app.quit, but any lingering hidden
    // BrowserWindow (debug/about/splash still in the middle of close) holds
    // window-all-closed from firing, leaving the tray icon and daemon
    // alive indefinitely. Trigger app.quit directly so before-quit destroys
    // the tray and gracefulStopDaemon kills aliaswalletd + tor.
    if (!app.isQuiting) {
      app.isQuiting = true;
      setImmediate(() => app.quit());
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
  // Three-state check:
  //   - wizardCompleted=true  → never re-fire (user finished setup)
  //   - wizardCompleted=false → re-fire (user cancelled mid-wizard)
  //   - flag absent + wallet.dat exists → existing install pre-flag;
  //                                       grandfather as completed.
  //   - flag absent + no wallet.dat    → genuine first launch.
  const flag = settings.get('wizardCompleted');
  if (flag === true)  return false;
  if (flag === false) return true;
  const walletPath = path.join(getDataDir(), 'wallet.dat');
  if (fs.existsSync(walletPath)) {
    // Existing wallet from a build that predated this flag — auto-mark.
    settings.set('wizardCompleted', true);
    return false;
  }
  return true;
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

// Open the passphrase dialog and return what the user typed WITHOUT
// attempting the unlock RPC. Used in routeStartup so the unlock dialog
// can appear before the daemon is ready — the actual walletpassphrase
// call happens later, with a splash showing daemon-load progress.
async function collectPassphraseAtLogin() {
  const r = await openPassphraseDialog('unlocklogin');
  if (!r || !r.passphrase) return null;
  return { passphrase: r.passphrase, stakingOnly: !!r.stakingOnly };
}

async function routeStartup() {
  const firstLaunch = isFirstLaunch();

  // Flow:
  //   First launch      : wizard directly, NO splash. Daemon starts in
  //                       the background. Fresh data dir = fast startup,
  //                       so no progress UI is needed before the wizard.
  //   Encrypted wallet  : splash → unlock dialog → splash → main window.
  //   Unencrypted       : splash → main window.

  if (firstLaunch) {
    console.log('[setup] no wallet.dat — opening Setup Wizard (no splash).');
    startDaemon();
    // Daemon needs to be FULLY RPC-ready (not just port-bound) before
    // the wizard's wallet pages run, otherwise commands like `mnemonic`
    // and `extkey import` hit ECONNREFUSED or 500. With the bootstrap
    // installed by the NSIS installer, LoadBlockIndex of ~2.8M blocks
    // takes ~90 s — give it 5 min headroom.
    const ready = await waitForRpcReady(5 * 60 * 1000);
    if (!ready) {
      console.error('Daemon RPC did not come up in 5 minutes on first launch.');
    }
    createWizardWindow();
    startupComplete = true;
    return;
  }

  // Returning user. UX requirement:
  //   unlock dialog FIRST (no waiting screen)
  //   → splash (showing daemon's "Loading block index..." progression)
  //   → main window
  //
  // The previous design awaited waitForRpcReady BEFORE showing any UI,
  // which meant ~90 seconds of staring at the tray icon while the
  // bootstrap-installed chain was loaded.
  //
  // The new design:
  //   1. Start daemon in the background (no await).
  //   2. Pop the unlock dialog IMMEDIATELY and collect the passphrase
  //      WITHOUT calling walletpassphrase yet (daemon isn't ready).
  //   3. When the user submits, show the splash with the daemon's
  //      live log tail. waitForRpcReady runs here, with progress UI.
  //   4. Send walletpassphrase with the collected passphrase. If the
  //      wallet is unencrypted (edge case — our wizard always
  //      encrypts), the RPC errors with "running with an unencrypted
  //      wallet" which we treat as success.
  //   5. createMainWindow → splash closes on ready-to-show.
  //
  // On wrong passphrase, the dialog re-prompts WITHOUT re-running
  // waitForRpcReady — the daemon stays up across retries.
  startDaemon();

  let daemonReady = false;
  while (true) {
    // 1. Collect passphrase — no daemon needed.
    const collected = await collectPassphraseAtLogin();
    if (!collected) {
      console.log('[startup] unlock cancelled — quitting.');
      app.quit(); return;
    }

    // 2. Show splash + wait for daemon (first iteration only).
    if (!daemonReady) {
      createSplashWindow();
      // Forward daemon's "Loading block index... / Verifying last N
      // blocks... / Loading wallet... / Core started!" lines from
      // debug.log to the splash status text. MUST run after
      // createSplashWindow — the tailer self-cancels if splashWindow
      // is null when its first tick fires.
      tailDaemonLogToSplash(path.join(getDataDir(), 'debug.log'));
      splashStatus('Loading wallet...');
      const ready = await waitForRpcReady(30 * 60 * 1000);
      if (!ready) {
        console.error('Daemon RPC never came up after 30 minutes.');
        splashStatus('Daemon failed to start');
        createMainWindow();
        return;
      }
      daemonReady = true;
    }

    // 3. Try to unlock.
    try {
      const params = [collected.passphrase, SESSION_UNLOCK_SECS];
      if (collected.stakingOnly) params.push(true);
      await rpc('walletpassphrase', params);
      break;  // unlock success
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/unencrypted/i.test(msg)) {
        // Wallet is not encrypted — no unlock needed, continue to main.
        break;
      }
      // Wrong passphrase. Close splash so the next unlock dialog isn't
      // hidden behind it, then loop.
      console.error('[startup] unlock failed:', msg);
      closeSplash();
    }
  }

  // 4. Final message before window.loadIndex() — spectre.cpp:350
  splashStatus('...Start UI...');
  createMainWindow();
  // Close splash once main window has finished loading. Fallback: force-show
  // after 12s in case did-finish-load never fires (renderer hang) — splash
  // dismissed + main window shown so the user sees SOMETHING.
  const splashCloseTimeout = setTimeout(() => {
    console.warn('[startup] did-finish-load timeout — forcing main window show');
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  }, 12000);
  mainWindow.webContents.once('did-finish-load', () => {
    clearTimeout(splashCloseTimeout);
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    if (initialUriArg) dispatchUriToRenderer(initialUriArg);
    startupComplete = true;
  });
  mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
    console.error('[startup] did-fail-load', code, desc);
    clearTimeout(splashCloseTimeout);
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    startupComplete = true;
  });
}

// System tray icon — matches original SpectreGUI::createTrayIcon. Click to
// toggle main-window show/hide; context menu mirrors original ordering
// (toggle, Options, RPC Console, Quit). Stored at module scope so it isn't
// GC'd and so we can hide it on quit.
let trayIcon = null;
function createTray() {
  if (trayIcon) return;
  try {
    const img = nativeImage.createFromPath(APP_ICON);
    trayIcon = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  } catch (_) { trayIcon = new Tray(nativeImage.createEmpty()); }
  trayIcon.setToolTip('ALIAS');
  const buildMenu = () => Menu.buildFromTemplate([
    { label: mainWindow && mainWindow.isVisible() ? 'Hide ALIAS' : 'Show ALIAS',
      click: () => { if (!mainWindow) return; if (mainWindow.isVisible()) mainWindow.hide(); else { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '&Options...', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.executeJavaScript(`$('#navitems a[href="#options"]').click();`).catch(() => {}); } } },
    { label: '&Debug window', click: () => ipcMain.emit('alias:open-debug') /* falls through handle */ },
    { type: 'separator' },
    { label: 'E&xit', click: () => app.quit() },
  ]);
  trayIcon.setContextMenu(buildMenu());
  trayIcon.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide(); else { mainWindow.show(); mainWindow.focus(); }
    trayIcon.setContextMenu(buildMenu());
  });
}

// Notify user of incoming transactions. The renderer detects new tx via
// the poll loop and forwards via this IPC, which fires a native OS
// notification through Electron's built-in Notification API (replaces the
// original Notificator).
ipcMain.handle('alias:notify', (_event, title, body) => {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title: String(title || 'ALIAS'), body: String(body || ''), silent: false }).show();
  } catch (_) {}
});

// Native modal info dialog with the app's own titlebar. The renderer's
// window.alert() shows the package name instead of our productName, which
// looks broken — call this from the renderer instead for any user-facing
// alert/info messages.
ipcMain.handle('alias:show-alert', async (_event, title, message) => {
  const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
  await dialog.showMessageBox(parent, {
    type: 'info',
    title:   String(title   || 'ALIAS'),
    message: String(title   || 'ALIAS'),
    detail:  String(message || ''),
    buttons: ['OK'],
    noLink: true,
  });
});

// alias: URI handler — mirror SpectreGUI::handleURI. Fired on second-instance
// launches (Win/Linux pass URI as argv) and macOS open-url. The renderer
// receives the URI via 'alias:uri-open' and pre-fills the Send recipient.
function dispatchUriToRenderer(uri) {
  if (!uri || !uri.startsWith('alias:')) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('alias:uri-open', uri);
  } catch (_) {}
}
try { app.setAsDefaultProtocolClient('alias'); } catch (_) {}
app.on('open-url', (event, uri) => { event.preventDefault(); dispatchUriToRenderer(uri); });

// Build the application menu matching original SpectreGUI::createMenuBar.
// On non-Mac the bar is hidden (matching `appMenuBar->hide()` in original)
// but the actions exist so keyboard accelerators still trigger.
// Bring main window forward + click a renderer element. Used for menu items
// that should fire the same JS handler the in-page button would.
function triggerInRenderer(sel) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show(); mainWindow.focus();
  mainWindow.webContents.executeJavaScript(`$(${JSON.stringify(sel)}).click(); void 0;`).catch(() => {});
}

function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        // Backup uses the same handler as the in-page button: trigger the
        // sidebar Backup-Wallet entry which calls bridge.userAction(["backupWallet"]).
        { label: '&Backup Wallet...', click: () => triggerInRenderer('a[onclick*="backupWallet"]') },
        { type: 'separator' },
        { label: 'E&xit', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '&Settings',
      submenu: [
        { label: '&Encrypt Wallet...',     click: () => triggerInRenderer('a[onclick*="encryptWallet"]') },
        { label: '&Change Passphrase...',  click: () => triggerInRenderer('a[onclick*="changePassphrase"]') },
        { label: '&(Un)lock Wallet...',    click: () => triggerInRenderer('#toggleLock a') },
        { type: 'separator' },
        { label: '&Options...', accelerator: 'CmdOrCtrl+,', click: () => triggerInRenderer('#navitems a[href="#options"]') },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: '&Debug window', click: () => triggerInRenderer('a[onclick*="debugClicked"]') },
        { type: 'separator' },
        { label: '&About ALIAS',  click: () => triggerInRenderer('a[onclick*="aboutClicked"]') },
      ],
    },
  ]);
}

app.whenReady().then(() => {
  // Original SpectreGUI builds the menu bar with File/Settings/Help.
  // On macOS the bar is visible at top-of-screen; on Win/Linux it is created
  // then hidden (`appMenuBar->hide()`) so accelerators (Ctrl+Q, Ctrl+,, etc.)
  // still trigger via Chromium's accelerator system.
  Menu.setApplicationMenu(buildAppMenu());
  if (process.platform !== 'darwin') {
    // Equivalent of appMenuBar->hide() — set autoHideMenuBar on every
    // window we create below; here we just hide it on the main one when
    // it's created.
  }
  createTray();
  return routeStartup();
});
// Graceful daemon shutdown: prefer the JSON-RPC 'stop' command (lets the
// daemon flush wallet.dat + block index), wait up to 8s for the process to
// exit, then SIGKILL as fallback. Synchronous wait on the exit promise
// keeps Electron from quitting before the daemon finishes writing.
let shuttingDown = false;
async function gracefulStopDaemon() {
  if (!daemonProc || shuttingDown) return;
  shuttingDown = true;
  try { await rpc('stop', []); } catch (_) { /* daemon may already be exiting */ }
  // Wait for the process to actually exit so wallet.dat lands on disk.
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { if (daemonProc) daemonProc.kill(); } catch (_) {}
      resolve();
    }, 8000);
    if (!daemonProc) { clearTimeout(t); resolve(); return; }
    daemonProc.once('exit', () => { clearTimeout(t); resolve(); });
  });
  daemonProc = null;
}

// During routeStartup the passphrase dialog can be the ONLY open
// BrowserWindow for a moment (between dialog.close() and createMainWindow).
// Without this flag, that gap fires `window-all-closed` → gracefulStopDaemon
// → app.quit, killing the freshly-shown main window ~1s later.
let startupComplete = false;
// `window-all-closed` used to call gracefulStopDaemon + app.quit. That
// turned out to be the source of phantom daemon shutdowns: any brief
// gap between BrowserWindows (passphrase dialog closing → main window
// reopening, splash close mid-handoff, child window's `closed` event
// firing before the next window's `ready-to-show`, etc.) would fire
// this and tear the daemon down even though the user was still using
// the app. The only legitimate quit paths are:
//   - User clicks X on main window → mainWindow.on('close') calls
//     app.quit(), which fires before-quit, which stops the daemon
//   - User picks Exit from tray → menu click calls app.quit()
//   - User chooses File → Exit menu accelerator → app.quit()
// All three go through before-quit, so this handler being a no-op is
// safe: the daemon is always cleaned up when the user actually quits.
app.on('window-all-closed', () => {
  // No-op. Daemon teardown is handled exclusively by before-quit.
});
app.on('before-quit', (e) => {
  app.isQuiting = true;  // unblock the close-event minimize-to-tray hold
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { settings.set('mainBounds', mainWindow.getContentBounds()); } catch (_) {}
  }
  if (trayIcon) { try { trayIcon.destroy(); } catch (_) {} trayIcon = null; }
  // Force-destroy every BrowserWindow so a lingering hidden child (debug,
  // about, splash mid-close) cannot keep the app process alive.
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.destroy(); } catch (_) {}
  }
  // before-quit may fire before window-all-closed. If the daemon is still
  // alive, hold the quit while we ask it to stop gracefully.
  if (daemonProc && !shuttingDown) {
    e.preventDefault();
    gracefulStopDaemon().then(() => app.quit());
  }
});
