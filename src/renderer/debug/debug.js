(function () {
  'use strict';
  const bridge = window.aliasBridge;
  const $ = (id) => document.getElementById(id);

  // Tab switching
  const tabs = document.querySelectorAll('.tab');
  const panes = { information: $('tab-information'), console: $('tab-console'), network: $('tab-network') };
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
      $('info-openssl-version').textContent = info.openssl_version || 'N/A';
      $('info-bdb-version').textContent = info.bdb_version || 'N/A';
      $('info-build-date').textContent = info.build_date || (info.version || '').replace(/.* - /, '').replace(/\)$/, '') || 'N/A';
      $('info-network-name').textContent = info.testnet ? 'testnet' : 'main';
      $('info-connections').textContent = String(info.connections != null ? info.connections : 'N/A');
      $('info-blocks').textContent = String(info.blocks != null ? info.blocks : 'N/A');
      $('info-startup-time').textContent = info.startuptime ? new Date(info.startuptime * 1000).toLocaleString() : 'N/A';
    } catch (e) { /* tolerate */ }
    try {
      const tip = await rpc('getbestblockhash', []);
      if (tip) {
        const blk = await rpc('getblock', [tip]);
        $('info-blocks-est').textContent = String(blk.height != null ? blk.height : 'N/A');
        $('info-last-block-time').textContent = blk.time ? new Date(blk.time * 1000).toLocaleString() : 'N/A';
      }
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
    append('Welcome to the Alias RPC console.', 'console-out');
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

  // Network tab — totals + peer list
  async function refreshNetwork() {
    try {
      const info = await rpc('getnettotals', []);
      $('net-in').textContent = info && info.totalbytesrecv != null ? info.totalbytesrecv + ' B' : 'N/A';
      $('net-out').textContent = info && info.totalbytessent != null ? info.totalbytessent + ' B' : 'N/A';
    } catch (e) { /* tolerate — RPC may not exist on this fork */ }
    try {
      const peers = await rpc('getpeerinfo', []);
      const $tbody = document.querySelector('#peer-table tbody');
      $tbody.innerHTML = '';
      for (const p of (Array.isArray(peers) ? peers : [])) {
        const tr = document.createElement('tr');
        const pingMs = (p.pingtime != null) ? (Math.round(Number(p.pingtime) * 1000) + ' ms') : '';
        tr.innerHTML = `<td>${p.addr || ''}</td><td>${p.subver || p.version || ''}</td><td>${pingMs}</td>`;
        $tbody.appendChild(tr);
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

  // TrafficGraphWidget port — 800 rolling samples of in/out KB/s drawn on
  // a black canvas, green-fill for recv, red-fill for sent. Range select
  // changes update interval (range * 60 * 1000 / 800 ms per sample).
  const DESIRED_SAMPLES = 800;
  const XMARGIN = 10, YMARGIN = 10;
  const canvas = $('traffic-graph');
  const ctx = canvas.getContext('2d');
  let samplesIn = [], samplesOut = [];
  let lastBytesIn = 0, lastBytesOut = 0, lastTimestamp = 0;
  let fMax = 0;
  let graphTimer = null;

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(200, Math.floor(rect.width));
    canvas.height = 160;
  }
  resizeCanvas();
  window.addEventListener('resize', () => { resizeCanvas(); drawGraph(); });

  function drawPath(samples, fillStyle, strokeStyle) {
    if (!samples.length) return;
    const w = canvas.width - XMARGIN * 2, h = canvas.height - YMARGIN * 2;
    ctx.beginPath();
    let x = XMARGIN + w;
    ctx.moveTo(x, YMARGIN + h);
    for (let i = 0; i < samples.length; i++) {
      x = XMARGIN + w - w * i / DESIRED_SAMPLES;
      const y = YMARGIN + h - (h * samples[i] / fMax);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(x, YMARGIN + h);
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  function drawGraph() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (fMax <= 0) return;
    const w = canvas.width - XMARGIN * 2, h = canvas.height - YMARGIN * 2;
    // x-axis baseline
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(XMARGIN, YMARGIN + h); ctx.lineTo(XMARGIN + w, YMARGIN + h); ctx.stroke();
    // KB/s labels at order-of-magnitude
    const base = Math.floor(Math.log10(fMax));
    const val = Math.pow(10, base);
    ctx.fillStyle = '#888'; ctx.font = '10px Consolas, monospace';
    ctx.fillText(val + ' KB/s', XMARGIN, YMARGIN + h - h * val / fMax);
    for (let y = val; y < fMax; y += val) {
      const yy = YMARGIN + h - h * y / fMax;
      ctx.beginPath(); ctx.moveTo(XMARGIN, yy); ctx.lineTo(XMARGIN + w, yy); ctx.stroke();
    }
    drawPath(samplesIn,  'rgba(0,255,0,0.5)',  '#0c0');
    drawPath(samplesOut, 'rgba(255,0,0,0.5)',  '#c00');
  }

  async function sampleRates() {
    try {
      const nt = await rpc('getnettotals', []);
      const bytesIn  = Number(nt && nt.totalbytesrecv) || 0;
      const bytesOut = Number(nt && nt.totalbytessent) || 0;
      const now = (nt && nt.timemillis) || performance.now();
      if (lastTimestamp > 0) {
        const dt = Math.max(1, now - lastTimestamp);
        const inRate  = (bytesIn  - lastBytesIn ) / 1024 * 1000 / dt;
        const outRate = (bytesOut - lastBytesOut) / 1024 * 1000 / dt;
        samplesIn.unshift(Math.max(0, inRate));
        samplesOut.unshift(Math.max(0, outRate));
        while (samplesIn.length  > DESIRED_SAMPLES) samplesIn.pop();
        while (samplesOut.length > DESIRED_SAMPLES) samplesOut.pop();
        fMax = Math.max(0, ...samplesIn, ...samplesOut);
      }
      lastBytesIn = bytesIn;
      lastBytesOut = bytesOut;
      lastTimestamp = now;
      drawGraph();
    } catch (_) { /* tolerate */ }
  }
  function setGraphRange(mins) {
    if (graphTimer) clearInterval(graphTimer);
    samplesIn = []; samplesOut = []; fMax = 0; lastTimestamp = 0;
    drawGraph();
    const interval = Math.max(250, Math.floor(mins * 60 * 1000 / DESIRED_SAMPLES));
    graphTimer = setInterval(sampleRates, interval);
  }
  $('graph-range').addEventListener('change', (e) => setGraphRange(Number(e.target.value) || 5));
  $('graph-clear').addEventListener('click', () => setGraphRange(Number($('graph-range').value) || 5));
  setGraphRange(5);

  // Refresh on load + every 5s while window is open
  refreshInfo();
  refreshNetwork();
  setInterval(() => { refreshInfo(); refreshNetwork(); }, 5000);

  inputEl.focus();
})();
