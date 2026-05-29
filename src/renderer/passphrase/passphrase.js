// Multi-mode passphrase dialog. Mirrors src/qt/askpassphrasedialog.{cpp,ui}
// and src/qt/forms/askpassphrasedialog.ui from the original Alias 4.4.0.
//
// All visible text comes from that source — keep this file's strings in
// sync with the C++ implementation.

(function () {
  'use strict';

  const mode = (window.location.hash || '#unlock').slice(1).toLowerCase();

  // Elements (names match the original .ui object names).
  const warningLabel = document.getElementById('warning');
  const passLabel1   = document.getElementById('passLabel1');
  const passLabel2   = document.getElementById('passLabel2');
  const passLabel3   = document.getElementById('passLabel3');
  const rowPass1     = document.getElementById('row-pass1');
  const rowPass2     = document.getElementById('row-pass2');
  const rowPass3     = document.getElementById('row-pass3');
  const passEdit1    = document.getElementById('pass1');
  const passEdit2    = document.getElementById('pass2');
  const passEdit3    = document.getElementById('pass3');
  const capsLabel    = document.getElementById('capsLabel');
  const stakingRow   = document.getElementById('stakingRow');
  const stakingBox   = document.getElementById('stakingCheckBox');
  const stakingText  = document.getElementById('stakingText');
  const btnOk        = document.getElementById('btn-ok');
  const btnCancel    = document.getElementById('btn-cancel');

  // Per-mode UI — direct port of AskPassphraseDialog ctor switch.
  switch (mode) {
    case 'encrypt':
      rowPass1.hidden = true;
      rowPass2.hidden = false;
      rowPass3.hidden = false;
      warningLabel.innerHTML = 'Enter the new passphrase to the wallet.<br/>Please use a passphrase of <b>10 or more random characters</b>, or <b>eight or more words</b>.';
      document.title = 'Encrypt wallet';
      break;
    case 'unlockrescan':
      stakingText.textContent = 'Keep wallet unlocked for staking.';
      stakingRow.hidden = false;
      // fallthru: only pass1 visible
      rowPass2.hidden = true;
      rowPass3.hidden = true;
      warningLabel.innerHTML = 'Your wallet contains locked ATXOs for which its spending state can only be determinate with your private key. Your <b>private ALIAS balance might be shown wrong</b>.';
      document.title = 'Unlock wallet';
      break;
    case 'unlocklogin':
      stakingText.textContent = 'Keep wallet unlocked for staking.';
      stakingRow.hidden = false;
      rowPass2.hidden = true;
      rowPass3.hidden = true;
      warningLabel.innerHTML = '<b>Alias Wallet Login</b>';
      document.title = 'Unlock wallet';
      break;
    case 'unlockstaking':
      stakingBox.checked = true;  // original: setChecked(mode == UnlockStaking)
      stakingRow.hidden = false;
      rowPass2.hidden = true;
      rowPass3.hidden = true;
      warningLabel.innerHTML = 'This operation needs your wallet passphrase to unlock the wallet.';
      document.title = 'Unlock wallet';
      break;
    case 'unlock':
      rowPass2.hidden = true;
      rowPass3.hidden = true;
      warningLabel.innerHTML = 'This operation needs your wallet passphrase to unlock the wallet.';
      document.title = 'Unlock wallet';
      break;
    case 'decrypt':
      warningLabel.innerHTML = 'This operation needs your wallet passphrase to decrypt the wallet.';
      rowPass2.hidden = true;
      rowPass3.hidden = true;
      document.title = 'Decrypt wallet';
      break;
    case 'changepass':
      rowPass2.hidden = false;
      rowPass3.hidden = false;
      warningLabel.innerHTML = 'Enter the old and new passphrase to the wallet.';
      document.title = 'Change passphrase';
      break;
    default:
      warningLabel.innerHTML = '';
      document.title = 'Passphrase Dialog';
  }

  // textChanged — enable OK only when all required fields are non-empty.
  function textChanged() {
    let acceptable = false;
    switch (mode) {
      case 'encrypt':
        acceptable = passEdit2.value.length > 0 && passEdit3.value.length > 0;
        break;
      case 'unlock':
      case 'unlockstaking':
      case 'unlocklogin':
      case 'unlockrescan':
      case 'decrypt':
        acceptable = passEdit1.value.length > 0;
        break;
      case 'changepass':
        acceptable = passEdit1.value.length > 0 && passEdit2.value.length > 0 && passEdit3.value.length > 0;
        break;
    }
    btnOk.disabled = !acceptable;
  }
  [passEdit1, passEdit2, passEdit3].forEach((el) => el.addEventListener('input', textChanged));
  textChanged();

  // Caps Lock detection (matches the Qt event() override).
  function maybeShowCaps(e) {
    const on = e && typeof e.getModifierState === 'function' && e.getModifierState('CapsLock');
    capsLabel.textContent = on ? 'Warning: The Caps Lock key is on!' : '';
  }
  document.addEventListener('keydown', maybeShowCaps);
  document.addEventListener('keyup',   maybeShowCaps);

  // Focus the first visible input.
  setTimeout(() => {
    if (!rowPass1.hidden) passEdit1.focus();
    else if (!rowPass2.hidden) passEdit2.focus();
  }, 0);

  // accept() — build payload, validate, hand back to main.
  function submit() {
    let payload;
    switch (mode) {
      case 'encrypt': {
        const newPass = passEdit2.value;
        const confirm = passEdit3.value;
        if (!newPass || !confirm) return; // shouldn't happen — OK is disabled
        if (newPass !== confirm) {
          // QMessageBox::critical Wallet encryption failed / The supplied passphrases do not match.
          window.alert('Wallet encryption failed\n\nThe supplied passphrases do not match.');
          return;
        }
        const ok = window.confirm(
          'Confirm wallet encryption\n\n' +
          'Warning: If you encrypt your wallet and lose your passphrase, you will LOSE ALL OF YOUR COINS!\n\n' +
          'Are you sure you wish to encrypt your wallet?'
        );
        if (!ok) return;
        payload = { mode, passphrase: newPass };
        break;
      }
      case 'unlock':
      case 'unlockstaking':
      case 'unlocklogin':
      case 'unlockrescan':
        payload = { mode, passphrase: passEdit1.value, stakingOnly: !!stakingBox.checked };
        break;
      case 'decrypt':
        payload = { mode, passphrase: passEdit1.value };
        break;
      case 'changepass': {
        const oldPass = passEdit1.value;
        const newPass = passEdit2.value;
        const confirm = passEdit3.value;
        if (newPass !== confirm) {
          window.alert('Wallet encryption failed\n\nThe supplied passphrases do not match.');
          return;
        }
        payload = { mode, oldPass, newPass };
        break;
      }
      default:
        payload = null;
    }
    window.aliasBridge.passphraseResult(payload);
  }

  btnOk.addEventListener('click', submit);
  btnCancel.addEventListener('click', () => window.aliasBridge.passphraseResult(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { if (!btnOk.disabled) { e.preventDefault(); submit(); } }
    if (e.key === 'Escape') { e.preventDefault(); window.aliasBridge.passphraseResult(null); }
  });
})();
