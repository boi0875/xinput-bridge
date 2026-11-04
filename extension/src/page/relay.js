// XInput Bridge: relay (the extension's isolated content script).
//
// Carries controller state from the service worker to main-world.js, and
// rumble requests back. It connects only once main-world.js reports that the
// page uses the Gamepad API, only while the site isn't turned off, and only
// while the page is visible or has had a button press (a game in use).
(() => {
  'use strict';
  const TO_RELAY = 'xinput-bridge:to-relay';
  const TO_MAIN = 'xinput-bridge:to-main';
  const LOST_GRACE_MS = 2000;
  // Same defaults as src/settings.js.
  const DEFAULTS = { toasts: true, disabledSites: [] };

  const relayId = Math.random().toString(36).slice(2);
  const isTop = window === window.top;
  const site = topHostname();
  let settings = null;
  let interested = false;
  let engaged = false;
  let port = null;
  let retry = 0;
  let retryTimer = 0;
  let lostTimer = 0;
  let padCount = 0;

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const visible = () => document.visibilityState === 'visible';
  const enabled = () => !!settings && !settings.disabledSites.includes(site);

  function toMain(msg) {
    msg.r = relayId;
    window.dispatchEvent(new CustomEvent(TO_MAIN, { detail: JSON.stringify(msg) }));
  }

  window.addEventListener(TO_RELAY, e => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ping') {
      toMain({ t: 'hello' });
    } else if (msg.t === 'interest') {
      interested = true;
      connect();
    } else if (msg.t === 'engaged') {
      engaged = true;
      port?.postMessage({ t: 'engaged' });
    } else if (msg.t === 'rumble' && port) {
      const n = v => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
      port.postMessage({
        t: 'rumble', p: msg.p | 0, strong: n(msg.strong), weak: n(msg.weak),
        left: n(msg.left), right: n(msg.right), ms: Math.max(0, Math.min(5000, Number(msg.ms) || 0)),
      });
    }
  });

  function connect() {
    if (port || !interested || !enabled() || !(visible() || engaged)) return;
    if (!alive()) return giveUp();
    clearTimeout(retryTimer);
    try {
      port = chrome.runtime.connect({ name: 'page' });
    } catch {
      return giveUp();
    }
    port.onMessage.addListener(onWorkerMessage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      if (!alive()) return giveUp();
      // The worker restarted or the extension is reloading. Reconnect, and only
      // drop the pads if that takes too long, so a quick restart goes unnoticed.
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => setPads([]), LOST_GRACE_MS);
      // A background tab that isn't a game in use waits until it's shown
      // again, so it doesn't keep waking the worker.
      if (visible() || engaged) retryTimer = setTimeout(connect, Math.min(250 * 2 ** retry++, 10_000));
    });
    port.postMessage({ t: 'hello', visible: visible(), engaged, top: isTop });
  }

  function disconnect() {
    clearTimeout(retryTimer);
    clearTimeout(lostTimer);
    if (port) {
      port.disconnect();
      port = null;
    }
    setPads([]);
  }

  function giveUp() {
    clearTimeout(retryTimer);
    clearTimeout(lostTimer);
    port = null;
    setPads([]);
  }

  function setPads(pads) {
    padCount = pads.length;
    toMain({ t: 'pads', pads });
  }

  function onWorkerMessage(msg) {
    if (msg.t === 'pads') {
      retry = 0;
      clearTimeout(lostTimer);
      setPads(msg.pads);
      if (msg.change && settings?.toasts) toast(msg.change);
    } else if (msg.t === 's') {
      toMain(msg);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (port) port.postMessage({ t: 'vis', v: visible() });
    else connect();
  });

  // ---------- settings ----------

  function applySettings(next) {
    const wasEnabled = enabled();
    settings = next;
    if (enabled()) connect();
    else if (wasEnabled) disconnect();
  }

  if (alive()) {
    chrome.storage.sync.get(DEFAULTS).then(s => applySettings({ ...DEFAULTS, ...s }));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !settings) return;
      const next = { ...settings };
      for (const key of Object.keys(DEFAULTS)) {
        if (key in changes) next[key] = changes[key].newValue ?? DEFAULTS[key];
      }
      applySettings(next);
    });
    // The popup asks the top frame whether the bridge is running on this tab.
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!isTop || msg?.t !== 'status') return;
      reply({ site, enabled: enabled(), active: !!port, pads: padCount });
    });
  }

  function topHostname() {
    try {
      const origins = location.ancestorOrigins;
      const url = origins && origins.length ? origins[origins.length - 1] : location.href;
      return new URL(url).hostname || 'local files';
    } catch {
      return location.hostname || 'local files';
    }
  }

  // ---------- on-page notice ----------
  // A popover sits in the top layer, so it shows over fullscreen players too.

  function toast(change) {
    const joined = !!change.joined;
    const { p, name } = change.joined || change.left;
    const host = document.createElement('xinput-bridge-notice');
    const supportsPopover = typeof host.showPopover === 'function';
    if (supportsPopover) host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;inset-inline-end:auto;inset-block-start:auto;' +
      'margin:0;padding:0;border:0;background:transparent;overflow:visible;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .n { display:flex; align-items:center; gap:12px; padding:12px 16px 12px 12px;
             background:#171a1d; color:#e9ebee; border:1px solid rgba(233,235,238,.09); border-radius:12px;
             font:400 13px/20px system-ui,-apple-system,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased;
             box-shadow:0 8px 24px rgba(0,0,0,.32);
             transition:opacity 300ms cubic-bezier(.22,1,.36,1), transform 300ms cubic-bezier(.22,1,.36,1); }
        .n.out { opacity:0; transform:translateY(8px); }
        .dot { width:8px; height:8px; border-radius:50%; flex:none; }
        .on { background:#3ecf7a; } .off { background:#6b737c; }
        b { font-weight:500; }
        .sub { color:#98a0a9; }
      </style>
      <div class="n out"><span class="dot"></span><span><b></b><span class="sub"></span></span></div>`;
    const box = root.querySelector('.n');
    root.querySelector('.dot').classList.add(joined ? 'on' : 'off');
    root.querySelector('b').textContent = `Player ${p + 1} ${joined ? 'connected' : 'disconnected'}`;
    root.querySelector('.sub').textContent = ` \u00b7 ${name}`;
    (document.body || document.documentElement).appendChild(host);
    if (supportsPopover) { try { host.showPopover(); } catch { /* not connected yet */ } }
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove('out')));
    setTimeout(() => {
      box.classList.add('out');
      setTimeout(() => host.remove(), 400);
    }, 2600);
  }

  toMain({ t: 'hello' });
})();
