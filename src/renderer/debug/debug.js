(function () {
  'use strict';
  const bridge = window.aliasBridge;
  const $ = (id) => document.getElementById(id);

  // Tab switching
  const tabs = document.querySelectorAll('.tab');
  const panes = { information: $('tab-information'), console: $('tab-console'), peers: $('tab-peers') };
  tabs.forEach((btn) => btn.addEventListener('click', () => {
    tabs.forEach((b) => b.classList.toggle('active', b === btn));
    Object.entries(panes).forEach(([k, el]) => el.style.display = (k === btn.dataset.tab ? '' : 'none'));
  }));

  async function rpc(method, params = []) {
    return await bridge.rpc(method, params);
  }

  // Information tab
  async function refreshInfo() {
    try {
      const info = await rpc('getinfo', []);
      $('info-client-name').textContent = 'ALIAS Core';
      $('info-client-version').textContent = info.version || 'N/A';
      $('info-build-date').textContent = info.build_date || (info.version || '').replace(/.* - /, '').replace(/\)$/, '') || 'N/A';
      $('info-network-name').textContent = info.testnet ? 'testnet' : 'main';
      $('info-connections').textContent = String(info.connections != null ? info.connections : 'N/A');
      $('info-blocks').textContent = String(info.blocks != null ? info.blocks : 'N/A');
      // getinfo has no startup time; the main process started the daemon,
      // so ask it.
      const started = bridge.daemonStartedAt ? await bridge.daemonStartedAt() : null;
      $('info-startup-time').textContent = started ? new Date(started).toLocaleString() : 'N/A';
    } catch (e) { /* tolerate */ }
    try {
      const tip = await rpc('getbestblockhash', []);
      if (tip) {
        const blk = await rpc('getblock', [tip]);
        $('info-last-block-time').textContent = blk.time ? new Date(blk.time * 1000).toLocaleString() : 'N/A';
      }
    } catch (e) { /* tolerate */ }
    try {
      const peers = await rpc('getpeerinfo', []);
      const best = (Array.isArray(peers) ? peers : [])
        .reduce((m, p) => Math.max(m, Number(p.chainheight) || 0), 0);
      if (best > 0) $('info-blocks-est').textContent = String(best);
    } catch (e) { /* tolerate */ }
  }

  // Console tab — command input + history (up/down navigation)
  const scrollEl = $('console-scroll');
  const inputEl = $('console-input');
  const history = [];
  let histIdx = -1;

  function append(text, cls) {
    const line = document.createElement('div');
    line.className = 'console-line ' + (cls || '');
    line.textContent = text;
    scrollEl.appendChild(line);
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function welcome() {
    append('Welcome to the ALIAS RPC console.', 'console-out');
    append("Use up and down arrows to navigate history, type 'help' for a list of commands.", 'console-out');
    append('', '');
  }
  welcome();

  async function runCommand(cmd) {
    if (!cmd.trim()) return;
    append(cmd, 'console-cmd');
    history.push(cmd);
    if (history.length > 200) history.shift();
    histIdx = history.length;
    // Parse: first token = method, rest = args. Quoted strings preserved.
    const tokens = cmd.match(/"[^"]*"|\S+/g) || [];
    const method = tokens.shift();
    const params = tokens.map((t) => {
      if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
      const asNum = Number(t);
      if (!Number.isNaN(asNum) && t === String(asNum)) return asNum;
      if (t === 'true') return true;
      if (t === 'false') return false;
      try { return JSON.parse(t); } catch (_) { return t; }
    });
    try {
      const r = await rpc(method, params);
      const text = (typeof r === 'string') ? r : JSON.stringify(r, null, 2);
      append(text, 'console-out');
    } catch (e) {
      append('error: ' + (e && e.message || e), 'console-err');
    }
  }

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const cmd = inputEl.value;
      inputEl.value = '';
      runCommand(cmd);
    } else if (e.key === 'ArrowUp') {
      if (history.length === 0) return;
      if (histIdx > 0) histIdx--;
      inputEl.value = history[histIdx] || '';
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (history.length === 0) return;
      if (histIdx < history.length - 1) histIdx++;
      else { histIdx = history.length; inputEl.value = ''; return; }
      inputEl.value = history[histIdx] || '';
      e.preventDefault();
    }
  });

  $('console-clear').addEventListener('click', () => {
    scrollEl.innerHTML = '';
    welcome();
  });

  // Traffic totals (Information tab) + peer list
  function formatBytes(n) {
    const v = Number(n);
    if (!isFinite(v)) return 'N/A';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, x = v;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return (i === 0 ? x : x.toFixed(2)) + ' ' + units[i];
  }
  function formatTime(unixSecs) {
    const v = Number(unixSecs);
    return v > 0 ? new Date(v * 1000).toLocaleString() : '';
  }

  // Selected peer survives a refresh, so the detail panel does not clear
  // itself every 5 seconds while being read.
  let selectedPeer = null;

  function showPeerDetail(p) {
    const set = (id, v) => { $(id).textContent = v == null ? '' : String(v); };
    set('peer-addr', p.addr);
    set('peer-direction', p.inbound ? 'Inbound' : 'Outbound');
    set('peer-subver', p.subver);
    set('peer-version', p.version);
    set('peer-services', p.services);
    set('peer-chainheight', p.chainheight);
    set('peer-conntime', formatTime(p.conntime));
    set('peer-lastsend', formatTime(p.lastsend));
    set('peer-lastrecv', formatTime(p.lastrecv));
    set('peer-bytessent', formatBytes(p.bytessent));
    set('peer-bytesrecv', formatBytes(p.bytesrecv));
    set('peer-pingtime', p.pingtime != null ? Math.round(Number(p.pingtime) * 1000) + ' ms' : '');
    set('peer-timeoffset', p.timeoffset != null ? p.timeoffset + ' s' : '');
    set('peer-banscore', p.banscore);
    $('peer-detail').style.display = '';
    $('peer-hint').style.display = 'none';
  }

  async function refreshNetwork() {
    try {
      const info = await rpc('getnettotals', []);
      $('net-in').textContent = info && info.totalbytesrecv != null ? formatBytes(info.totalbytesrecv) : 'N/A';
      $('net-out').textContent = info && info.totalbytessent != null ? formatBytes(info.totalbytessent) : 'N/A';
    } catch (e) { /* tolerate — RPC may not exist on this fork */ }
    try {
      const peers = await rpc('getpeerinfo', []);
      const list = Array.isArray(peers) ? peers : [];
      const $tbody = document.querySelector('#peer-table tbody');
      $tbody.innerHTML = '';
      let stillConnected = null;
      for (const p of list) {
        const tr = document.createElement('tr');
        // textContent, not innerHTML: subver is whatever the remote peer
        // chose to call itself.
        const cells = [
          p.addr || '',
          p.subver || p.version || '',
          p.pingtime != null ? Math.round(Number(p.pingtime) * 1000) + ' ms' : '',
        ];
        for (const text of cells) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        }
        if (selectedPeer && p.addr === selectedPeer) {
          tr.classList.add('selected');
          stillConnected = p;
        }
        tr.addEventListener('click', () => {
          selectedPeer = p.addr;
          for (const row of $tbody.children) row.classList.remove('selected');
          tr.classList.add('selected');
          showPeerDetail(p);
        });
        $tbody.appendChild(tr);
      }
      if (stillConnected) showPeerDetail(stillConnected);
      else if (selectedPeer) {
        // The peer we were looking at has gone away.
        selectedPeer = null;
        $('peer-detail').style.display = 'none';
        $('peer-hint').style.display = '';
      }
    } catch (e) { /* tolerate */ }
  }

  // Buttons
  $('btn-open-log').addEventListener('click', async () => {
    try { await bridge.openDebugLog && bridge.openDebugLog(); } catch (_) {}
  });
  $('btn-show-help').addEventListener('click', async () => {
    try {
      const h = await rpc('help', []);
      // switch to console tab, dump help
      document.querySelector('.tab[data-tab="console"]').click();
      append(String(h), 'console-out');
    } catch (e) { append('help failed: ' + e.message, 'console-err'); }
  });

  // Refresh on load + every 5s while window is open
  refreshInfo();
  refreshNetwork();
  setInterval(() => { refreshInfo(); refreshNetwork(); }, 5000);

  inputEl.focus();
})();
