# ALIAS Wallet Desktop

Electron-based desktop front-end for ALIAS Wallet. Replaces the Qt-based GUI from the legacy `alias-wallet` repo while keeping the original `alias-wallet-ui` HTML/CSS/JS look unchanged.

## Architecture

```
+-------------------------------------------+
| Electron main process (src/main/main.js)  |
|  - spawns aliaswalletd                    |
|  - writes alias.conf w/ random rpcpassword|
|  - ipcMain.handle('alias:rpc')            |
+--------------------+----------------------+
                     |  IPC
+--------------------v----------------------+
| Preload (src/preload.js)                  |
|  - contextBridge: window.aliasBridge.rpc()|
+--------------------+----------------------+
                     |
+--------------------v----------------------+
| Renderer (src/renderer/)                  |
|  - original alias-wallet-ui (unchanged)   |
|  - qtwebchannel/qwebchannel.js is now a   |
|    SHIM mimicking Qt's QWebChannel and    |
|    forwarding calls to aliasBridge.rpc    |
+-------------------------------------------+
                     |
                     v
               aliaswalletd
            (JSON-RPC on 36657)
```

The original UI calls `new QWebChannel(qt.webChannelTransport, ...)` and then `channel.objects.bridge.userAction(...)`. The shim implements the same API surface, so the legacy UI runs without modification.

## Layout

```
alias-wallet-desktop/
├── src/
│   ├── main/main.js          # Electron main: daemon launcher + IPC
│   ├── preload.js            # contextBridge for aliasBridge.rpc
│   └── renderer/
│       ├── index.html        # original alias-wallet-ui index
│       ├── assets/           # original CSS / JS / images / plugins
│       └── qtwebchannel/
│           └── qwebchannel.js  # SHIM (drop-in replacement)
├── resources/
│   └── windows/x86_64/aliaswalletd.exe   # bundled by electron-builder
└── package.json
```

`resources/<platform>/<arch>/aliaswalletd[.exe]` is gitignored; populate it by copying from `../alias-modernized/dist/<platform>/`.

## Development

```bash
npm install
npm run dev
```

In dev mode (`--dev`) the daemon is loaded from `../alias-modernized/dist/<platform>/`, so the locally-built binary is picked up without copying.

### Tor dependency

The ALIAS daemon hardcodes a Tor subprocess and refuses to start without `Tor/tor.exe` (Windows / macOS) or `tor` on `$PATH` (Linux) next to the binary. There is no `-noonion` flag.

We ship the Tor Project's **Expert Bundle** (statically linked, no DLLs):

```
Tor/tor.exe          # from tor-expert-bundle-windows-x86_64-<ver>.tar.gz
Tor/geoip
Tor/geoip6
Tor/torrc-defaults   # minimal — no pluggable transports
```

Stage layout:

```
alias-modernized/dist/windows-x86_64/Tor/   # dev (npm run dev picks up from here)
resources/windows/x86_64/Tor/               # packaged (electron-builder)
```

Both are gitignored — fetch with:

```bash
curl -L -o /tmp/tor.tgz \
  https://archive.torproject.org/tor-package-archive/torbrowser/15.0.14/tor-expert-bundle-windows-x86_64-15.0.14.tar.gz
mkdir -p /tmp/tor && tar -xzf /tmp/tor.tgz -C /tmp/tor
# Repeat the cp into both alias-modernized/dist/windows-x86_64/Tor/ and resources/windows/x86_64/Tor/
```

Electron's main process seeds `geoip` / `geoip6` into the user data dir's `tor/` folder on first launch (the daemon hands those paths to Tor via `--GeoIPFile` / `--GeoIPv6File`), and spawns the daemon with `cwd` pointed at the daemon's directory so the daemon's relative `CreateProcessA("Tor/tor.exe", ...)` resolves correctly.

## Building installers

```bash
npm run build:win    # → dist/ALIAS Wallet Setup <version>.exe (nsis)
npm run build:linux  # → dist/ALIAS Wallet-<version>.AppImage + .deb
npm run build:mac    # → dist/ALIAS Wallet-<version>.dmg
```

Each installer bundles the daemon from `resources/<platform>/<arch>/` into the packaged app under `resources/daemon/`.

CI/CD: the GitHub Actions secrets and variables required by the release workflow are documented in [CI-SECRETS.md](CI-SECRETS.md).

## RPC contract

- Port: `36657` (loopback only).
- User: `aliaswallet`.
- Password: regenerated per launch (24 random bytes hex). Written to `~/.alias/alias.conf` (`%APPDATA%/Alias/alias.conf` on Windows, `~/Library/Application Support/Alias/alias.conf` on macOS).
- Renderer never sees credentials — all RPC goes through `ipcMain.handle('alias:rpc')`.

## Porting the bridge

The shim at `src/renderer/qtwebchannel/qwebchannel.js` does three jobs:

1. **Intercepts `new WebSocket("ws://127.0.0.1:...")`** so the UI's WebSocket-based QtWebChannel transport "connects" against an in-process fake. The fake satisfies Pace.js's `addEventListener` calls and fires `onopen` on next tick.
2. **Provides three channel objects** (`bridge`, `optionsModel`, `walletModel`) with method implementations + a Proxy that lazily creates a dual-purpose stub for any unknown property access. The stub is BOTH callable (no-op + warn) and signal-like (`.connect/.disconnect/._emit`), so `bridge.foo()` and `bridge.foo.connect(fn)` both work for not-yet-ported names.
3. **Polls `getinfo`** every 10 s and dispatches `walletModel.balanceChanged` so the overview page updates.

Ported methods (forward to JSON-RPC + emit matching `*Result` signal): `jsReady`, `copy`, `paste`, `urlClicked`, `translateHtmlString`, `getAddressLabel(Async|ForSelectorAsync)`, `updateAddressLabel`, `newAddress`, `deleteAddress`, `populateTransactionTable`, `getInfo`, `getOptions`, `findBlock`, `listLatestBlocks`, `listAnonOutputs`, `validateAddress`, `signMessage`, `verifyMessage`, `transactionDetails`, `addRecipient` (queues), `sendCoins` (drains queue → per-recipient `sendtoaddress` / `sendpublictoprivate` / `sendprivate` / `sendprivatetopublic`), `getNewMnemonic`, `importFromMnemonic`, `extKeyAccList`, `extKeyList`, `extKeySetDefault`, `extKeySetMaster`, `extKeySetActive`, `userAction`.

Still stubbed (no-op + warn — only fire on specific UI actions): `listTransactionsForBlock`, `blockDetails`, `txnDetails`, `updateCoinControlAmount`. The block-explorer details map cleanly to `getrawtransaction`+decoderawtransaction once needed; coin-control needs a shim-side selected-UTXO store wired into `sendCoins` params.

## Visual verification

Capture a screenshot of the running UI:

```bash
node_modules/electron/dist/electron.exe . --dev --screenshot ui.png
```

The renderer process auto-quits 6 s after `did-finish-load`. Useful for headless regression checks.
