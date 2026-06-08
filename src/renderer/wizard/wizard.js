// Setup wizard — mirrors the original Qt SetupWalletWizard. Runs in its own
// BrowserWindow before the main UI loads. Talks to the daemon via the same
// `aliasBridge.rpc(...)` IPC handle exposed by preload.js.

(function () {
  'use strict';

  // ---------- nav state ----------

  // Page order depends on the chosen path. Each path is a linear sequence
  // of page ids that match `data-page="..."` in index.html.
  // Matches original setupwalletwizard.h Page_* enum (Intro, Import,
  // NewMnemonic_{Settings,Result,Verification}, Recover, Encrypt). Original
  // had no "done" page — Finish on encrypt closes the wizard and main app
  // opens.
  // Wallet wizard — runs AFTER the NSIS installer has done its work
  // (language, license, components-with-bootstrap, install). The first
  // page is the original Qt SetupWalletWizard intro: "Set Up Your Wallet".
  const PATHS = {
    new:     ['intro', 'new-settings', 'new-result', 'new-verify', 'encrypt'],
    recover: ['intro', 'recover',                                    'encrypt'],
    import:  ['intro', 'import',                                     'encrypt'],
  };

  let path = 'new';
  let idx  = 0;
  let masterKey = null;        // BIP32 ext key from mnemonic new/decode — what we import
  let mnemonicWords = [];      // 24-word array shown to user (new flow)
  let encryptPassphrase = null; // captured on encrypt page so wizard-complete can re-unlock the restarted daemon

  // Verbatim from setupwalletwizard.cpp's setTitle / setSubTitle on each
  // QWizardPage. The header band shows these per page.
  const PAGE_TITLES = {
    'intro':        { title: 'Set Up Your Wallet',                                              subtitle: '' },
    'new-settings': { title: 'Create private keys with Mnemonic Recovery Seed Words',           subtitle: 'Step 1/3: Please define language to use and optional password to protect your seed.' },
    'new-result':   { title: 'Create private keys with Mnemonic Recovery Seed Words',           subtitle: 'Step 2/3: Write down your mnemonic recovery seed words.' },
    'new-verify':   { title: 'Create private keys with Mnemonic Recovery Seed Words',           subtitle: 'Step 3/3: Verify you have the correct words and (optional) password noted.' },
    'recover':      { title: 'Recover private keys from Mnemonic Seed Words',                   subtitle: 'Please enter (optional) password and your mnemonic seed words to recover private keys.' },
    'import':       { title: 'Import wallet.dat',                                               subtitle: 'Please import a wallet.dat file with your private keys.' },
    'encrypt':      { title: 'Wallet Encryption',                                               subtitle: 'Please enter a password to encrypt the wallet.dat file.' },
  };

  function pageEl(id) { return document.querySelector(`[data-page="${id}"]`); }
  function show(id) {
    document.querySelectorAll('.wizard-page').forEach(el => el.hidden = (el.dataset.page !== id));
    const t = PAGE_TITLES[id] || { title: 'ALIAS Wallet Setup', subtitle: '' };
    document.getElementById('wizard-title').textContent    = t.title;
    document.getElementById('wizard-subtitle').textContent = t.subtitle;
    // Intro (Set Up Your Wallet — the wallet-wizard transition point)
    // uses the watermark sidebar like the original Qt SetupWalletWizard.
    // Every other page uses the header band — including the installer-
    // style pages (language, license, components, ready, downloading).
    document.body.classList.toggle('mode-watermark', id === 'intro');
    document.body.classList.toggle('mode-header',    id !== 'intro');
  }
  function setBtn(id, enabled, label) {
    const el = document.getElementById(id);
    el.disabled = !enabled;
    if (label) el.textContent = label;
  }

  function rpc(method, params) { return window.aliasBridge.rpc(method, params || []); }

  // Retry an RPC call up to N times on transient errors (ECONNREFUSED,
  // 500). Daemon goes through phases on startup where it answers
  // getinfo but rejects wallet commands; this gives those commands a
  // few extra seconds before we surface the failure to the user.
  async function rpcRetry(method, params, tries = 8, delayMs = 1500) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await rpc(method, params); }
      catch (e) {
        lastErr = e;
        const msg = String(e && e.message || e);
        const transient = /ECONNREFUSED|status code 5\d\d|timeout/i.test(msg);
        if (!transient) throw e;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

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
    // rpcRetry handles the case where the daemon is still loading the
    // bootstrap-installed block index when the user clicks Next.
    try {
      const r = await rpcRetry('mnemonic', ['new', pw, lang, '32', 'false']);
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
    // Stash the chosen seed password so the next page can verify a match.
    seedPasswordExpected = pw;
    return true;
  }

  function onEnterNewResult() {
    const grid = document.getElementById('mnemonic-words');
    grid.innerHTML = '';
    // Match original screenshot 12: "1. tail   2. aisle   3. taste   4. loud"
    mnemonicWords.forEach((w, i) => {
      const div = document.createElement('div');
      div.className = 'word';
      div.innerHTML = `<span class="idx">${i + 1}.</span><span class="text">${w}</span>`;
      grid.appendChild(div);
    });
  }

  // Track the seed password set on new-settings so we can verify it here.
  let seedPasswordExpected = '';

  function onEnterNewVerify() {
    const grid = document.getElementById('mnemonic-verify-grid');
    grid.innerHTML = '';
    // Original screenshot 13: each input has a "N." prefix on its left.
    for (let i = 0; i < mnemonicWords.length; i++) {
      const cell = document.createElement('div');
      cell.className = 'ngroup';
      const idx = document.createElement('span');
      idx.className = 'idx'; idx.textContent = (i + 1) + '.';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.autocomplete = 'off';
      inp.addEventListener('input', onVerifyInput);
      cell.appendChild(idx); cell.appendChild(inp);
      grid.appendChild(cell);
    }
    // Original setupwalletwizard.cpp NewMnemonicVerificationPage requires
    // re-entering the seed password too (when one was set). Only show the
    // field if user actually chose a non-empty seed password.
    const pwRow = document.getElementById('verify-password-row');
    const pwInp = document.getElementById('verify-password');
    pwInp.value = '';
    pwInp.classList.remove('match', 'mismatch');
    pwInp.removeAttribute('readonly');
    if (seedPasswordExpected.length > 0) {
      pwRow.hidden = false;
      pwInp.addEventListener('input', onVerifyInput);
    } else {
      pwRow.hidden = true;
    }
    setBtn('btn-next', false);
    document.getElementById('verify-status').textContent = '';
  }

  function onVerifyInput() {
    const inputs = document.querySelectorAll('#mnemonic-verify-grid .ngroup input');
    const expect = mnemonicWords.map(w => w.toLowerCase());
    // Per-word color: green if matches, red if mismatch, neutral if empty.
    // Locks the field once it matches — mirrors original setReadOnly pattern.
    inputs.forEach((el, i) => {
      const v = (el.value || '').trim().toLowerCase();
      el.classList.remove('match', 'mismatch');
      if (v.length === 0) { el.removeAttribute('readonly'); return; }
      if (v === expect[i]) { el.classList.add('match'); el.setAttribute('readonly', 'readonly'); }
      else                 { el.classList.add('mismatch'); el.removeAttribute('readonly'); }
    });
    const typed = Array.from(inputs).map(i => i.value.trim().toLowerCase());
    const allFilled = typed.every(t => t.length > 0);
    const allWordsMatch = allFilled && typed.every((t, i) => t === expect[i]);

    // Seed password verification — same color/lock pattern as words.
    const pwInp = document.getElementById('verify-password');
    let pwOk = true;
    if (seedPasswordExpected.length > 0) {
      const v = pwInp.value;
      pwInp.classList.remove('match', 'mismatch');
      if (v.length === 0) { pwInp.removeAttribute('readonly'); pwOk = false; }
      else if (v === seedPasswordExpected) { pwInp.classList.add('match'); pwInp.setAttribute('readonly', 'readonly'); pwOk = true; }
      else { pwInp.classList.add('mismatch'); pwInp.removeAttribute('readonly'); pwOk = false; }
    }

    const allMatch = allWordsMatch && pwOk;
    const status = document.getElementById('verify-status');
    if (!allFilled) { status.textContent = ''; status.className = 'verify-status'; setBtn('btn-next', false); return; }
    if (allMatch)  { status.textContent = 'Match.'; status.className = 'verify-status ok'; setBtn('btn-next', true);  }
    else if (!allWordsMatch) { status.textContent = 'Some words do not match.'; status.className = 'verify-status bad'; setBtn('btn-next', false); }
    else           { status.textContent = 'Seed password does not match.'; status.className = 'verify-status bad'; setBtn('btn-next', false); }
  }

  function onEnterRecover() {
    const grid = document.getElementById('recover-grid');
    if (!grid.children.length) {
      for (let i = 0; i < 24; i++) {
        const cell = document.createElement('div');
        cell.className = 'ngroup';
        const idx = document.createElement('span');
        idx.className = 'idx'; idx.textContent = (i + 1) + '.';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.autocomplete = 'off';
        cell.appendChild(idx); cell.appendChild(inp);
        grid.appendChild(cell);
      }
    }
  }

  async function onLeaveRecover() {
    const inputs = document.querySelectorAll('#recover-grid .ngroup input');
    const phrase = Array.from(inputs).map(i => i.value.trim()).filter(Boolean).join(' ');
    const pw  = document.getElementById('recover-password').value;
    const pwc = document.getElementById('recover-password-confirm').value;
    if (pw !== pwc) { alert('Passwords do not match.'); return false; }
    if (phrase.split(/\s+/).length !== 24) { alert('Enter exactly 24 words.'); return false; }
    try {
      const r = await rpcRetry('mnemonic', ['decode', pw, phrase, 'false']);
      masterKey = r && r.master;
      if (!masterKey) { alert('mnemonic decode returned no master key: ' + JSON.stringify(r)); return false; }
    } catch (e) { alert('mnemonic decode failed: ' + e.message); return false; }
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
    // Each call uses rpcRetry — the daemon can be mid-LoadBlockIndex /
    // mid-rescan when the user clicks Finish, and a single transient
    // 500 shouldn't surface as "Setup failed".
    await rpcRetry('extkey', ['import', masterKey, KEY_LABEL, 'false', 'false']);
    const list = await rpcRetry('extkey', ['list']);
    const entries = Array.isArray(list) ? list : [];
    const newKey = entries.find((e) => e.label === KEY_LABEL && e.type === 'Loose');
    if (!newKey || !newKey.id) throw new Error('imported master key not found in extkey list');
    await rpcRetry('extkey', ['setmaster', newKey.id]);
    await rpcRetry('extkey', ['deriveaccount', ACC_LABEL]);
    const list2 = await rpcRetry('extkey', ['list']);
    const entries2 = Array.isArray(list2) ? list2 : [];
    const newAcc = entries2.find((e) => e.label === ACC_LABEL && e.type === 'Account');
    if (newAcc && newAcc.id) await rpcRetry('extkey', ['setdefaultaccount', newAcc.id]);

    // Create the two default addresses the original Alias UI shows in
    // Receive — "Default Public Address" and "Default Private Address".
    // Without these, listreceivedbyaddress returns empty until the user
    // generates one manually.
    try { await rpcRetry('getnewaddress',        ['Default Public Address']);  } catch (_) {}
    try { await rpcRetry('getnewstealthaddress', ['Default Private Address']); } catch (_) {}
  }

  function setEncryptError(msg, target) {
    const err = document.getElementById('encrypt-error');
    if (err) { err.textContent = msg || ''; err.hidden = !msg; }
    // Mark the offending field invalid (red border) and re-focus it so the
    // user can correct without clicking. Both fields stay editable.
    const pw  = document.getElementById('encrypt-password');
    const pwc = document.getElementById('encrypt-password-confirm');
    pw.classList.remove('invalid'); pwc.classList.remove('invalid');
    if (target) {
      const el = document.getElementById(target);
      if (el) { el.classList.add('invalid'); el.removeAttribute('disabled'); el.focus(); el.select(); }
    }
  }

  async function onLeaveEncrypt() {
    // Original Alias's Page_EncryptWallet has no "skip" option — encryption
    // is required to finish setup (matches Screenshot_15).
    const pw  = document.getElementById('encrypt-password').value;
    const pwc = document.getElementById('encrypt-password-confirm').value;
    if (pw.length < 8) { setEncryptError('Passphrase must be at least 8 characters.', 'encrypt-password'); return false; }
    if (pw !== pwc)    { setEncryptError('Passphrases do not match.', 'encrypt-password-confirm'); return false; }
    const passphrase = pw;
    setEncryptError('', null);
    // Master install + account derive MUST happen on an unencrypted wallet.
    // Do this first, then encrypt at the end.
    try {
      if (masterKey && masterKey !== '__imported__') {
        await installMasterKey();
      }
      // `encryptwallet` typically restarts the daemon — the RPC may not return.
      try { await rpc('encryptwallet', [passphrase]); }
      catch (e) { console.warn('encryptwallet returned/threw (expected at restart):', e.message); }
    } catch (e) {
      alert('Setup failed: ' + (e.message || e));
      return false;
    }
    // Stash so wizardComplete can hand it to main.js — the restarted
    // daemon needs an explicit walletpassphrase before the main window
    // opens, otherwise it boots locked and the renderer's first poll
    // catches a half-initialised wallet (icons stuck on HTML defaults).
    encryptPassphrase = passphrase;
    return true;
  }

  function onEnterEncrypt() {
    // Clear any stale error state from a previous attempt and re-enable
    // both fields just in case.
    const pw  = document.getElementById('encrypt-password');
    const pwc = document.getElementById('encrypt-password-confirm');
    pw.removeAttribute('disabled');  pw.classList.remove('invalid');
    pwc.removeAttribute('disabled'); pwc.classList.remove('invalid');
    const err = document.getElementById('encrypt-error');
    if (err) { err.textContent = ''; err.hidden = true; }
    // Live validation — clear red as user starts editing.
    const clearOnType = (e) => { e.target.classList.remove('invalid'); if (err) { err.textContent = ''; err.hidden = true; } };
    pw.removeEventListener('input', clearOnType);  pw.addEventListener('input', clearOnType);
    pwc.removeEventListener('input', clearOnType); pwc.addEventListener('input', clearOnType);
  }

  // ---------- nav glue ----------

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
    if (pageId === 'encrypt')       return onEnterEncrypt();
  }

  async function goto(newIdx) {
    const cur = PATHS[path][idx];
    if (newIdx > idx && !(await onLeavePage(cur))) return;
    idx = newIdx;
    const next = PATHS[path][idx];
    show(next);
    setBtn('btn-back', idx > 0);
    // Encrypt is the last page in every path; label Next as "Finish" there.
    const isLast = idx === PATHS[path].length - 1;
    setBtn('btn-next', true, isLast ? 'Finish' : 'Next >');
    await onEnterPage(next);
  }

  document.getElementById('btn-next').addEventListener('click', async () => {
    const cur = PATHS[path][idx];
    // Last page (encrypt): run its onLeave (validates + persists), then fire
    // wizard-complete directly. Matches original QWizard's Finish button.
    if (idx === PATHS[path].length - 1) {
      if (!(await onLeavePage(cur))) return;
      window.aliasBridge.wizardComplete(encryptPassphrase);
      return;
    }
    await goto(idx + 1);
  });
  document.getElementById('btn-back').addEventListener('click', async () => { if (idx > 0) await goto(idx - 1); });
  document.getElementById('btn-cancel').addEventListener('click', () => window.aliasBridge.wizardCancel());

  // Per-page Help text — verbatim from setupwalletwizard.cpp showHelp() (52-76).
  const HELP = {
    'intro':        "The file 'wallet.dat', which holds your private keys, could not be found during startup. It must be created now.\n\nThe private key consists of alphanumerical characters that give a user access and control over their funds to their corresponding cryptocurrency address. In other words, the private key creates unique digital signatures for every transaction that enable a user to spend their funds, by proving that the user does in fact have ownership of those funds.",
    'import':       "If you have a backup of a wallet.dat, you can import this file.",
    'new-settings': "Mnemonic Seed Words allow you to create and later recover your private keys. The seed consists of 24 words and the optional password functions as a 25th word that you can keep secret to protect your seed.",
    'new-result':   "It is recommended to make multiple copies of the seed words, stored in different locations.\n\nAttention: Seed Words cannot later be (re)created from your existing private keys.\nIf you lose your Seed Words and don't have a backup of the wallet.dat file, you lose your coins!",
    'new-verify':   "Please enter the mnemonic words and password given on the previous screen.",
    'recover':      "Please enter your mnemonic words and (optional) password.",
  };
  function showHelp(msg) {
    if (window.aliasBridge && window.aliasBridge.showAlert) {
      window.aliasBridge.showAlert('ALIAS Wallet Setup Help', msg);
    } else {
      alert(msg);
    }
  }
  document.getElementById('btn-help').addEventListener('click', () => {
    const cur = PATHS[path][idx];
    showHelp(HELP[cur] || 'This help is likely not to be of any help.');
  });

  // Boot.
  show('intro');
})();
