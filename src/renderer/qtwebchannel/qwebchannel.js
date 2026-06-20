// Global renderer error guards — keep an unexpected RPC failure (often
// "wallet is locked") from crashing the page. Logged so we can still trace
// them in DevTools.
window.addEventListener('error', (e) => {
  console.error('[renderer] error', e && (e.error && e.error.stack || e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer] unhandledrejection', e && (e.reason && e.reason.stack || e.reason));
  e.preventDefault();
});

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
    // with the same warning text the C++ dialog showed. Use the native
    // alert IPC so the titlebar shows "ALIAS" rather than the package name.
    const showAlert = window.aliasBridge && window.aliasBridge.showAlert;
    const showFn = showAlert ? showAlert : (t, m) => { window.alert(t + '\n\n' + m); };
    await showFn(
      'Wallet encrypted',
      'ALIAS will close now to finish the encryption process. ' +
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
    // Original C++: returns clipboard text AND emits emitPaste(text). UI's
    // paste(targetSelector) sets pasteTo then calls bridge.paste(), then the
    // emitPaste handler writes the clipboard text into pasteTo. Mirror by
    // reading async and dispatching the signal — UI doesn't use the return.
    paste: function () {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((text) => {
            dispatch('bridge', 'emitPaste', String(text || ''));
          }).catch(() => {});
        }
      } catch (_) {}
      return '';
    },

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
      // Stealth addresses fail validateaddress server-side (CBitcoinAddress
      // can't parse them) — skip silently rather than logging a 500 warning
      // for every poll.
      if (typeof address === 'string' && address.length > 60) return '';
      try { return await rpc('getaccount', [address]) || ''; }
      catch (_) { return ''; }
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
        // Original ALIAS Qt's WalletModel auto-refreshed the address tables
        // via a Qt model signal. Mirror that by pushing the new entry into
        // the Receive + Address Book tables right away — the 8s poll loop
        // would otherwise leave the new row invisible for several seconds.
        if (!send) {
          const isStealth = (addressType === 1);
          dispatch('bridge', 'emitAddresses', [{
            address:     addr,
            label:       label || 'Unlabeled',
            label_value: label || '',
            pubkey:      isStealth ? 'Stealth Address' : 'n/a',
            type:        'R',
            at:          isStealth ? 2 : 0,
          }]);
        }
        return addr;
      } catch (e) {
        logRpcError(cmd, e);
        const msg = e.message || String(e);
        dispatch('bridge', 'newAddressResult', false, msg, '', !!send);
        dispatch('bridge', 'lastAddressErrorResult', msg);
        return '';
      }
    },
    deleteAddress: async function (address) {
      // Original ALIAS's WalletModel called DelAddressBookName directly on
      // the wallet. The daemon doesn't expose that as RPC, so we mirror the
      // user-visible outcome by clearing the label via setaccount('') —
      // which is the closest equivalent for own addresses (Bitcoin's RPC
      // rejects setaccount on foreign addresses, which the original C++
      // would have refused to remove anyway since removeRows() refuses
      // Receiving-type rows).
      if (!address) return;
      try { await rpc('setaccount', [address, '']); }
      catch (e) { logRpcError('setaccount(clear)', e); }
    },

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

    // --- Options. Load persisted settings from main + dispatch getOptionResult,
    // then fan out OptionsModel signals so handlers wired in UI (unit_setType,
    // updateReserved, updateRowsPerPage, visibleTransactions) reflect the
    // persisted values immediately. Mirrors original OptionsModel::Init() emits.
    getOptions: async function () {
      try {
        const opts = await window.aliasBridge.getOptions();
        // The Options page populates each <select> from result["opt<Name>"]
        // — see spectre.js optionsPage.getOptionResult. Without these lists
        // the Language / Notifications / VisibleTransactions selects would
        // render empty. Mirrors what original OptionsModel sent back as the
        // "opt<Name>" companion arrays.
        const enriched = Object.assign({}, opts, {
          optLanguage: {
            en:      'English',
            de:      'Deutsch',
            es:      'Español',
            fr:      'Français',
            it:      'Italiano',
            ja:      '日本語',
            ko:      '한국어',
            nl:      'Nederlands',
            pl:      'Polski',
            pt:      'Português',
            pt_BR:   'Português (Brasil)',
            ru:      'Русский',
            tr:      'Türkçe',
            zh_CN:   '中文 (简体)',
            zh_TW:   '中文 (繁體)',
          },
          // Verbatim from TransactionRecord::getTypeLabel() in
          // transactionrecord.cpp:23-63, deduped per spectrebridge.cpp:333.
          // The "transactions" key becomes an <optgroup label="Transactions">
          // wrapping all the type labels (see spectre.js:1271).
          optNotifications: { transactions: [
            'Other',
            'Public staked',
            'Private staked',
            'Public donated',
            'Private donated',
            'Public contributed',
            'Private contributed',
            'Public sent to',
            'Public received with',
            'Public received from',
            'Public sent to self',
            'Private sent to self',
            'Private received with',
            'Private sent to',
            'Public to Private',
            'Private to Public',
          ]},
          optVisibleTransactions: { transactions: [
            'Other',
            'Public staked',
            'Private staked',
            'Public donated',
            'Private donated',
            'Public contributed',
            'Private contributed',
            'Public sent to',
            'Public received with',
            'Public received from',
            'Public sent to self',
            'Private sent to self',
            'Private received with',
            'Private sent to',
            'Public to Private',
            'Private to Public',
          ]},
        });
        bridge.info.options = opts;
        dispatch('bridge', 'getOptionResult', enriched);
        if (opts.DisplayUnit !== undefined)
          dispatch('optionsModel', 'displayUnitChanged', Number(opts.DisplayUnit) || 0);
        if (opts.ReserveBalance !== undefined)
          dispatch('optionsModel', 'reserveBalanceChanged', Math.round(Number(opts.ReserveBalance) * 1e8));
        if (opts.RowsPerPage !== undefined)
          dispatch('optionsModel', 'rowsPerPageChanged', Number(opts.RowsPerPage) || 25);
        if (Array.isArray(opts.VisibleTransactions))
          dispatch('optionsModel', 'visibleTransactionsChanged', opts.VisibleTransactions);
      } catch (_) {}
    },

    // --- block explorer (UI calls these; need RPC mapping to be useful) ---
    findBlock: async function (hashOrHeight) {
      try {
        const r = await rpc('getblock', [String(hashOrHeight)]);
        dispatch('bridge', 'findBlockResult', r);
      } catch (e) { logRpcError('getblock', e); }
    },
    listAnonOutputs: async function () {
      // listanonoutputs is the Qt-bridge in-process implementation; no daemon
      // RPC equivalent. Dispatch an empty result so the ChainData page shows
      // its empty-state instead of waiting forever.
      try {
        const r = await rpc('listanonoutputs', []);
        dispatch('bridge', 'listAnonOutputsResult', r);
      } catch (_) {
        dispatch('bridge', 'listAnonOutputsResult', {});
      }
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
        const b = await rpc('getblock', [String(blockHash)]);
        // Remap daemon's getblock shape to the UI's expected block_* keys.
        const out = {
          block_hash:        b.hash || blockHash,
          block_transactions: Array.isArray(b.tx) ? b.tx.length : 0,
          block_height:      b.height,
          block_type:        b.flags || (b.proofhash ? 'PoS' : 'PoW'),
          block_reward:      b.reward != null ? b.reward : '',
          block_timestamp:   b.time ? new Date(b.time * 1000).toISOString() : '',
          block_merkle_root: b.merkleroot || '',
          block_prev_block:  b.previousblockhash || '',
          block_next_block:  b.nextblockhash || '',
          block_difficulty:  b.difficulty != null ? b.difficulty : '',
          block_bits:        b.bits || '',
          block_size:        b.size != null ? b.size : '',
          block_version:     b.version != null ? b.version : '',
          block_nonce:       b.nonce != null ? b.nonce : '',
        };
        dispatch('bridge', 'blockDetailsResult', out);
      } catch (e) { logRpcError('getblock', e); }
    },
    // Original signature: bridge.txnDetails(blockHash, txid) — second arg
    // when invoked from the per-block tx list. We accept either form.
    txnDetails: async function (blockHashOrTxid, maybeTxid) {
      const txid = maybeTxid || blockHashOrTxid;
      try {
        const rawHex = await rpc('getrawtransaction', [String(txid), 0]);
        const r = await rpc('decoderawtransaction', [rawHex]);
        // gettransaction gives confirmations/blockhash/time (wallet-aware).
        // For non-wallet txs this returns 500; tolerate and continue.
        let wallet = {};
        try { wallet = await rpc('gettransaction', [String(txid)]); } catch (_) {}
        // Resolve input source addresses via decoderawtransaction on each
        // prev-tx. Skip on error — UI shows the field empty.
        const inputs = [];
        for (const vin of (r.vin || [])) {
          if (!vin.txid) continue;
          try {
            const prevHex = await rpc('getrawtransaction', [String(vin.txid), 0]);
            const prev = await rpc('decoderawtransaction', [prevHex]);
            const prevOut = (prev.vout || [])[vin.vout || 0];
            inputs.push({
              input_source_address: ((prevOut && prevOut.scriptPubKey && prevOut.scriptPubKey.addresses) || [''])[0],
              input_value:          prevOut ? prevOut.value : '',
            });
          } catch (_) {
            inputs.push({ input_source_address: vin.txid + ':' + (vin.vout || 0), input_value: '' });
          }
        }
        const outputs = (r.vout || []).map((o) => ({
          output_source_address: ((o.scriptPubKey && o.scriptPubKey.addresses) || [''])[0],
          output_value:          o.value,
        }));
        const out = {
          transaction_hash:          r.txid || txid,
          transaction_size:          r.size || '',
          transaction_rcv_time:      wallet.timereceived ? new Date(wallet.timereceived * 1000).toISOString() : '',
          transaction_mined_time:    wallet.blocktime ? new Date(wallet.blocktime * 1000).toISOString() : '',
          transaction_block_hash:    wallet.blockhash || '',
          transaction_reward:        wallet.amount != null ? wallet.amount : 0,
          transaction_confirmations: wallet.confirmations != null ? wallet.confirmations : '',
          transaction_value:         outputs.reduce((s, o) => s + Number(o.output_value || 0), 0).toFixed(8),
          transaction_inputs:        inputs,
          transaction_outputs:       outputs,
          error_msg: '',
        };
        dispatch('bridge', 'txnDetailsResult', out);
      } catch (e) {
        logRpcError('getrawtransaction', e);
        dispatch('bridge', 'txnDetailsResult', { error_msg: (e && e.message) || String(e) });
      }
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
      // Mirror TransactionDesc::toHTML — emits an HTML block with
      // Transaction ID / Block Hash / Status / Date / Source / Net amount /
      // per-destination credit/debit lines + chainz.cryptoid explorer
      // links. The UI handler appends this to #transaction-info via
      // .html().
      try {
        const tx = await rpc('gettransaction', [txid]);
        if (!tx) {
          dispatch('bridge', 'transactionDetailsResult', '');
          return;
        }
        const explorer = 'https://chainz.cryptoid.info/alias/';
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
        const dateStr = tx.time ? new Date(tx.time * 1000).toLocaleString() : '';
        const fmt = (n) => (n == null ? '' : Number(n).toFixed(8) + ' ALIAS');
        const explorerLink = (path, label) => `<a href="javascript:void(0)" onclick='bridge.urlClicked(${JSON.stringify(explorer + path)})'>${esc(label)}</a>`;

        let h = '<div class="tx-desc" style="font-family:Montserrat,sans-serif">';
        h += `<b>Transaction ID:</b> ${explorerLink('tx.dws?' + tx.txid, tx.txid)}<br>`;
        if (tx.blockhash) {
          h += `<b>Block Hash:</b> ${explorerLink('block.dws?' + tx.blockhash, tx.blockhash)}<br>`;
        }
        const confs = tx.confirmations || 0;
        let status;
        if (confs < 0)       status = 'conflicted';
        else if (confs === 0) status = '0/unconfirmed';
        else if (confs < 10)  status = `${confs}/unconfirmed`;
        else                  status = `${confs} confirmations`;
        h += `<b>Status:</b> ${esc(status)}<br>`;
        if (dateStr) h += `<b>Date:</b> ${esc(dateStr)}<br>`;
        if (tx.generated) h += `<b>Source:</b> Generated<br>`;
        if (tx.fee !== undefined && tx.fee !== 0) {
          h += `<b>Transaction fee:</b> ${esc(fmt(tx.fee))}<br>`;
        }
        if (tx.amount !== undefined) {
          h += `<b>Net amount:</b> ${esc(fmt(tx.amount))}<br>`;
        }
        // Per-destination details
        if (Array.isArray(tx.details)) {
          for (const d of tx.details) {
            const dir = d.category === 'send' ? 'Debit' : 'Credit';
            const addr = d.address || '';
            h += `<br><b>${esc(dir)}:</b> ${esc(fmt(d.amount))}`;
            if (addr) h += `<br><b>To/From:</b> ${esc(addr)}`;
            if (d.account) h += `<br><b>Label:</b> ${esc(d.account)}`;
            if (d.narration) h += `<br><b>Narration:</b> ${esc(d.narration)}`;
            h += '<br>';
          }
        }
        // Optional comment/message stored in the wallet entry
        if (tx.comment)   h += `<br><b>Comment:</b><br>${esc(tx.comment)}<br>`;
        if (tx.to)        h += `<br><b>Comment-To:</b><br>${esc(tx.to)}<br>`;
        h += '</div>';

        dispatch('bridge', 'transactionDetailsResult', h);
      } catch (e) {
        logRpcError('gettransaction', e);
        dispatch('bridge', 'transactionDetailsResult', `<div class="tx-desc-error">Error loading transaction: ${(e && e.message) || e}</div>`);
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
    sendCoins: async function (useCoinControl, changeAddress) {
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

      // Selected UTXOs from the Coin Control dialog (window.__aliasShim.coinControl.selected).
      const selectedUtxos = (useCoinControl && window.__aliasShim && window.__aliasShim.coinControl
        && Array.isArray(window.__aliasShim.coinControl.selected))
          ? window.__aliasShim.coinControl.selected
          : [];

      // Only public→public sends support raw-tx coin control; anon RPCs build
      // their own input selection internally.
      const isPublicOnly = queue.every((r) => r.txnType === 0);
      const useRawTx = useCoinControl && selectedUtxos.length > 0 && isPublicOnly;

      try {
        if (useRawTx) {
          await withUnlock(async () => {
            const inputs = selectedUtxos.map((u) => ({ txid: u.txid, vout: u.vout }));
            const totalIn = selectedUtxos.reduce((s, u) => s + Number(u.amount || 0), 0);
            const outputs = {};
            let totalOut = 0;
            for (const r of queue) {
              outputs[r.address] = Number(r.amount) || 0;
              totalOut += outputs[r.address];
            }
            const FEE_PER_TX = 0.0001; // simplistic flat fee
            const change = totalIn - totalOut - FEE_PER_TX;
            if (change < 0) throw new Error('Selected inputs are smaller than recipients + fee.');
            if (change > 0.00000001) {
              const cAddr = changeAddress || await rpc('getnewaddress', []);
              outputs[cAddr] = Math.round(change * 1e8) / 1e8;
            }
            const raw    = await rpc('createrawtransaction', [inputs, outputs]);
            const signed = await rpc('signrawtransaction', [raw]);
            if (!signed || !signed.hex || signed.complete === false)
              throw new Error('signrawtransaction returned incomplete result');
            await rpc('sendrawtransaction', [signed.hex]);
          });
          // Selection consumed; clear for next send.
          if (window.__aliasShim && window.__aliasShim.coinControl)
            window.__aliasShim.coinControl.selected = [];
        } else {
          await withUnlock(async () => {
            for (const r of queue) {
              const params = [r.address, r.amount];
              if (r.narration) params.push(r.label, r.narration);
              else if (r.label) params.push(r.label);
              await rpc(rpcFor(r.txnType), params);
            }
          });
        }
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
        const langChanged = Object.prototype.hasOwnProperty.call(action.optionsChanged, 'Language');
        bridge.info.options = Object.assign(bridge.info.options || {}, action.optionsChanged);
        try {
          if (window.aliasBridge && window.aliasBridge.setOptions) {
            await window.aliasBridge.setOptions(action.optionsChanged);
          }
        } catch (_) {}
        if (typeof bridge.getOptions === 'function') bridge.getOptions();
        if (langChanged) {
          // Matches the original Qt's QMessageBox::warning when the locale
          // changes — strings are baked in at startup.
          if (window.aliasBridge && window.aliasBridge.showAlert) {
            window.aliasBridge.showAlert('Please restart wallet', 'The used language has changed.\nPlease restart the wallet!');
          } else {
            window.alert('Please restart wallet\n\nThe used language has changed.\nPlease restart the wallet!');
          }
        }
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
    // UI signature (spectre.js): (mnemonic, passphrase, label, bip44, scanFromTime).
    // Daemon RPC: `mnemonic import <words> [passphrase] [bip44] [scanchain] [label]`.
    importFromMnemonic: async function (mnemonic, passphrase, label, bip44, scanFromTime) {
      try {
        const params = ['import', mnemonic || '', passphrase || ''];
        // bip44 + scanchain are positional booleans; emit them only if either
        // is requested so older daemons that ignore them still work.
        if (bip44 || scanFromTime) {
          params.push(bip44 ? true : false);
          params.push(scanFromTime ? true : false);
        }
        if (label) params.push(label);
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

  // Port of SpectreGUI::updateStakingIcon (spectregui.cpp:1090-1140).
  //
  // ACTIVE state (fIsStaking && nWeight): rich tooltip with weight, network
  // weight, and the estimated time to the next reward.
  //
  // INACTIVE state: 7-level priority chain (we skip thin-mode since we run
  // full-node only):
  //   1. !enabled            -> "Not staking, staking is disabled"
  //   2. wallet locked       -> "Not staking because wallet is locked"
  //   3. no peers            -> "Not staking because wallet is offline"
  //   4. initial block dl    -> "Not staking because wallet is syncing"
  //   5. !fIsStaking         -> "Initializing staking..."
  //   6. !nWeight            -> "Not staking because you don't have mature coins"
  //   7. otherwise           -> "Not staking"
  //
  // stakingInfo: result of `getstakinginfo` (may be null on early/transient).
  // syncedToTip: true when the chain is at the peer tip (proxy for !IBD).
  function formatEta(secs) {
    if (secs < 60)            return secs + ' second(s)';
    if (secs < 60 * 60)       return Math.floor(secs / 60) + ' minute(s), ' + (secs % 60) + ' second(s)';
    if (secs < 24 * 60 * 60)  return Math.floor(secs / 3600) + ' hour(s), ' + Math.floor((secs % 3600) / 60) + ' minute(s)';
    return Math.floor(secs / 86400) + ' day(s), ' + Math.floor((secs % 86400) / 3600) + ' hour(s)';
  }
  function applyStakingStateToDOM(info, encStatus, stakingInfo, syncedToTip) {
    const $icon = $('#stakingIcon');
    if (!$icon.length || !info) return;

    const enabled    = stakingInfo ? !!stakingInfo.enabled : true;
    const staking    = stakingInfo ? !!stakingInfo.staking : false;
    const weight     = stakingInfo ? (Number(stakingInfo.weight) || 0)
                                   : (Number(info.stakeweight) || 0);
    const netWeight  = stakingInfo ? (Number(stakingInfo.netstakeweight) || 0) : 0;
    const expEtaRaw  = stakingInfo ? (Number(stakingInfo.expectedtime) || 0) : 0;

    if (staking && weight > 0) {
      $icon.removeClass('not-staking').addClass('staking');
      // Original divides weight & netWeight by COIN before display.
      const w  = Math.floor(weight     / 1e8);
      const nw = Math.floor(netWeight  / 1e8);
      // Original formula: nEstimateTime = GetTargetSpacing * netWeight / weight.
      // Daemon already returns `expectedtime` in seconds, so use that directly.
      const eta = expEtaRaw > 0 ? formatEta(expEtaRaw) : 'unknown';
      $icon.attr('data-title',
        'Staking.<br/>' +
        'Your weight is ' + w + '<br/>' +
        'Network weight is ' + nw + '<br/>' +
        'Average time between rewards is ' + eta);
      return;
    }

    $icon.addClass('not-staking').removeClass('staking');
    let why;
    if      (!enabled)                                 why = 'Not staking, staking is disabled';
    else if (encStatus === 2)                          why = 'Not staking because wallet is locked';
    else if ((Number(info.connections) || 0) === 0)    why = 'Not staking because wallet is offline';
    else if (!syncedToTip)                             why = 'Not staking because wallet is syncing';
    else if (!staking)                                 why = 'Initializing staking...';
    else if (weight === 0)                             why = 'Not staking because you don\'t have mature coins';
    else                                               why = 'Not staking';
    $icon.attr('data-title', why);
  }

  // Port of SpectreGUI::setNumConnections. Updates the connections icon
  // (uses one of assets/svg/connection-N.svg up to N=12), the overlay text
  // count, and the "Checking wallet state with network" syncing spinner.
  function applyConnectionStateToDOM(connections) {
    const $icon = $('#connectionsIcon');
    const $txt  = $('#connectionsIconText');
    if (!$icon.length) return;
    const actual = Number(connections) || 0;
    const svgIdx = Math.max(0, Math.min(12, actual));
    $icon.attr('src', 'assets/svg/connection-' + svgIdx + '.svg');
    $icon.attr('data-title', actual + ' active connection(s) to ALIAS network');
    if (connections > 0) {
      $icon.removeClass('fa-spin');
      $txt.text(String(connections)).removeClass('none');
    } else {
      $icon.addClass('fa-spin');
      $txt.addClass('none');
    }
  }
  // Port of SpectreGUI::setNumBlocks (spectregui.cpp:565-679):
  //   "Up to date" / synced.svg ONLY when ALL three hold:
  //     1. count >= nTotalBlocks         (our blocks >= peer-reported tip)
  //     2. secs < 30*60                  (last block age < 30 minutes)
  //     3. nNodeState != NS_GET_FILTERED_BLOCKS  (we ignore — full node)
  //   Otherwise: spinner + percentage label.
  // GetNumBlocksOfPeers() in original (main.cpp:2031-2034):
  //   return max(cPeerBlockCounts.median(), Checkpoints::GetTotalBlocksEstimate())
  // where cPeerBlockCounts is a rolling median (size 5) of peers' nChainHeight
  // (exposed via getpeerinfo as "chainheight"), and the checkpoint estimate is
  // the highest hardcoded checkpoint height from checkpoints.cpp.
  const CHECKPOINT_ESTIMATE = 1245000; // checkpoints.cpp mainnet last entry
  let lastPeerHeight = 0;
  let lastTipBlockTime = 0;  // unix seconds of our current chain tip
  let lastTipKnownHash = '';

  function medianOf(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2);
  }

  async function refreshTipBlockTime(blocks) {
    // Avoid extra RPCs if height hasn't moved.
    try {
      const tipHash = await rpc('getbestblockhash', []);
      if (tipHash && tipHash !== lastTipKnownHash) {
        lastTipKnownHash = tipHash;
        const blk = await rpc('getblock', [String(tipHash)]);
        if (blk && Number(blk.time)) lastTipBlockTime = Number(blk.time);
      }
    } catch (_) { /* tolerate */ }
  }

  // Returns the syncedToTip flag so callers (staking icon) can use the same
  // judgement without re-deriving it.
  function ageText(secs) {
    if (secs <= 0)            return '';
    if (secs < 60)            return secs + ' second(s) ago';
    if (secs < 60 * 60)       return Math.floor(secs / 60) + ' minute(s) ago';
    if (secs < 24 * 60 * 60)  return Math.floor(secs / 3600) + ' hour(s) ago';
    return Math.floor(secs / 86400) + ' day(s) ago';
  }
  async function applySyncStateToDOM(info) {
    const $sync = $('#syncingIcon');
    const $syncTxt = $('#syncingIconText');
    if (!$sync.length) return false;
    const blocks = Number(info && info.blocks) || 0;
    const peers  = Number(info && info.connections) || 0;

    // Discover peer tip (= nTotalBlocks in original). Match
    // main.cpp:2031-2034: median of peer chain heights, floored at the
    // hardcoded checkpoint estimate. peerMedian recomputes each tick so
    // the % falls if peers really do report a lower tip.
    let peerMedian = 0;
    if (peers > 0) {
      try {
        const peerList = await rpc('getpeerinfo', []);
        if (Array.isArray(peerList) && peerList.length > 0) {
          // rpcnet.cpp:93 emits "chainheight" — fall back to legacy field
          // names for forks that renamed it.
          const heights = peerList
            .map(p => Number(p.chainheight) || Number(p.startingheight) || Number(p.synced_headers) || 0)
            .filter(h => h > 0);
          peerMedian = medianOf(heights);
        }
      } catch (_) {}
    }
    const nTotalBlocks = Math.max(peerMedian, CHECKPOINT_ESTIMATE);
    // lastPeerHeight is a high-water mark used only as a fallback when
    // peers temporarily drop to 0; the live nTotalBlocks drives the %.
    if (nTotalBlocks > lastPeerHeight) lastPeerHeight = nTotalBlocks;
    // Refresh our tip block time (= clientModel->getLastBlockDate()).
    await refreshTipBlockTime(blocks);

    const denom    = nTotalBlocks > 0 ? nTotalBlocks : lastPeerHeight;
    const haveTip  = denom > 0;
    // "Up to date" predicate (spectregui.cpp:667-668): caught up AND last
    // block age < 30 min. The original does NOT require peers > 0 here —
    // an offline wallet with a recent tip still shows "Up to date".
    const caughtUp = haveTip && blocks >= denom;
    const nowSecs  = Math.floor(Date.now() / 1000);
    const secsSinceTip = lastTipBlockTime > 0 ? Math.max(0, nowSecs - lastTipBlockTime) : Infinity;
    const recent   = secsSinceTip < 30 * 60;

    const synced = caughtUp && recent;

    // Build the rich multi-line tooltip exactly as the original does
    // (spectregui.cpp:603-733). Header is "Up to date" or "Catching up..."
    // followed by the descriptive body.
    let tooltip;
    if (synced) {
      tooltip = 'Up to date<br>Downloaded ' + blocks + ' block(s) of transaction history.';
    } else {
      const remaining   = Math.max(0, denom - blocks);
      const pctForLabel = denom > 0 ? (blocks / (denom * 0.01)) : 0;
      tooltip = 'Catching up...<br>'
              + 'Synchronizing with network...<br>'
              + '~' + remaining + ' block(s) remaining<br>'
              + 'Downloaded ' + blocks + ' of ' + denom
              + ' blocks of transaction history (' + pctForLabel.toFixed(3) + '% done).';
    }
    if (secsSinceTip > 0 && Number.isFinite(secsSinceTip)) {
      tooltip += '<br>Last received block was generated ' + ageText(secsSinceTip) + '.';
    }

    if (synced) {
      $sync.attr('src', 'assets/svg/synced.svg').removeClass('fa-spin syncing');
      $syncTxt.removeClass('syncing').addClass('none').text('');
      $sync.attr('data-title', tooltip);
    } else if (haveTip) {
      // Verbatim from SpectreGUI::setNumBlocks (spectregui.cpp:691-710):
      //   build a data-URI SVG with a 30%-opacity background ring + an
      //   orange progress arc. stroke-dasharray length = pct * 2πr / 100
      //   with r=29 (=> 182.2124). Clamp pct to [2.5, 95] so the arc is
      //   visible at extremes.
      // Verbatim from spectregui.cpp:606 — nPercentageDone = count / (nTotalBlocks * 0.01f)
      const pctRaw  = Math.max(0, Math.min(100, blocks / (denom * 0.01)));
      const svgPct  = pctRaw < 2.5 ? 2.5 : pctRaw > 95 ? 95 : pctRaw;
      const dashLen = (svgPct * 182.2124 / 100).toFixed(4);
      const svgRaw =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        +   '<circle cx="32" cy="32" r="29" fill="none" stroke="#F38220" stroke-opacity="0.3" stroke-width="5"/>'
        +   '<circle cx="32" cy="32" r="29" fill="none" stroke="#F38220" stroke-width="5" '
        +     'stroke-dasharray="' + dashLen + ' 182.2124" transform="rotate(-90 32 32)" />'
        + '</svg>';
      const svg = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgRaw);
      $sync.attr('src', svg).removeClass('fa-spin').addClass('syncing');
      // Label: <10 → one decimal place ("0.5%"), else floor integer.
      const pctText = (pctRaw < 10 ? (Math.floor(pctRaw * 10) / 10).toFixed(1)
                                   : String(Math.min(99, Math.floor(pctRaw)))) + '%';
      $syncTxt.text(pctText).removeClass('none').addClass('syncing');
      $sync.attr('data-title', tooltip);
    } else {
      // Bootstrap state — we haven't yet learned ANY tip estimate.
      $sync.attr('src', 'assets/svg/spinner.svg').addClass('fa-spin').removeClass('syncing');
      $syncTxt.removeClass('syncing').addClass('none').text('');
      $sync.attr('data-title', 'Synchronizing with network...');
    }
    return synced;
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

  // Load a translation map if a non-English locale is selected. Looks at
  // bridge.info.options.Language (set by Options page) or navigator.language.
  async function maybeLoadTranslations() {
    if (!window.aliasBridge || !window.aliasBridge.loadTranslation) return;
    const fromOpts = (bridge.info.options && bridge.info.options.Language) || '';
    const fromNav  = (navigator.language || '').replace('-', '_');
    const locale = fromOpts || fromNav;
    if (!locale || locale === 'en' || locale.startsWith('en_')) return;
    try {
      const map = await window.aliasBridge.loadTranslation(locale);
      if (map) {
        window.__aliasShim.translations = map;
        // Re-run translateStrings if the UI defined it (will dispatch updateElement
        // for each .translate element it iterates).
        if (typeof translateStrings === 'function') translateStrings();
      }
    } catch (_) {}
  }
  setTimeout(maybeLoadTranslations, 500);

  // alias: URI handling — mirrors SpectreGUI::handleURI. Parses
  // alias:<address>?amount=X&label=Y&narration=Z and dispatches
  // emitReceipient so the UI navigates to Send and pre-fills the first
  // recipient row.
  function parseAliasUri(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('alias:')) return null;
    const rest = uri.slice(6).replace(/^\/\//, '');
    const qIdx = rest.indexOf('?');
    const address = qIdx === -1 ? rest : rest.slice(0, qIdx);
    const query   = qIdx === -1 ? '' : rest.slice(qIdx + 1);
    const params = {};
    for (const pair of query.split('&')) {
      if (!pair) continue;
      const [k, v] = pair.split('=');
      params[decodeURIComponent(k)] = v == null ? '' : decodeURIComponent(v.replace(/\+/g, ' '));
    }
    if (!address) return null;
    return {
      address,
      label:     params.label     || '',
      narration: params.narration || params.message || '',
      amount:    parseFloat(params.amount || '0') || 0,
    };
  }
  function handleAliasUri(uri) {
    const r = parseAliasUri(uri);
    if (!r) return;
    // Original ALIAS passed amount as int64 satoshis (CAmount). The UI's
    // send.js divides by 1E8 to display. Convert from ALIAS units in the
    // URI accordingly.
    const amountSats = Math.round(r.amount * 1e8);
    dispatch('bridge', 'emitReceipient', r.address, r.label, r.narration, amountSats);
    dispatch('bridge', 'triggerElement', '#navitems a[href=#send]', 'click');
  }
  if (window.aliasBridge && window.aliasBridge.onUriOpen) {
    window.aliasBridge.onUriOpen(handleAliasUri);
  }
  // Drag-drop onto the renderer DOM — accept text/uri-list of alias: URIs.
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    const text = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('alias:')) handleAliasUri(line.trim());
    }
  });
  // Expose for tests.
  window.__aliasShim = window.__aliasShim || {};
  window.__aliasShim.handleAliasUri = handleAliasUri;
  window.__aliasShim.parseAliasUri  = parseAliasUri;

  // Start polling on bridge-ready (proper path) OR a 1.5 s fallback —
  // whichever fires first. The UI's connectSignals() calls many .connect()
  // methods on page objects; if any one throws, jsReady() never runs and
  // bridge-ready never fires. The fallback ensures the status icons,
  // balance, address book, and tx list still update even when the
  // upstream UI's init chain is broken.
  let pollStarted = false;
  function ensurePollStarted(reason) {
    if (pollStarted) return;
    pollStarted = true;
    console.log('[shim] starting poll loop (' + reason + ')');
    onBridgeReady();
  }
  window.addEventListener('alias:bridge-ready', function () { ensurePollStarted('bridge-ready'); });
  setTimeout(function () { ensurePollStarted('fallback-timeout'); }, 1500);

  function onBridgeReady() {
    const seenTxids = new Set();
    let lastEncStatus = -1;

    // Blank the RESERVED balance row at startup. The UI's formatValue clears
    // a cell when value === 0 and showZero is false, so dispatching
    // reserveBalanceChanged(0) once removes the static "0.00" placeholder
    // text from the HTML. The original v4.4.0 wallet did this implicitly via
    // optionsModel init.
    dispatch('optionsModel', 'reserveBalanceChanged', 0);

    async function poll() {
      // getinfo MUST be done independently of the heavier calls below.
      // Earlier this was a Promise.all([getinfo, listtransactions]) — if
      // listtransactions threw (e.g. during a daemon rescan, or while the
      // wallet is loading), Promise.all rejected and we returned without
      // updating any of the status icons. The top-right then froze with the
      // initial HTML state: encryption icon hidden (class "none"), sync icon
      // text "0%", tooltip "Checking wallet state with network".
      let info = null;
      try { info = await rpc('getinfo', []); }
      catch (_) {
        // Daemon RPC is down (e.g. mid-restart right after encryptwallet
        // returns to the wizard). Don't wait the full 8 s for the next
        // setInterval tick — schedule a fast retry so the status icons
        // pick up the current state as soon as the daemon comes back up.
        setTimeout(poll, 1500);
        return;
      }
      let txs = null;
      try { txs = await rpc('listtransactions', ['*', 50, 0]); } catch (_) {}

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
        const syncedToTip = await applySyncStateToDOM(info);
        // getstakinginfo gives us the full priority chain + rich "Staking"
        // tooltip data. Tolerate failure — staking icon falls back to the
        // getinfo.stakeweight proxy if stakingInfo is null.
        let stakingInfo = null;
        try { stakingInfo = await rpc('getstakinginfo', []); } catch (_) {}
        applyStakingStateToDOM(info, enc, stakingInfo, syncedToTip);
        // Daemon's status-bar warning (chain warnings, version warnings, etc.)
        // is surfaced in #network-alert via networkAlert(text).
        dispatch('bridge', 'networkAlert', info.errors || '');
        // SpectreGUI::setNumBlocks (spectregui.cpp:678-684) hides the
        // .outofsync ribbons inside the "Up to date" branch. We share that
        // judgement via the syncedToTip flag the sync function returned.
        if (syncedToTip) $('.outofsync').hide(); else $('.outofsync').show();
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
      //
      // If listreceivedbyaddress returns empty (fresh wallet — wizard set up
      // master+account but didn't generate default addresses) seed the two
      // defaults so the Receive tab matches the original.
      try {
        let byAddr = await rpc('listreceivedbyaddress', [0, true]).catch(() => []);
        if (Array.isArray(byAddr) && byAddr.length === 0) {
          try { await rpc('getnewaddress',        ['Default Public Address']);  } catch (_) {}
          byAddr = await rpc('listreceivedbyaddress', [0, true]).catch(() => []);
        }
        let privAddrs = await rpc('listprivateaddresses', []).catch(() => null);
        if (!privAddrs || !privAddrs['Stealth Address']) {
          try { await rpc('getnewstealthaddress', ['Default Private Address']); } catch (_) {}
          privAddrs = await rpc('listprivateaddresses', []).catch(() => null);
        }
        const items = [];

        // Public side. The daemon hardcodes "Alias Foundation" in
        // walletdb.cpp for the dev contribution address — rebrand it to
        // "ALIAS Foundation" at display time.
        const OWN_HINT = /^(Default|Initial) /;
        const LABEL_REWRITES = { 'Alias Foundation': 'ALIAS Foundation' };
        for (const r of (Array.isArray(byAddr) ? byAddr : [])) {
          if (!r.address) continue;
          const rawLbl = r.account || '';
          const lbl    = LABEL_REWRITES[rawLbl] || rawLbl;
          const isOwn  = !lbl || OWN_HINT.test(lbl);
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
            if (tx.id && !seenTxids.has(tx.id)) {
              dispatch('bridge', 'transactionTableChanged', tx);
              // Mirror SpectreGUI::incomingTransaction — fire an OS
              // notification on newly-seen incoming tx (positive amount),
              // but only if the Notifications option includes this tx type
              // (or is "*" for everything). Matches original C++ filter.
              try {
                if (window.aliasBridge && window.aliasBridge.notify && Number(tx.amount) > 0) {
                  const notifications = (bridge.info.options && bridge.info.options.Notifications) || [];
                  const allowAll = notifications.length === 0 || notifications[0] === '*';
                  const txType   = String(tx.type || tx.t || '').toLowerCase();
                  if (allowAll || notifications.includes(txType)) {
                    const body = `+${Number(tx.amount).toFixed(8)} ALIAS` + (tx.label ? ` (${tx.label})` : '');
                    window.aliasBridge.notify('ALIAS — incoming transaction', body);
                  }
                }
              } catch (_) {}
            }
          }
        }
        for (const tx of translated) if (tx.id) seenTxids.add(tx.id);
      }
    }

    poll();
    setInterval(poll, POLL_MS);
  }
})();
