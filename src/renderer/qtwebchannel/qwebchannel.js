// Drop-in replacement for Qt's qwebchannel.js. Lets the original
// alias-wallet-ui HTML/JS run unchanged in Electron by mimicking the
// QWebChannel API surface and forwarding calls to the daemon via the
// `aliasBridge` IPC contract exposed in preload.js.
//
// The original UI does:
//
//     new QWebChannel(qt.webChannelTransport, function(channel) {
//         window.bridge        = channel.objects.bridge;
//         window.optionsModel  = channel.objects.optionsModel;
//         window.walletModel   = channel.objects.walletModel;
//         bridge.emitTransactions.connect(appendTransactions);  // Qt signal
//         bridge.userAction(...);                                // Qt slot
//     });
//
// We mimic:
//   - Three channel objects (bridge / optionsModel / walletModel).
//   - Signal stubs auto-created on property access — `bridge.foo.connect(fn)`
//     works for any name; `dispatch(obj, name, ...args)` invokes subscribers.
//   - Real method implementations that forward to aliaswalletd JSON-RPC.

(function () {
  'use strict';

  // ---------- signal stub ----------

  // Dual-purpose stub: callable AND signal-like. UI may use the same name
  // as a method (`bridge.foo()`) or as a signal (`bridge.foo.connect(fn)`),
  // and we don't always know which — make both work without throwing.
  function makeSignal(name) {
    const listeners = [];
    const stub = function () {
      console.warn('[shim stub] ' + (name || 'unknown') + ' called as method (not yet ported)');
    };
    stub.connect    = function (fn) { if (typeof fn === 'function') listeners.push(fn); };
    stub.disconnect = function (fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    stub._emit      = function () {
      const args = arguments;
      for (const fn of listeners.slice()) {
        try { fn.apply(null, args); } catch (e) { console.error('[shim signal]', e); }
      }
    };
    return stub;
  }

  // Wrap a plain object in a Proxy so unknown property reads return a
  // lazily-created signal stub. Methods defined on the object win.
  function withSignalProxy(obj) {
    const signals = new Map();
    return new Proxy(obj, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol' || prop === 'then') return undefined; // avoid promise-thenable confusion
        if (!signals.has(prop)) signals.set(prop, makeSignal(String(prop)));
        return signals.get(prop);
      },
      has(target, prop) { return prop in target || typeof prop === 'string'; },
    });
  }

  // ---------- helpers ----------

  function rpc(method, params) {
    if (!window.aliasBridge) {
      return Promise.reject(new Error('aliasBridge not available (preload not wired?)'));
    }
    return window.aliasBridge.rpc(method, params || []);
  }

  function logRpcError(label, err) {
    console.warn('[shim] ' + label + ' failed:', err && err.message ? err.message : err);
  }

  // ---------- encryption helpers ----------

  // Returns 0 = Unencrypted, 1 = Unlocked, 2 = Locked (matches the UI's enum).
  async function getEncryptionStatus() {
    try {
      const info = await rpc('getinfo', []);
      if (!info || info.unlocked_until === undefined) return 0;
      return info.unlocked_until > 0 ? 1 : 2;
    } catch (_) { return 0; }
  }

  // Open the passphrase dialog and await user input.
  // Resolves to the payload returned by passphrase.js, or null on cancel.
  // Tests can set window.__aliasShim.askPassphraseOverride to bypass the
  // modal dialog and supply a payload directly.
  function askPassphrase(mode) {
    const override = window.__aliasShim && window.__aliasShim.askPassphraseOverride;
    if (typeof override === 'function') return Promise.resolve(override(mode));
    if (!window.aliasBridge || !window.aliasBridge.openPassphrase) return Promise.resolve(null);
    return window.aliasBridge.openPassphrase(mode);
  }

  // Run an action that requires an unlocked wallet. Mirrors the original
  // C++ WalletModel::UnlockContext: prompt if needed, restore lock when done.
  async function withUnlock(action) {
    const status = await getEncryptionStatus();
    if (status === 0 || status === 1) return await action();  // unencrypted or already unlocked
    const r = await askPassphrase('unlock');
    if (!r || !r.passphrase) throw new Error('cancelled');
    try {
      // walletpassphrase <passphrase> <timeout> [stakingOnly]
      await rpc('walletpassphrase', [r.passphrase, 60]);
    } catch (e) {
      throw new Error('Wallet unlock failed: ' + (e.message || e));
    }
    try { return await action(); }
    finally { try { await rpc('walletlock', []); } catch (_) {} }
  }

  // Sidebar userAction handlers (matches askpassphrasedialog.cpp invocation
  // points in spectregui.cpp encryptWallet/changePassphrase/unlockWallet).
  async function actionEncryptWallet() {
    const status = await getEncryptionStatus();
    if (status !== 0) { console.warn('[shim] wallet already encrypted'); return; }
    const r = await askPassphrase('encrypt');
    if (!r || !r.passphrase) return;
    try {
      await rpc('encryptwallet', [r.passphrase]);
    } catch (e) {
      // encryptwallet typically restarts the daemon — connection drops mid-call.
      console.warn('[shim] encryptwallet returned/threw (expected at restart):', e.message);
    }
  }
  async function actionChangePassphrase() {
    const r = await askPassphrase('changepass');
    if (!r) return;
    try {
      await rpc('walletpassphrasechange', [r.oldPass, r.newPass]);
    } catch (e) {
      logRpcError('walletpassphrasechange', e);
    }
  }
  async function actionToggleLock() {
    const status = await getEncryptionStatus();
    if (status === 0) { console.warn('[shim] wallet is not encrypted'); return; }
    if (status === 1) {
      try { await rpc('walletlock', []); } catch (e) { logRpcError('walletlock', e); }
      return;
    }
    // status === 2: locked → prompt to unlock
    const r = await askPassphrase('unlock');
    if (!r || !r.passphrase) return;
    try { await rpc('walletpassphrase', [r.passphrase, 60]); }
    catch (e) { logRpcError('walletpassphrase', e); }
  }

  // ---------- bridge ----------
  //
  // Each method here corresponds to a Q_INVOKABLE in src/qt/spectrebridge.h.
  // Many are simple RPC passthroughs; some emit a "<name>Result" signal that
  // the UI listens to.

  // Send-flow recipient queue. Stored in module scope (NOT on the bridge
  // object) because bridge is wrapped in a Proxy that auto-stubs unknown
  // properties — assigning bridge._pendingRecipients would clash with the
  // stub returned by the getter.
  const pendingRecipients = [];

  const bridge = {
    // --- lifecycle ---
    jsReady: function () {
      window.dispatchEvent(new Event('alias:bridge-ready'));
    },

    // --- clipboard ---
    copy: function (text) {
      try { navigator.clipboard.writeText(String(text || '')); } catch (e) { /* noop */ }
    },
    paste: function () { return ''; },  // sync paste isn't available; UI rarely depends on return

    // --- external links ---
    urlClicked: function (url) {
      if (window.aliasBridge && window.aliasBridge.openExternal) {
        window.aliasBridge.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    },

    // --- i18n stub (UI calls this to translate strings; just echo back) ---
    translateHtmlString: function (s) { return s; },

    // --- info: a DATA object the UI reads (build/date) and writes (options).
    // Populated from getinfo on bridge-ready below.
    info: {
      build: 'v4.4.1.0 modernized',
      date:  '',
      options: {},
    },

    // --- address book ---
    getAddressLabel: async function (address) {
      try { return await rpc('getaccount', [address]) || ''; }
      catch (e) { logRpcError('getaccount', e); return ''; }
    },
    getAddressLabelAsync: async function (address) {
      const label = await this.getAddressLabel(address);
      dispatch('bridge', 'getAddressLabelResult', address, label);
    },
    getAddressLabelForSelectorAsync: async function (address) {
      const label = await this.getAddressLabel(address);
      dispatch('bridge', 'getAddressLabelForSelectorResult', address, label);
    },
    updateAddressLabel: async function (address, label) {
      try { await rpc('setaccount', [address, label || '']); }
      catch (e) { logRpcError('setaccount', e); }
    },
    newAddress: async function (label, addressType /*, address, send */) {
      // addressType: 0=normal, 1=stealth, 2=BIP32 (see qt/walletmodel.h)
      const cmd = (addressType === 1) ? 'getnewstealthaddress' : 'getnewaddress';
      try {
        const addr = await rpc(cmd, label ? [label] : []);
        dispatch('bridge', 'newAddressResult', addr, label || '');
        return addr;
      } catch (e) {
        logRpcError(cmd, e);
        dispatch('bridge', 'lastAddressErrorResult', e.message || String(e));
        return '';
      }
    },
    deleteAddress: async function (/* address */) { /* daemon has no delete; noop */ },

    // --- chain / wallet info ---
    populateTransactionTable: async function () {
      try {
        const txs = await rpc('listtransactions', ['*', 50, 0]);
        dispatch('bridge', 'emitTransactions', txs);
        return txs;
      } catch (e) { logRpcError('listtransactions', e); return []; }
    },
    getInfo: async function () {
      try { return await rpc('getinfo', []); }
      catch (e) { logRpcError('getinfo', e); return null; }
    },

    // --- options stub (UI calls bridge.getOptions, expects getOptionResult) ---
    getOptions: function () { /* let optionsModel handle defaults */ },

    // --- block explorer (UI calls these; need RPC mapping to be useful) ---
    findBlock: async function (hashOrHeight) {
      try {
        const r = await rpc('getblock', [String(hashOrHeight)]);
        dispatch('bridge', 'findBlockResult', r);
      } catch (e) { logRpcError('getblock', e); }
    },
    listAnonOutputs: async function () {
      try {
        const r = await rpc('listanonoutputs', []);
        dispatch('bridge', 'listAnonOutputsResult', r);
      } catch (e) { logRpcError('listanonoutputs', e); }
    },
    listLatestBlocks: async function (count) {
      // Minimal: walk back from tip; UI ports may need full re-shape.
      try {
        const info = await rpc('getinfo', []);
        const tip = info && info.blocks;
        const out = [];
        for (let h = tip; h > Math.max(0, tip - (count || 10)); h--) {
          const hash = await rpc('getblockhash', [h]);
          out.push(await rpc('getblock', [hash]));
        }
        dispatch('bridge', 'listLatestBlocksResult', out);
      } catch (e) { logRpcError('listLatestBlocks', e); }
    },

    // --- validation / signing ---
    validateAddress: async function (address) {
      try {
        const r = await rpc('validateaddress', [address]);
        dispatch('bridge', 'validateAddressResult', !!(r && r.isvalid), address);
      } catch (e) {
        logRpcError('validateaddress', e);
        dispatch('bridge', 'validateAddressResult', false, address);
      }
    },
    signMessage: async function (address, message) {
      try {
        const sig = await withUnlock(() => rpc('signmessage', [address, message]));
        dispatch('bridge', 'signMessageResult', true, sig);
      } catch (e) {
        logRpcError('signmessage', e);
        dispatch('bridge', 'signMessageResult', false, e.message || String(e));
      }
    },
    verifyMessage: async function (address, signature, message) {
      try {
        const ok = await rpc('verifymessage', [address, signature, message]);
        dispatch('bridge', 'verifyMessageResult', !!ok);
      } catch (e) {
        logRpcError('verifymessage', e);
        dispatch('bridge', 'verifyMessageResult', false);
      }
    },
    transactionDetails: async function (txid) {
      try {
        const r = await rpc('gettransaction', [txid]);
        dispatch('bridge', 'transactionDetailsResult', JSON.stringify(r, null, 2));
      } catch (e) {
        logRpcError('gettransaction', e);
        dispatch('bridge', 'transactionDetailsResult', '');
      }
    },

    // --- send flow ---
    //
    // Original C++ pattern: addRecipient(...) queues; sendCoins(...) drains
    // and dispatches one RPC per recipient based on txnType:
    //   0 = TXT_SPEC_TO_SPEC   → sendtoaddress
    //   1 = TXT_SPEC_TO_ANON   → sendpublictoprivate
    //   2 = TXT_ANON_TO_ANON   → sendprivate
    //   3 = TXT_ANON_TO_SPEC   → sendprivatetopublic
    addRecipient: function (address, label, narration, amount, txnType) {
      // amount is in satoshis (qint64); RPC takes ALIAS as float string.
      pendingRecipients.push({
        address, label: label || '', narration: narration || '',
        amount: Number(amount) / 1e8, txnType: Number(txnType) || 0,
      });
      dispatch('bridge', 'addRecipientResult', true);
    },
    sendCoins: async function (/* useCoinControl, changeAddress */) {
      const queue = pendingRecipients.splice(0);
      if (queue.length === 0) { dispatch('bridge', 'sendCoinsResult', false); return; }
      const rpcFor = (t) => ({
        0: 'sendtoaddress', 1: 'sendpublictoprivate',
        2: 'sendprivate',   3: 'sendprivatetopublic',
      })[t] || 'sendtoaddress';
      try {
        await withUnlock(async () => {
          for (const r of queue) {
            const params = [r.address, r.amount];
            if (r.narration) params.push(r.label, r.narration);
            else if (r.label) params.push(r.label);
            await rpc(rpcFor(r.txnType), params);
          }
        });
        dispatch('bridge', 'sendCoinsResult', true);
      } catch (e) {
        logRpcError('sendCoins', e);
        dispatch('bridge', 'sendCoinsResult', false);
      }
    },

    // --- generic catch-all ---
    //
    // Four observed shapes:
    //   userAction("aboutClicked")              — string action name
    //   userAction(["clearRecipients"])         — array, first element is action name
    //   userAction({command: ["foo", arg1, ..]}) — explicit RPC pass-through
    //
    // The named string/array actions are UI-side directives. A few of them
    // map to the original Qt's AskPassphraseDialog — handle those by opening
    // our passphrase modal. Everything else is a noop (the UI handles its own
    // state in the Electron port).
    userAction: async function (action) {
      const name = typeof action === 'string' ? action
                 : Array.isArray(action) ? action[0]
                 : null;
      if (name === 'encryptWallet')     return await actionEncryptWallet();
      if (name === 'changePassphrase')  return await actionChangePassphrase();
      if (name === 'toggleLock')        return await actionToggleLock();
      if (name === 'aboutClicked')      return;  // about dialog — future
      if (typeof action === 'string') return;
      if (Array.isArray(action)) return;
      if (action && Array.isArray(action.command)) {
        const [method, ...params] = action.command;
        return await rpc(method, params);
      }
      console.warn('[shim] userAction: unsupported action shape', action);
    },

    // --- mnemonic / extkey ---
    getNewMnemonic: async function (passphrase, language) {
      try {
        const r = await rpc('mnemonic', ['new', passphrase || '', language || 'english']);
        dispatch('bridge', 'getNewMnemonicResult', true, r && (r.mnemonic || r));
      } catch (e) {
        logRpcError('mnemonic new', e);
        dispatch('bridge', 'getNewMnemonicResult', false, e.message || String(e));
      }
    },
    importFromMnemonic: async function (mnemonic, passphrase, label, scanFromTime) {
      try {
        const params = ['import', mnemonic || '', passphrase || ''];
        if (label) params.push(label);
        if (scanFromTime) params.push(scanFromTime);
        const r = await rpc('mnemonic', params);
        dispatch('bridge', 'importFromMnemonicResult', true, r);
      } catch (e) {
        logRpcError('mnemonic import', e);
        dispatch('bridge', 'importFromMnemonicResult', false, e.message || String(e));
      }
    },
    extKeyAccList: async function () {
      try {
        const r = await rpc('extkey', ['list', 'accounts']);
        dispatch('bridge', 'extKeyAccListResult', r);
      } catch (e) { logRpcError('extkey list accounts', e); }
    },
    extKeyList: async function () {
      try {
        const r = await rpc('extkey', ['list']);
        dispatch('bridge', 'extKeyListResult', r);
      } catch (e) { logRpcError('extkey list', e); }
    },
    extKeySetDefault: async function (idHex) {
      try { await rpc('extkey', ['setdefault', idHex]); dispatch('bridge', 'extKeySetDefaultResult', true); }
      catch (e) { logRpcError('extkey setdefault', e); dispatch('bridge', 'extKeySetDefaultResult', false); }
    },
    extKeySetMaster: async function (idHex) {
      try { await rpc('extkey', ['setmaster', idHex]); dispatch('bridge', 'extKeySetMasterResult', true); }
      catch (e) { logRpcError('extkey setmaster', e); dispatch('bridge', 'extKeySetMasterResult', false); }
    },
    extKeySetActive: async function (idHex, active) {
      try { await rpc('extkey', ['options', idHex, 'active', active ? '1' : '0']); dispatch('bridge', 'extKeySetActiveResult', true); }
      catch (e) { logRpcError('extkey setactive', e); dispatch('bridge', 'extKeySetActiveResult', false); }
    },

    // --- coin control noop (UI accumulates; only matters if we wire selected UTXOs into sendCoins) ---
    updateCoinControlAmount: function () { /* TODO: hook into a CoinControl object the shim maintains */ },
  };

  // ---------- optionsModel / walletModel ----------
  //
  // Original Qt exposed these as separate channel.objects.*. The UI subscribes
  // to their signals (displayUnitChanged, balanceChanged, etc.). For now they
  // are signal-only — emit on the proxy and the UI will pick up.

  const optionsModel = {
    // UI may read these synchronously; provide safe defaults.
    displayUnit:        0,    // 0 = ALIAS (full coin)
    reserveBalance:     0,
    rowsPerPage:        25,
    visibleTransactions: [],
  };

  const walletModel = {
    encryptionStatus: 0,  // 0 = Unencrypted (see WalletModel::EncryptionStatus)
    balance:          0,
  };

  // ---------- channel object registry & dispatch ----------

  const proxies = {
    bridge:       withSignalProxy(bridge),
    optionsModel: withSignalProxy(optionsModel),
    walletModel:  withSignalProxy(walletModel),
  };

  // dispatch('bridge', 'emitTransactions', ...args)
  function dispatch(objName, signalName /*, ...args */) {
    const proxy = proxies[objName];
    if (!proxy) return;
    const args = Array.prototype.slice.call(arguments, 2);
    const sig = proxy[signalName];
    if (sig && typeof sig._emit === 'function') sig._emit.apply(null, args);
  }

  // Expose for the bridge methods to call (or for the Electron main process
  // to push signals into the renderer via a future ipcRenderer.on hook).
  window.__aliasShim = { dispatch, proxies };

  // ---------- QWebChannel API surface ----------

  function QWebChannel(transport, callback) {
    const channel = { objects: proxies };
    setTimeout(function () {
      try { callback(channel); }
      catch (e) { console.error('[shim] QWebChannel callback threw', e); }
    }, 0);
  }

  window.QWebChannel = QWebChannel;
  // Some UI code references qt.webChannelTransport — make it harmless.
  window.qt = window.qt || { webChannelTransport: { send: function () {}, onmessage: null } };

  // ---------- WebSocket interception ----------
  //
  // The original UI does:
  //
  //     var socket = new WebSocket("ws://127.0.0.1:52471/?token=...");
  //     socket.onopen = function () { new QWebChannel(socket, cb); };
  //
  // ...because the C++ side ran a QtWebChannel WebSocket server. Electron
  // doesn't run one, so the connection would never open. Intercept WebSocket
  // calls to ws://127.0.0.1 and return a stub that fires onopen immediately.
  // QWebChannel's transport is ignored by our shim anyway.

  const OrigWebSocket = window.WebSocket;
  window.WebSocket = function FakeWebSocket(url) {
    const isLoopback = typeof url === 'string' && /^ws:\/\/127\.0\.0\.1[:/]/.test(url);
    if (!isLoopback) return new OrigWebSocket(url);
    // Some libraries (Pace.js) wrap WebSocket and call .addEventListener on
    // the returned instance — provide a full minimal API surface. Also note:
    // Pace.js loads AFTER this shim and wraps window.WebSocket, so its
    // wrapper sees our FakeWebSocket as the "real" one.
    const listeners = { open: [], close: [], error: [], message: [] };
    const self = {
      url: url,
      readyState: 0,
      onopen: null, onclose: null, onerror: null, onmessage: null,
      send:  function () {},
      close: function () {
        self.readyState = 3;
        const ev = { code: 1000, reason: 'shim' };
        if (self.onclose) self.onclose(ev);
        listeners.close.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } });
      },
      addEventListener:    function (type, fn) { if (listeners[type]) listeners[type].push(fn); },
      removeEventListener: function (type, fn) { if (listeners[type]) { const i = listeners[type].indexOf(fn); if (i >= 0) listeners[type].splice(i, 1); } },
      dispatchEvent:       function () { return true; },
    };
    setTimeout(function () {
      self.readyState = 1;
      const ev = {};
      if (self.onopen) self.onopen(ev);
      listeners.open.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } });
    }, 0);
    return self;
  };

  // ---------- background pollers ----------
  //
  // Replace Qt's C++ side which polled the daemon and emit'd signals into JS.
  // One coordinated poll every POLL_MS: fetches getinfo + listtransactions in
  // parallel, then dispatches the matching signals.

  const POLL_MS = 8000;

  // Map daemon listtransactions output → the compact shape the original C++
  // bridge serialized for the UI. See alias-wallet-ui/assets/js/spectre.js
  // appendTransactions / overviewPage.updateTransaction for fields used.
  function translateTx(rpcTx) {
    const sat = Math.round((Number(rpcTx.amount) || 0) * 1e8);
    let t = 'other';
    switch (rpcTx.category) {
      case 'receive':  t = 'input';  break;
      case 'send':     t = 'output'; break;
      case 'generate': t = 'staked'; break;
      case 'immature': t = 'staked'; break;
      case 'orphan':   t = 'orphan'; break;
      case 'move':     t = 'inout';  break;
    }
    const time = Number(rpcTx.time) || 0;
    return {
      id:      rpcTx.txid || '',
      t:       t,
      t_i:     0,
      s_i:     (Number(rpcTx.confirmations) || 0) < 0 ? 8 : 0,
      am:      sat,
      am_curr: 'PUBLIC',
      d:       time,
      d_s:     time ? new Date(time * 1000).toLocaleString() : '',
      tt:      rpcTx.comment || (rpcTx.address || ''),
      la:      rpcTx.label || '',
      ad:      rpcTx.address || '',
    };
  }

  // Map getinfo.unlocked_until → WalletModel::EncryptionStatus enum.
  //   0 = Unencrypted, 1 = Unlocked, 2 = Locked
  function encStatusFromInfo(info) {
    if (info == null || info.unlocked_until === undefined) return 0;
    return info.unlocked_until > 0 ? 1 : 2;
  }

  window.addEventListener('alias:bridge-ready', function () {
    const seenTxids = new Set();
    let lastEncStatus = -1;

    // Blank the RESERVED balance row at startup. The UI's formatValue clears
    // a cell when value === 0 and showZero is false, so dispatching
    // reserveBalanceChanged(0) once removes the static "0.00" placeholder
    // text from the HTML. The original v4.4.0 wallet did this implicitly via
    // optionsModel init.
    dispatch('optionsModel', 'reserveBalanceChanged', 0);

    async function poll() {
      let info = null, txs = null;
      try { [info, txs] = await Promise.all([rpc('getinfo', []), rpc('listtransactions', ['*', 50, 0])]); }
      catch (e) { return; /* daemon may be syncing / restarting */ }

      if (info) {
        if (info.version) bridge.info.build = info.version;
        walletModel.balance = info.balance;
        // updateBalance(balance, spectreBal, stake, spectreStake,
        //               unconfirmed, spectreUnconfirmed,
        //               immature, spectreImmature)
        // Daemon returns ALIAS-float; UI's unit.format expects satoshis (int64).
        const sat = (v) => Math.round((Number(v) || 0) * 1e8);
        dispatch('walletModel', 'balanceChanged',
          sat(info.balance_public),         sat(info.balance_private),
          sat(info.stake_public),           sat(info.stake_private),
          sat(info.unconfirmedbalance_public), sat(info.unconfirmedbalance_private),
          0, 0  // immature: not exposed in getinfo
        );
        const enc = encStatusFromInfo(info);
        if (enc !== lastEncStatus) {
          walletModel.encryptionStatus = enc;
          dispatch('walletModel', 'encryptionStatusChanged', enc);
          lastEncStatus = enc;
        }
      }

      // Populate the Receive + Address Book tabs by dispatching emitAddresses.
      //
      // Data sources:
      //   listreceivedbyaddress 0 true  → public addresses + .account (label).
      //     Entries with a default label like "Default Public Address" are the
      //     wallet's own (type=R); others (e.g. "Alias Foundation") are
      //     address-book entries (type=S).
      //   listprivateaddresses         → stealth addresses. Unusual response
      //     shape: { Account, "Stealth Address": "<addr> - <label>" }.
      try {
        const [byAddr, privAddrs] = await Promise.all([
          rpc('listreceivedbyaddress', [0, true]).catch(() => []),
          rpc('listprivateaddresses', []).catch(() => null),
        ]);
        const items = [];

        // Public side
        const OWN_HINT = /^(Default|Initial) /;  // labels we set or daemon presets
        for (const r of (Array.isArray(byAddr) ? byAddr : [])) {
          if (!r.address) continue;
          const lbl = r.account || '';
          const isOwn = !lbl || OWN_HINT.test(lbl);
          items.push({
            address:     r.address,
            label:       lbl || 'Unlabeled',
            label_value: lbl,
            pubkey:      'n/a',
            type:        isOwn ? 'R' : 'S',
            at:          0,  // 0/default = Public
          });
        }

        // Stealth side — parse the daemon's combined "addr - label" string.
        if (privAddrs && privAddrs['Stealth Address']) {
          const raw = String(privAddrs['Stealth Address']);
          const sep = raw.indexOf(' - ');
          const addr = sep === -1 ? raw : raw.slice(0, sep);
          const lbl  = sep === -1 ? 'Default Private Address' : raw.slice(sep + 3);
          if (addr) items.push({
            address:     addr,
            label:       lbl,
            label_value: lbl,
            pubkey:      'Stealth Address',
            type:        'R',
            at:          2,  // 2 = Private/Stealth
          });
        }

        if (items.length > 0) dispatch('bridge', 'emitAddresses', items);
      } catch (e) { /* best-effort */ }

      if (Array.isArray(txs)) {
        const translated = txs.map(translateTx);
        // Full-table refresh (covers initial load + history changes).
        dispatch('bridge', 'emitTransactions', translated);
        // Newly-seen txs (after first poll) → also fire a single-row update so
        // the overview's recent-transactions list ticks live.
        if (seenTxids.size > 0) {
          for (const tx of translated) {
            if (tx.id && !seenTxids.has(tx.id)) dispatch('bridge', 'transactionTableChanged', tx);
          }
        }
        for (const tx of translated) if (tx.id) seenTxids.add(tx.id);
      }
    }

    poll();
    setInterval(poll, POLL_MS);
  });
})();
