(function () {
  'use strict';
  const rowsEl = document.getElementById('rows');
  const qtyEl  = document.getElementById('qty');
  const amtEl  = document.getElementById('amt');

  async function load() {
    try {
      const utxos = await window.aliasBridge.rpc('listunspent', [0]);
      const list = Array.isArray(utxos) ? utxos : [];
      if (list.length === 0) {
        rowsEl.innerHTML = '<tr><td colspan="5" class="loading">No unspent outputs.</td></tr>';
        return;
      }
      rowsEl.innerHTML = '';
      let total = 0;
      for (const u of list) {
        const amt  = Number(u.amount) || 0;
        total += amt;
        const tr = document.createElement('tr');
        const dateStr = u.time ? new Date(u.time * 1000).toLocaleString() : '';
        tr.innerHTML = `
          <td>${amt.toFixed(8)}</td>
          <td>${u.address || ''}</td>
          <td>${dateStr}</td>
          <td>${u.confirmations || 0}</td>
          <td>${(u.txid || '').slice(0, 16)}… (${u.vout})</td>`;
        rowsEl.appendChild(tr);
      }
      qtyEl.textContent = String(list.length);
      amtEl.textContent = total.toFixed(8) + ' ALIAS';
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="5" class="loading">listunspent failed: ${e.message}</td></tr>`;
    }
  }
  load();
  document.getElementById('btn-close').addEventListener('click', () => window.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
})();
