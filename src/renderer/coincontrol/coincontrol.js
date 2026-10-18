(function () {
  'use strict';
  const rowsEl = document.getElementById('rows');
  const qtyEl  = document.getElementById('qty');
  const amtEl  = document.getElementById('amt');
  const selQty = document.getElementById('selectedQty');
  const selAmt = document.getElementById('selectedAmt');
  const checkAll = document.getElementById('checkAll');

  // Initial state — restore previous selection if it lives on the opener
  // window. The Coin Control dialog is opened as a child of mainWindow, so
  // we cross-window message via the IPC bridge.
  let utxos = [];
  let selectedKeys = new Set();

  async function loadSelection() {
    try {
      if (window.opener && window.opener.__aliasShim) {
        const sel = window.opener.__aliasShim.coinControl && window.opener.__aliasShim.coinControl.selected;
        if (Array.isArray(sel)) sel.forEach((s) => selectedKeys.add(s.txid + ':' + s.vout));
      }
    } catch (_) {}
  }

  function utxoKey(u) { return (u.txid || '') + ':' + (u.vout || 0); }

  // Tree mode mirrors original CoinControlDialog::updateView grouping —
  // UTXOs grouped by source address; aggregate amount per group header.
  // List mode is one UTXO per row (flat).
  let viewMode = 'list';
  document.querySelectorAll('input[name="viewmode"]').forEach((r) => {
    r.addEventListener('change', () => { viewMode = r.value; render(); });
  });

  function cell(text, opts) {
    const td = document.createElement('td');
    if (opts && opts.bold) {
      const b = document.createElement('b');
      b.textContent = text;
      td.appendChild(b);
    } else {
      td.textContent = text;
    }
    if (opts && opts.colspan) td.colSpan = opts.colspan;
    return td;
  }

  function checkboxCell(key, checked) {
    const td = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.dataset.k = key;
    td.appendChild(cb);
    return td;
  }

  function outpoint(u) {
    return String(u.txid || '').slice(0, 16) + '… (' + u.vout + ')';
  }

  function message(text) {
    rowsEl.replaceChildren();
    const tr = document.createElement('tr');
    tr.appendChild(cell(text, { colspan: 5 }));
    tr.firstChild.className = 'loading';
    rowsEl.appendChild(tr);
  }

  function render() {
    if (utxos.length === 0) {
      message('No unspent outputs.');
      qtyEl.textContent = '0'; amtEl.textContent = '0.00000000 ALIAS';
      selQty.textContent = '0'; selAmt.textContent = '0.00000000 ALIAS';
      return;
    }
    rowsEl.replaceChildren();
    let total = 0, selTotal = 0, selCount = 0;

    if (viewMode === 'tree') {
      const byAddr = new Map();
      for (const u of utxos) {
        const addr = u.address || '(unknown)';
        if (!byAddr.has(addr)) byAddr.set(addr, []);
        byAddr.get(addr).push(u);
        total += Number(u.amount) || 0;
      }
      for (const [addr, items] of byAddr) {
        const groupAmt = items.reduce((s, u) => s + (Number(u.amount) || 0), 0);
        const header = document.createElement('tr');
        header.className = 'group-header';
        header.append(
          cell(''),
          cell(groupAmt.toFixed(8), { bold: true }),
          cell(addr, { bold: true, colspan: 2 }),
          cell(items.length + ' output(s)'),
        );
        rowsEl.appendChild(header);
        for (const u of items) {
          const amt = Number(u.amount) || 0;
          const k = utxoKey(u);
          const checked = selectedKeys.has(k);
          if (checked) { selTotal += amt; selCount++; }
          const tr = document.createElement('tr');
          tr.dataset.k = k;
          tr.className = 'group-child';
          tr.append(
            checkboxCell(k, checked),
            cell(amt.toFixed(8)),
            cell(''),
            cell(String(u.confirmations || 0)),
            cell(outpoint(u)),
          );
          rowsEl.appendChild(tr);
        }
      }
    } else {
      for (const u of utxos) {
        const amt = Number(u.amount) || 0;
        total += amt;
        const k = utxoKey(u);
        const checked = selectedKeys.has(k);
        if (checked) { selTotal += amt; selCount++; }
        const tr = document.createElement('tr');
        tr.dataset.k = k;
        tr.append(
          checkboxCell(k, checked),
          cell(amt.toFixed(8)),
          cell(u.address || ''),
          cell(String(u.confirmations || 0)),
          cell(outpoint(u)),
        );
        rowsEl.appendChild(tr);
      }
    }

    qtyEl.textContent = String(utxos.length);
    amtEl.textContent = total.toFixed(8) + ' ALIAS';
    selQty.textContent = String(selCount);
    selAmt.textContent = selTotal.toFixed(8) + ' ALIAS';
    checkAll.checked = utxos.length > 0 && selCount === utxos.length;
  }

  rowsEl.addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.tagName !== 'INPUT' || cb.type !== 'checkbox') return;
    const k = cb.dataset.k;
    if (cb.checked) selectedKeys.add(k);
    else selectedKeys.delete(k);
    render();
  });
  checkAll.addEventListener('change', () => {
    if (checkAll.checked) utxos.forEach((u) => selectedKeys.add(utxoKey(u)));
    else selectedKeys.clear();
    render();
  });
  document.getElementById('btn-clear').addEventListener('click', () => {
    selectedKeys.clear();
    render();
  });
  document.getElementById('btn-close').addEventListener('click', async () => {
    let fee = 0.0001;
    try {
      const info = await window.aliasBridge.rpc('getinfo', []);
      if (info && Number(info.paytxfee) > 0) fee = Number(info.paytxfee);
    } catch (_) { /* keep the default */ }
    try {
      const sel = utxos.filter((u) => selectedKeys.has(utxoKey(u))).map((u) => ({
        txid: u.txid, vout: u.vout, amount: u.amount, address: u.address,
      }));
      if (window.opener && window.opener.__aliasShim) {
        window.opener.__aliasShim.coinControl = { selected: sel };
        // Fire emitCoinControlUpdate so the Send page coincontrol_labels
        // panel updates with quantity/amount/etc. Matches the original
        // C++ side's CoinControlDialog::updateLabels call.
        const totalAmt = sel.reduce((s, u) => s + Number(u.amount || 0), 0);
        window.opener.__aliasShim.dispatch('bridge', 'emitCoinControlUpdate',
          String(sel.length), totalAmt.toFixed(8) + ' ALIAS',
          fee.toFixed(8) + ' ALIAS', (totalAmt - fee).toFixed(8) + ' ALIAS',
          '0', '0', false, '0');
      }
    } catch (_) {}
    window.close();
  });

  (async function init() {
    await loadSelection();
    try {
      utxos = await window.aliasBridge.rpc('listunspent', [0]);
      if (!Array.isArray(utxos)) utxos = [];
    } catch (e) {
      message('listunspent failed: ' + e.message);
      return;
    }
    render();
  })();
})();
