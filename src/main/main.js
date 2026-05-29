// Electron main process — launches aliaswalletd, exposes JSON-RPC bridge
// to the renderer, owns the BrowserWindow.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const crypto = require('crypto');
const os = require('os');

const isDev      = process.argv.includes('--dev');
const forceSetup = process.argv.includes('--first-run');  // dev: force-show wizard
const skipSetup  = process.argv.includes('--skip-wizard'); // dev: skip wizard even if first launch

const RPC_PORT = 36657;
const RPC_HOST = '127.0.0.1';
const RPC_USER = 'aliaswallet';
const RPC_PASS = crypto.randomBytes(24).toString('hex');

let daemonProc = null;
let mainWindow = null;
let wizardWindow = null;

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
        const img = await win.webContents.capturePage();
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    title: 'Alias - Client',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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

app.whenReady().then(routeStartup);
app.on('window-all-closed', () => {
  if (daemonProc) daemonProc.kill();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { if (daemonProc) daemonProc.kill(); });
