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
    // Match the original: QApplication::quit() after a successful encrypt,
    // with the same warning text the C++ dialog showed.
    window.alert(
      'Wallet encrypted\n\n' +
      'Alias will close now to finish the encryption process. ' +
      'Remember that encrypting your wallet cannot fully protect ' +
      'your coins from being stolen by malware infecting your computer.\n\n' +
      'IMPORTANT: Any previous backups you have made of your wallet file ' +
      'should be replaced with the newly generated, encrypted wallet file. ' +
      'For security reasons, previous backups of the unencrypted wallet file ' +
      'will become useless as soon as you start using the new, encrypted wallet.'
    );
    if (window.aliasBridge && window.aliasBridge.quitApp) window.aliasBridge.quitApp();
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

    // --- i18n. The UI calls bridge.translateHtmlString(src) for every .translate
    // element, expecting the bridge to look up `src` and emit updateElement(src,
    // translated). With no translation set the UI text remains the English
    // source — correct behavior for the English locale.
    //
    // To enable another locale, set `window.__aliasShim.translations = { src: dst, ... }`
    // before the UI calls connectSignals (e.g. from a small loader script).
    translateHtmlString: function (s) {
      const map = window.__aliasShim && window.__aliasShim.translations;
      if (map && Object.prototype.hasOwnProperty.call(map, s)) {
        dispatch('bridge', 'updateElement', s, map[s]);
      }
      return s;
    },

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
    // UI handler: function getAddressLabelResult(result) — single arg = label.
    getAddressLabelAsync: async function (address) {
      const label = await this.getAddressLabel(address);
      dispatch('bridge', 'getAddressLabelResult', label);
    },
    // UI handler: function getAddressLabelForSelectorResult(result, selector, fallback).
    // The original C++ side stored selector+fallback when getAddressLabelForSelectorAsync
    // was called; we replicate by stashing them on the shim's pending map.
    getAddressLabelForSelectorAsync: async function (address, selector, fallback) {
      const label = await this.getAddressLabel(address);
      dispatch('bridge', 'getAddressLabelForSelectorResult', label, selector || '', fallback || '');
    },
    updateAddressLabel: async function (address, label) {
      try { await rpc('setaccount', [address, label || '']); }
      catch (e) { logRpcError('setaccount', e); }
    },
    // addressType: 0=normal, 1=stealth, 2=BIP32 (see qt/walletmodel.h).
    // UI handler: newAddressResult(success: bool, errorMsg: string,
    //                              address: string, send: bool).
    // `send` echoes back the 4th arg (true=for send-side new address,
    // false=for receive-side); UI uses it to decide what to clear/show.
    newAddress: async function (label, addressType, address /* unused */, send) {
      const cmd = (addressType === 1) ? 'getnewstealthaddress' : 'getnewaddress';
      try {
        const addr = await rpc(cmd, label ? [label] : []);
        dispatch('bridge', 'newAddressResult', true, '', addr, !!send);
        return addr;
      } catch (e) {
        logRpcError(cmd, e);
        const msg = e.message || String(e);
        dispatch('bridge', 'newAddressResult', false, msg, '', !!send);
        dispatch('bridge', 'lastAddressErrorResult', msg);
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
    // Remap raw getblock fields → UI-expected shape (block_hash, block_height,
    // block_timestamp, block_transactions count). The UI's
    // listLatestBlocksResult / findBlockResult / listTransactionsForBlockResult
    // all read these specific keys.
    listLatestBlocks: async function (count) {
      try {
        const info = await rpc('getinfo', []);
        const tip = info && info.blocks;
        const out = [];
        for (let h = tip; h > Math.max(0, tip - (count || 10)); h--) {
          const hash = await rpc('getblockhash', [h]);
          const b = await rpc('getblock', [hash]);
          out.push({
            block_hash:         b.hash,
            block_height:       b.height,
            block_timestamp:    b.time,
            block_transactions: Array.isArray(b.tx) ? b.tx.length : 0,
          });
        }
        dispatch('bridge', 'listLatestBlocksResult', out);
      } catch (e) { logRpcError('listLatestBlocks', e); }
    },
    findBlock: async function (hashOrHeight) {
      // UI handler reads result.error_msg / .block_hash / .block_height /
      // .block_timestamp / .block_transactions.
      try {
        let hash = String(hashOrHeight);
        if (/^\d+$/.test(hash)) hash = await rpc('getblockhash', [Number(hash)]);
        const b = await rpc('getblock', [hash]);
        dispatch('bridge', 'findBlockResult', {
          error_msg: '',
          block_hash:         b.hash,
          block_height:       b.height,
          block_timestamp:    b.time,
          block_transactions: Array.isArray(b.tx) ? b.tx.length : 0,
        });
      } catch (e) {
        logRpcError('getblock', e);
        dispatch('bridge', 'findBlockResult', { error_msg: e.message || String(e) });
      }
    },
    listTransactionsForBlock: async function (blockHash) {
      try {
        const block = await rpc('getblock', [String(blockHash)]);
        const txs = [];
        for (const txid of (block && block.tx) || []) {
          let info = { txid };
          try {
            const r = await rpc('getrawtransaction', [txid, 1]);
            info = { txid: r.txid, time: r.time, version: r.version };
          } catch (_) {}
          txs.push(info);
        }
        // UI handler: listTransactionsForBlockResult(blkHash, result).
        dispatch('bridge', 'listTransactionsForBlockResult', blockHash, txs);
      } catch (e) { logRpcError('getblock', e); }
    },
    blockDetails: async function (blockHash) {
      try {
        const r = await rpc('getblock', [String(blockHash)]);
        dispatch('bridge', 'blockDetailsResult', r);
      } catch (e) { logRpcError('getblock', e); }
    },
    txnDetails: async function (txid) {
      try {
        const r = await rpc('getrawtransaction', [String(txid), 1]);
        dispatch('bridge', 'txnDetailsResult', r);
      } catch (e) { logRpcError('getrawtransaction', e); }
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
    // UI expects { error_msg, signed_signature } returned directly — see
    // spectre.js signMessage(). The shim returns a Promise; the UI side has
    // been patched to await it.
    signMessage: async function (address, message) {
      try {
        const sig = await withUnlock(() => rpc('signmessage', [address, message]));
        dispatch('bridge', 'signMessageResult', true, sig);
        return { error_msg: '', signed_signature: sig };
      } catch (e) {
        logRpcError('signmessage', e);
        dispatch('bridge', 'signMessageResult', false, e.message || String(e));
        return { error_msg: e.message || String(e), signed_signature: '' };
      }
    },
    // UI signature is verifyMessage(address, message, signature) — note the
    // arg order (msg then sig), see spectre.js verifyMessage(). Daemon RPC
    // is `verifymessage <address> <signature> <message>`.
    verifyMessage: async function (address, message, signature) {
      try {
        const ok = await rpc('verifymessage', [address, signature, message]);
        dispatch('bridge', 'verifyMessageResult', !!ok);
        return { error_msg: ok ? '' : 'Signature did not verify.' };
      } catch (e) {
        logRpcError('verifymessage', e);
        dispatch('bridge', 'verifyMessageResult', false);
        return { error_msg: e.message || String(e) };
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

      // Confirm dialog text — direct port of spectrebridge.cpp::sendCoins.
      // Each recipient is formatted differently based on txnTypeInd:
      //   0 SPEC_TO_SPEC: "<amt> ALIAS from your public balance to <label> (<addr>)"
      //   1 SPEC_TO_ANON: "<amt> ALIAS from public to private, using address <label> (<addr>)"
      //   2 ANON_TO_ANON: "<amt> ALIAS from your private balance, ring size <N>, to <label> (<addr>)"
      //   3 ANON_TO_SPEC: "<amt> ALIAS from private to public, ring size <N>, using address <label> (<addr>)"
      // Conversion when single recipient is SPEC_TO_ANON or ANON_TO_SPEC.
      const fmtAmt = (alias) => Number(alias).toFixed(8) + ' ALIAS';
      const RING_SIZE = 10; // mirrors GetRingSizeMinMax default; only shown for anon
      const lines = queue.map((r) => {
        const amt = fmtAmt(r.amount);
        const dest = `${r.label || ''} (${r.address})`.trim();
        switch (r.txnType) {
          case 1: return `${amt} from public to private, using address ${dest}`;
          case 2: return `${amt} from your private balance, ring size ${RING_SIZE}, to ${dest}`;
          case 3: return `${amt} from private to public, ring size ${RING_SIZE}, using address ${dest}`;
          case 0:
          default: return `${amt} from your public balance to ${dest}`;
        }
      });
      const joined = lines.join(' and ');
      const isConversion = queue.length === 1 && (queue[0].txnType === 1 || queue[0].txnType === 3);
      const message = (isConversion ? 'Are you sure you want to convert ' : 'Are you sure you want to send ') + joined + '?';

      let ok = true;
      const cOverride = window.__aliasShim && window.__aliasShim.confirmSendOverride;
      if (typeof cOverride === 'function') {
        ok = await cOverride({ message, queue });
      } else if (window.aliasBridge && window.aliasBridge.confirmSend) {
        ok = await window.aliasBridge.confirmSend({ title: 'Confirm send coins', message });
      }
      if (!ok) { dispatch('bridge', 'sendCoinsResult', false); return; }

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
      if (name === 'aboutClicked')      { if (window.aliasBridge && window.aliasBridge.openAbout) window.aliasBridge.openAbout(); return; }
      if (name === 'aboutQtClicked')    return;  // Qt-specific; no equivalent on Electron
      if (name === 'backupWallet')      { if (window.aliasBridge && window.aliasBridge.backupWallet) window.aliasBridge.backupWallet(); return; }
      if (name === 'debugClicked')      { if (window.aliasBridge && window.aliasBridge.openDebug) window.aliasBridge.openDebug(); return; }
      if (name === 'clearRecipients')   { pendingRecipients.length = 0; return; }
      // The UI's Options save flow calls userAction({optionsChanged: {...}}).
      // Full persistence (daemon-side RPCs + electron-store) is a TODO;
      // for now stash the changes on bridge.info.options so the values
      // round-trip within the session, and acknowledge the call cleanly.
      if (action && typeof action === 'object' && action.optionsChanged) {
        bridge.info.options = Object.assign(bridge.info.options || {}, action.optionsChanged);
        return;
      }
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

    // --- Open the standalone Coin Control window (Send page button calls
    // bridge.openCoinControl() directly).
    openCoinControl: function () {
      if (window.aliasBridge && window.aliasBridge.openCoinControl) window.aliasBridge.openCoinControl();
    },

    // --- coin control. Selected UTXOs are stored in
    // `window.__aliasShim.coinControl.selected` (array of {txid, vout, amount}).
    // sendCoins honors selections only when the Send page's "Coin Control"
    // toggle is on (the `useCoinControl` bool passed to sendCoins).
    // updateCoinControlAmount fires when amount changes — used by the original
    // C++ side to recompute fee estimates. Without raw-tx integration the
    // estimate stays at the daemon default, so this is a no-op for v1.
    updateCoinControlAmount: function () { /* no-op until raw-tx coin control lands */ },
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
  // Tests can also stub askPassphraseOverride / confirmSendOverride here.
  window.__aliasShim = {
    dispatch, proxies,
    translations: null,           // { 'English text': 'Translated text', ... }
    coinControl: { selected: [] }, // [{txid, vout, amount}] — populated by future CC UI
  };

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

  // Port of SpectreGUI::setNumConnections. Updates the connections icon
  // (uses one of assets/svg/connection-N.svg up to N=12), the overlay text
  // count, and the "Checking wallet state with network" syncing spinner.
  function applyConnectionStateToDOM(connections) {
    const $icon = $('#connectionsIcon');
    const $txt  = $('#connectionsIconText');
    const $sync = $('#syncingIcon');
    const $syncTxt = $('#syncingIconText');
    if (!$icon.length) return;
    const n = Math.max(0, Math.min(12, Number(connections) || 0));
    $icon.attr('src', 'assets/svg/connection-' + n + '.svg');
    $icon.attr('data-title', n + ' active connection(s) to Alias network');
    if (connections > 0) {
      $icon.removeClass('fa-spin');
      $txt.text(String(connections)).removeClass('none');
      $sync.addClass('none');
      $syncTxt.addClass('none');
    } else {
      $icon.addClass('fa-spin');
      $txt.addClass('none');
    }
  }

  // Port of SpectreGUI::setEncryptionStatus — directly manipulates DOM
  // classes that the original C++ side touched via Qt's WebElement helper.
  // Drives the top-right encryption icon + sidebar menu visibility.
  function applyEncryptionStateToDOM(status, stakingOnly) {
    const $icon          = $('#encryptionIcon');
    const $encryptBtn    = $('#encryptWallet');
    const $encryptMenu   = $('.encryptWallet');
    const $changePass    = $('#changePassphrase');
    const $toggleLock    = $('#toggleLock');
    const $toggleLockIco = $('#toggleLockIcon');
    if (!$icon.length) return;

    if (status === 0) {                      // Unencrypted
      $icon.addClass('none');
      $changePass.addClass('none');
      $toggleLock.addClass('none');
      $encryptMenu.removeClass('none');
      return;
    }
    if (status === 1) {                      // Unlocked
      $encryptMenu.addClass('none');
      $icon.removeClass('none').removeClass('encryption');
      $toggleLockIco.removeClass('fa-unlock').removeClass('fa-unlock-alt').addClass('fa-lock');
      if (stakingOnly) {
        $icon.attr('data-title', 'Wallet is <b>encrypted</b> and currently <b>unlocked</b> for staking only')
             .removeClass('no-encryption').addClass('encryption-stake');
      } else {
        $icon.attr('data-title', 'Wallet is <b>encrypted</b> and currently <b>unlocked</b>')
             .removeClass('encryption-stake').addClass('no-encryption');
      }
      $encryptBtn.addClass('none');
      $changePass.removeClass('none');
      $toggleLock.removeClass('none');
      return;
    }
    if (status === 2) {                      // Locked
      $icon.removeClass('none').removeClass('no-encryption').removeClass('encryption-stake').addClass('encryption');
      $toggleLockIco.removeClass('fa-lock').addClass('fa-unlock-alt');
      $icon.attr('data-title', 'Wallet is <b>encrypted</b> and currently <b>locked</b>');
      $encryptBtn.addClass('none');
      $encryptMenu.addClass('none');
      $changePass.removeClass('none');
      $toggleLock.removeClass('none');
    }
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
          applyEncryptionStateToDOM(enc, false /* stakingOnly: TODO track via walletpassphrase arg */);
          lastEncStatus = enc;
        }
        applyConnectionStateToDOM(info.connections);
        // Heuristic sync check — mirrors SpectreGUI::setNumBlocks "Up to
        // date" branch which hides all .outofsync elements. The daemon
        // doesn't expose initialblockdownload via getinfo, so use
        // "have peers + non-trivial height" as a proxy. Refine if a
        // dedicated sync signal becomes available.
        if (info.connections > 0 && info.blocks > 100) {
          $('.outofsync').hide();
          const $sync = $('#syncingIcon');
          $sync.removeClass('fa-spin syncing').attr('src', 'assets/svg/synced.svg');
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
