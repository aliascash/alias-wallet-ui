// Multi-mode passphrase dialog — mirrors the original Qt AskPassphraseDialog.
//
// Mode is passed via URL hash (#encrypt / #decrypt / #unlock / #unlockstaking /
// #changepass). The page exposes window.aliasBridge.passphraseResult(payload)
// to return the result to main, which closes the window and resolves the
// invoker's Promise.

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const mode = (window.location.hash || '#unlock').slice(1).toLowerCase();
  console.log('[passphrase] mode:', mode, 'url:', window.location.href);

  const introEl = document.getElementById('intro');
  const labelNew = document.getElementById('pp-new-label');
  const rowOld = document.getElementById('row-old');
  const rowConfirm = document.getElementById('row-confirm');
  const stakingRow = document.getElementById('staking-row');
  const errEl = document.getElementById('error');
  const capsEl = document.getElementById('caps-warn');

  const ppOld = document.getElementById('pp-old');
  const ppNew = document.getElementById('pp-new');
  const ppConfirm = document.getElementById('pp-confirm');
  const ppStaking = document.getElementById('pp-staking');

  // Configure visible fields per mode.
  switch (mode) {
    case 'encrypt':
      introEl.textContent = 'Enter the new passphrase for the wallet. Please use a passphrase of 10 or more random characters.';
      rowConfirm.hidden = false;
      labelNew.textContent = 'New passphrase';
      break;
    case 'decrypt':
      introEl.textContent = 'This operation needs your wallet passphrase to decrypt the wallet.';
      labelNew.textContent = 'Passphrase';
      break;
    case 'unlock':
      introEl.textContent = 'This operation needs your wallet passphrase to unlock the wallet.';
      labelNew.textContent = 'Passphrase';
      break;
    case 'unlockstaking':
      introEl.textContent = 'This operation needs your wallet passphrase to unlock the wallet.';
      labelNew.textContent = 'Passphrase';
      stakingRow.hidden = false;
      break;
    case 'changepass':
      introEl.textContent = 'Change wallet passphrase.';
      rowOld.hidden = false;
      rowConfirm.hidden = false;
      labelNew.textContent = 'New passphrase';
      // Old field gets focus instead
      setTimeout(() => ppOld.focus(), 0);
      break;
    default:
      introEl.textContent = 'Enter passphrase.';
      labelNew.textContent = 'Passphrase';
  }

  // Caps Lock warning on keydown.
  function maybeShowCaps(e) {
    if (e && typeof e.getModifierState === 'function') {
      capsEl.hidden = !e.getModifierState('CapsLock');
    }
  }
  document.addEventListener('keydown', maybeShowCaps);
  document.addEventListener('keyup',   maybeShowCaps);

  function showError(msg) { errEl.textContent = msg; errEl.hidden = !msg; }

  function buildPayload() {
    const newPass     = ppNew.value;
    const confirmPass = ppConfirm.value;
    const oldPass     = ppOld.value;

    if (mode === 'changepass') {
      if (!oldPass) { showError('Old passphrase is required.'); return null; }
      if (newPass.length < 1) { showError('New passphrase is required.'); return null; }
      if (newPass !== confirmPass) { showError('New passphrases do not match.'); return null; }
      return { mode, oldPass, newPass };
    }
    if (mode === 'encrypt') {
      if (newPass.length < 8) { showError('Use at least 8 characters.'); return null; }
      if (newPass !== confirmPass) { showError('Passphrases do not match.'); return null; }
      return { mode, passphrase: newPass };
    }
    // unlock / unlockstaking / decrypt: single passphrase
    if (newPass.length === 0) { showError('Enter a passphrase.'); return null; }
    return {
      mode,
      passphrase: newPass,
      stakingOnly: mode === 'unlockstaking' ? !!ppStaking.checked : false,
    };
  }

  document.getElementById('btn-ok').addEventListener('click', () => {
    const payload = buildPayload();
    if (payload) window.aliasBridge.passphraseResult(payload);
  });
  document.getElementById('btn-cancel').addEventListener('click', () => {
    window.aliasBridge.passphraseResult(null);
  });
  // Enter submits, Escape cancels.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); document.getElementById('btn-ok').click(); }
    if (e.key === 'Escape') { e.preventDefault(); document.getElementById('btn-cancel').click(); }
  });
})();
