// Setup wizard — mirrors the original Qt SetupWalletWizard. Runs in its own
// BrowserWindow before the main UI loads. Talks to the daemon via the same
// `aliasBridge.rpc(...)` IPC handle exposed by preload.js.

(function () {
  'use strict';

  // ---------- nav state ----------

  // Page order depends on the chosen path. Each path is a linear sequence
  // of page ids that match `data-page="..."` in index.html.
  const PATHS = {
    new:     ['intro', 'new-settings', 'new-result', 'new-verify', 'encrypt', 'done'],
    recover: ['intro', 'recover',                                    'encrypt', 'done'],
    import:  ['intro', 'import',                                     'encrypt', 'done'],
  };

  let path = 'new';
  let idx  = 0;
  let masterKey = null;        // BIP32 ext key from mnemonic new/decode — what we import
  let mnemonicWords = [];      // 24-word array shown to user (new flow)

  function pageEl(id) { return document.querySelector(`[data-page="${id}"]`); }
  function show(id) {
    document.querySelectorAll('.wizard-page').forEach(el => el.hidden = (el.dataset.page !== id));
  }
  function setBtn(id, enabled, label) {
    const el = document.getElementById(id);
    el.disabled = !enabled;
    if (label) el.textContent = label;
  }

  function rpc(method, params) { return window.aliasBridge.rpc(method, params || []); }

  // ---------- page-specific handlers ----------

  async function onEnterNewSettings() {
    document.getElementById('mnemonic-password').value = '';
    document.getElementById('mnemonic-password-confirm').value = '';
  }

  async function onLeaveNewSettings() {
    const pw   = document.getElementById('mnemonic-password').value;
    const pwc  = document.getElementById('mnemonic-password-confirm').value;
    const lang = document.getElementById('mnemonic-language').value;
    if (pw !== pwc) { alert('Passwords do not match.'); return false; }
    // mnemonic new [password] [language] [nBytesEntropy] [bip44]
    // All params are .get_str()'d server-side — pass everything as a string.
    try {
      const r = await rpc('mnemonic', ['new', pw, lang, '32', 'false']);
      mnemonicWords = (r && r.mnemonic ? String(r.mnemonic) : '').split(/\s+/).filter(Boolean);
      masterKey = r && r.master;
      if (mnemonicWords.length < 12 || !masterKey) {
        alert('mnemonic RPC returned unexpected shape: ' + JSON.stringify(r));
        return false;
      }
    } catch (e) {
      alert('mnemonic new failed: ' + e.message);
      return false;
    }
    return true;
  }

  function onEnterNewResult() {
    const grid = document.getElementById('mnemonic-words');
    grid.innerHTML = '';
    mnemonicWords.forEach((w, i) => {
      const div = document.createElement('div');
      div.className = 'word';
      div.innerHTML = `<span class="idx">${i + 1}.</span><span>${w}</span>`;
      grid.appendChild(div);
    });
  }

  function onEnterNewVerify() {
    const grid = document.getElementById('mnemonic-verify-grid');
    grid.innerHTML = '';
    for (let i = 0; i < mnemonicWords.length; i++) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = (i + 1) + '.';
      inp.autocomplete = 'off';
      inp.addEventListener('input', onVerifyInput);
      grid.appendChild(inp);
    }
    setBtn('btn-next', false);
    document.getElementById('verify-status').textContent = '';
  }

  function onVerifyInput() {
    const inputs = document.querySelectorAll('#mnemonic-verify-grid input');
    const typed  = Array.from(inputs).map(i => i.value.trim().toLowerCase());
    const expect = mnemonicWords.map(w => w.toLowerCase());
    const allFilled = typed.every(t => t.length > 0);
    const allMatch  = allFilled && typed.every((t, i) => t === expect[i]);
    const status = document.getElementById('verify-status');
    if (!allFilled) { status.textContent = ''; status.className = 'verify-status'; setBtn('btn-next', false); return; }
    if (allMatch)  { status.textContent = 'Match.'; status.className = 'verify-status ok'; setBtn('btn-next', true);  }
    else           { status.textContent = 'Some words do not match.'; status.className = 'verify-status bad'; setBtn('btn-next', false); }
  }

  function onEnterRecover() {
    const grid = document.getElementById('recover-grid');
    if (!grid.children.length) {
      for (let i = 0; i < 24; i++) {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = (i + 1) + '.'; inp.autocomplete = 'off';
        grid.appendChild(inp);
      }
    }
  }

  async function onLeaveRecover() {
    const inputs = document.querySelectorAll('#recover-grid input');
    const phrase = Array.from(inputs).map(i => i.value.trim()).filter(Boolean).join(' ');
    const pw = document.getElementById('recover-password').value;
    if (phrase.split(/\s+/).length !== 24) { alert('Enter exactly 24 words.'); return false; }
    // mnemonic decode <password> <mnemonic> [bip44]
    try {
      const r = await rpc('mnemonic', ['decode', pw, phrase, 'false']);
      masterKey = r && r.master;
      if (!masterKey) { alert('mnemonic decode returned no master key: ' + JSON.stringify(r)); return false; }
    } catch (e) {
      alert('mnemonic decode failed: ' + e.message);
      return false;
    }
    return true;
  }

  let importPath = null;
  document.getElementById('import-pick').addEventListener('click', async () => {
    const p = await window.aliasBridge.pickWalletDat();
    if (p) { importPath = p; document.getElementById('import-selected').textContent = p; }
  });
  async function onLeaveImport() {
    if (!importPath) { alert('Choose a wallet.dat file first.'); return false; }
    try {
      const ok = await window.aliasBridge.importWalletDat(importPath);
      if (!ok) { alert('Import failed.'); return false; }
    } catch (e) { alert('Import failed: ' + e.message); return false; }
    masterKey = '__imported__';  // marker — skip extkey import on done page
    return true;
  }

  // Install the mnemonic-derived master key as the wallet's master, replacing
  // the auto-generated one the daemon created on first boot. Idempotent given
  // the labels we use.
  async function installMasterKey() {
    const KEY_LABEL = 'Wizard Master';
    const ACC_LABEL = 'Wizard Account';
    await rpc('extkey', ['import', masterKey, KEY_LABEL, 'false', 'false']);
    const list = await rpc('extkey', ['list']);
    const entries = Array.isArray(list) ? list : [];
    const newKey = entries.find((e) => e.label === KEY_LABEL && e.type === 'Loose');
    if (!newKey || !newKey.id) throw new Error('imported master key not found in extkey list');
    await rpc('extkey', ['setmaster', newKey.id]);
    await rpc('extkey', ['deriveaccount', ACC_LABEL]);
    const list2 = await rpc('extkey', ['list']);
    const entries2 = Array.isArray(list2) ? list2 : [];
    const newAcc = entries2.find((e) => e.label === ACC_LABEL && e.type === 'Account');
    if (newAcc && newAcc.id) await rpc('extkey', ['setdefaultaccount', newAcc.id]);
  }

  async function onLeaveEncrypt() {
    const skip = document.getElementById('encrypt-skip').checked;
    let passphrase = null;
    if (!skip) {
      const pw  = document.getElementById('encrypt-password').value;
      const pwc = document.getElementById('encrypt-password-confirm').value;
      if (pw.length < 8) { alert('Use at least 8 characters.'); return false; }
      if (pw !== pwc)    { alert('Passwords do not match.'); return false; }
      passphrase = pw;
    }
    // Master install + account derive MUST happen on an unencrypted wallet.
    // Do this first, then encrypt at the end.
    try {
      if (masterKey && masterKey !== '__imported__') {
        await installMasterKey();
      }
      if (passphrase) {
        // `encryptwallet` typically restarts the daemon — the RPC may not return.
        try { await rpc('encryptwallet', [passphrase]); }
        catch (e) { console.warn('encryptwallet returned/threw (expected at restart):', e.message); }
      }
    } catch (e) {
      alert('Setup failed: ' + (e.message || e));
      return false;
    }
    return true;
  }

  async function onEnterDone() {
    document.getElementById('done-status').textContent = 'Wallet ready. Click "Open Wallet" to continue.';
    setBtn('btn-next', true, 'Open Wallet');
    setBtn('btn-back', false);
  }

  // ---------- nav glue ----------

  async function onLeavePage(pageId) {
    if (pageId === 'intro') {
      path = document.querySelector('input[name=setup-path]:checked').value;
      return true;
    }
    if (pageId === 'new-settings') return await onLeaveNewSettings();
    if (pageId === 'recover')       return await onLeaveRecover();
    if (pageId === 'import')        return await onLeaveImport();
    if (pageId === 'encrypt')       return await onLeaveEncrypt();
    return true;
  }
  async function onEnterPage(pageId) {
    if (pageId === 'new-settings')  return await onEnterNewSettings();
    if (pageId === 'new-result')    return onEnterNewResult();
    if (pageId === 'new-verify')    return onEnterNewVerify();
    if (pageId === 'recover')       return onEnterRecover();
    if (pageId === 'done')          return await onEnterDone();
  }

  async function goto(newIdx) {
    const cur = PATHS[path][idx];
    if (newIdx > idx && !(await onLeavePage(cur))) return;
    idx = newIdx;
    const next = PATHS[path][idx];
    show(next);
    setBtn('btn-back', idx > 0);
    setBtn('btn-next', true, next === 'done' ? 'Open Wallet' : 'Next >');
    await onEnterPage(next);
  }

  document.getElementById('btn-next').addEventListener('click', async () => {
    const cur = PATHS[path][idx];
    if (cur === 'done') { window.aliasBridge.wizardComplete(); return; }
    if (idx >= PATHS[path].length - 1) return;
    await goto(idx + 1);
  });
  document.getElementById('btn-back').addEventListener('click', async () => { if (idx > 0) await goto(idx - 1); });
  document.getElementById('btn-cancel').addEventListener('click', () => window.aliasBridge.wizardCancel());

  // Per-page Help text — strings copied from setupwalletwizard.cpp showHelp().
  const HELP = {
    'intro':        "The file 'wallet.dat', which holds your private keys, could not be found during startup. It must be created now.\n\nThe private key consists of alphanumerical characters that give a user access and control over their funds to their corresponding cryptocurrency address.",
    'new-settings': "Mnemonic Seed Words allow you to create and later recover your private keys. The seed consists of 24 words and the optional password functions as a 25th word that you can keep secret to protect your seed.",
    'new-result':   "It is recommended to make multiple copies of the seed words, stored in different locations.\n\nAttention: Seed Words cannot later be (re)created from your existing private keys. If you lose your Seed Words and don't have a backup of the wallet.dat file, you lose your coins!",
    'new-verify':   "Please enter the mnemonic words and password given on the previous screen.",
    'recover':      "Please enter your mnemonic words and (optional) password.",
    'import':       "If you have a backup of a wallet.dat, you can import this file.",
    'encrypt':      "Encrypting your wallet protects your private keys with a passphrase. You will need this passphrase to send coins.",
  };
  document.getElementById('btn-help').addEventListener('click', () => {
    const cur = PATHS[path][idx];
    alert(HELP[cur] || 'This help is likely not to be of any help.');
  });

  // Boot.
  show('intro');
})();
