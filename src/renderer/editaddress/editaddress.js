// Mirrors src/qt/editaddressdialog.{cpp,ui}.
//   modes (passed via URL hash): new-receiving / new-sending / edit-receiving / edit-sending
//   each mode sets the window title + visibility/enabled state per the C++ switch.
//
// Returns the entered { label, address, stealth } to main when OK is clicked,
// or null on Cancel.

(function () {
  'use strict';
  // Accept both the kebab-case form ('new-sending') and the original Qt
  // class-style camelCase form ('NewSendingAddress'). Normalize to kebab.
  const rawMode = (window.location.hash || '#new-sending').slice(1);
  const mode = rawMode
    .replace(/^([A-Z][a-z]+)([A-Z][a-z]+)Address$/, (_, a, b) => `${a}-${b}`)
    .toLowerCase();

  const rowAddress = document.getElementById('row-address');
  const rowStealth = document.getElementById('row-stealth');
  const labelEdit  = document.getElementById('labelEdit');
  const addressEdit = document.getElementById('addressEdit');
  const stealthCB  = document.getElementById('stealthCB');
  const errorP     = document.getElementById('error');
  const btnOk      = document.getElementById('btn-ok');
  const btnCancel  = document.getElementById('btn-cancel');

  // Read initial values from URL query (used when editing).
  const params = new URLSearchParams(window.location.search);
  labelEdit.value   = params.get('label')   || '';
  addressEdit.value = params.get('address') || '';
  if (params.get('stealth') === '1') stealthCB.checked = true;

  // Per-mode configuration — direct port of EditAddressDialog ctor.
  switch (mode) {
    case 'new-receiving':
      document.title = 'New receiving address';
      addressEdit.disabled = true;
      rowAddress.hidden = true;
      rowStealth.hidden = false;
      stealthCB.disabled = false;
      break;
    case 'new-sending':
      document.title = 'New sending address';
      rowStealth.hidden = true;
      break;
    case 'edit-receiving':
      document.title = 'Edit receiving address';
      addressEdit.disabled = true;
      rowStealth.hidden = false;
      stealthCB.disabled = true;
      break;
    case 'edit-sending':
      document.title = 'Edit sending address';
      rowStealth.hidden = true;
      break;
    default:
      document.title = 'Edit Address';
  }

  function showError(msg) { errorP.textContent = msg; errorP.hidden = !msg; }

  btnOk.addEventListener('click', () => {
    const label = labelEdit.value.trim();
    if (!label) { showError('Please enter a label.'); return; }
    const isNew = mode.startsWith('new-');
    const isReceiving = mode.endsWith('receiving');
    if (!isReceiving && isNew && !addressEdit.value.trim()) {
      showError('Please enter an address.');
      return;
    }
    window.aliasBridge.editAddressResult({
      mode,
      label,
      address: addressEdit.value.trim(),
      stealth: !!stealthCB.checked,
    });
  });
  btnCancel.addEventListener('click', () => window.aliasBridge.editAddressResult(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); btnOk.click(); }
    if (e.key === 'Escape') { e.preventDefault(); btnCancel.click(); }
  });
})();
