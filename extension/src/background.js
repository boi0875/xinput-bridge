// XInput Bridge service worker.
//
// It owns the USB connection to every paired controller and streams their
// state to the pages that use the Gamepad API. Because the USB permission
// belongs to the extension, not to a site, a controller paired once works on
// every site, in iframes too, and several tabs can share it.
//
//   USB pad --WebUSB--> this worker --port--> relay.js --DOM event--> main-world.js --> navigator.getGamepads()

import {
  PROTOCOL_LABEL, createDriver, findPadInterfaces, gamepadId, hexBytes,
  neutralState, sameState, shapeState,
} from './protocols.js';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged } from './settings.js';

const MAX_PLAYERS = 4;
const READS_IN_FLIGHT = 3;       // keep reads queued so a report never waits for one
const IDLE_CLOSE_MS = 30_000;    // release controllers this long after the last page lets go
const MAX_EFFECT_MS = 5_000;     // Chrome's cap on a single haptic effect
const usb = globalThis.navigator?.usb ?? null;

let settings = { ...DEFAULT_SETTINGS };
const ready = loadSettings().then(s => { settings = s; });

/** @type {Map<USBDevice, Device>} */
const devices = new Map();
/** @type {(Pad|null)[]} */
const players = new Array(MAX_PLAYERS).fill(null);
/** @type {Set<Client>} */
const clients = new Set();
let deviceSeq = 0;

class Device {
  constructor(usbDevice, retries) {
    this.usb = usbDevice;
    this.key = ++deviceSeq;
    this.status = 'opening';   // opening | open | error | unsupported
    this.error = null;
    this.closed = false;
    this.retries = retries;
    /** @type {Pad[]} */
    this.pads = [];
  }
  get name() {
    const d = this.usb;
    return d.productName || `USB device ${hex4(d.vendorId)}:${hex4(d.productId)}`;
  }
}

class Pad {
  constructor(device, iface, slot) {
    this.device = device;
    this.iface = iface;
    this.slot = slot;           // which pad on a multi-pad receiver
    this.driver = createDriver(iface.protocol, device.usb);
    this.present = false;
    this.player = -1;
    this.raw = null;            // decoded state before deadzone
    this.state = null;          // what pages see
    this.outChain = Promise.resolve();
    this.rumble = { wanted: null, sending: false, last: null, timer: 0, owner: null };
  }
  get name() {
    return this.device.pads.length > 1 ? `${this.device.name} #${this.slot + 1}` : this.device.name;
  }
  get haptics() {
    return settings.rumble && this.iface.epOut != null ? this.driver.haptics : [];
  }
  info() {
    const d = this.device.usb;
    return {
      p: this.player,
      id: gamepadId(this.iface.protocol, {
        identity: settings.identity, name: this.name, vendorId: d.vendorId, productId: d.productId,
      }),
      name: this.name,
      protocol: this.iface.protocol,
      haptics: this.haptics,
      b: this.state.buttons,
      a: this.state.axes,
    };
  }
}

// ---------- USB ----------

async function scan() {
  if (!usb) return;
  for (const d of await usb.getDevices()) await attach(d);
}

// usb.close() calls still in flight; open() fails if it races one.
const closing = new WeakMap();

async function attach(usbDevice, retries = 0) {
  if (devices.has(usbDevice)) return;
  const dev = new Device(usbDevice, retries);
  devices.set(usbDevice, dev);

  const preview = findPadInterfaces(usbDevice.configuration ?? usbDevice.configurations?.[0]);
  if (!preview.length) {
    dev.status = 'unsupported';
    dev.error = 'Not an Xbox-protocol controller. Gamepads that use standard HID already work in Chrome without this extension.';
    publishDevices();
    return;
  }
  publishDevices();

  try {
    await closing.get(usbDevice);
    // Each await below can overlap an unplug or an idle close; bail out if so.
    const step = async op => {
      if (dev.closed) throw new Error('closed');
      await op();
      if (dev.closed) throw new Error('closed');
    };
    if (!usbDevice.opened) await step(() => usbDevice.open());
    if (!usbDevice.configuration) await step(() => usbDevice.selectConfiguration(1));
    const ifaces = findPadInterfaces(usbDevice.configuration);
    for (const [slot, iface] of ifaces.entries()) {
      await step(() => usbDevice.claimInterface(iface.interfaceNumber));
      if (iface.alternateSetting) {
        await step(() => usbDevice.selectAlternateInterface(iface.interfaceNumber, iface.alternateSetting));
      }
      dev.pads.push(new Pad(dev, iface, slot));
    }
    dev.status = 'open';
    dev.error = null;
    for (const pad of dev.pads) startPad(pad);
    console.info('[XInput Bridge] opened', dev.name, ifaces.map(i => i.protocol));
  } catch (e) {
    if (dev.closed) {
      // Lost a race with close: make sure the handle we just opened goes too,
      // unless a newer attach already owns it.
      const owner = devices.get(usbDevice);
      if ((!owner || owner === dev) && usbDevice.opened) {
        closing.set(usbDevice, usbDevice.close().catch(() => {}));
      }
      return;
    }
    fail(dev, e, 'open');
  }
  publishDevices();
}

function startPad(pad) {
  for (let i = 0; i < READS_IN_FLIGHT; i++) readLoop(pad);
  for (const pkt of pad.driver.initPackets()) send(pad, pkt);
  if (!pad.driver.hotplug) setPresent(pad, true);
}

async function readLoop(pad) {
  const dev = pad.device;
  while (!dev.closed) {
    let result;
    try {
      result = await dev.usb.transferIn(pad.iface.epIn, 64);
    } catch (e) {
      fail(dev, e, 'read');
      return;
    }
    if (dev.closed) return;
    if (result.status === 'stall') {
      try { await dev.usb.clearHalt('in', pad.iface.epIn); } catch (e) { fail(dev, e, 'read'); return; }
      continue;
    }
    if (result.data?.byteLength) onPacket(pad, result.data);
  }
}

function onPacket(pad, view) {
  if (rawWatchers()) broadcast(c => c.raw, { t: 'raw', key: pad.device.key, slot: pad.slot, hex: hexBytes(view) });
  const res = pad.driver.parse(view);
  if (!res) return;
  for (const pkt of res.reply ?? []) send(pad, pkt);
  if (res.present !== undefined) setPresent(pad, res.present);
  if (res.state) {
    if (!pad.present) setPresent(pad, true);
    updateState(pad, res.state);
  }
}

function send(pad, bytes) {
  if (pad.iface.epOut == null || !bytes) return Promise.resolve();
  const dev = pad.device;
  pad.outChain = pad.outChain
    .then(() => (dev.closed ? null : dev.usb.transferOut(pad.iface.epOut, bytes)))
    .catch(e => { if (!dev.closed) console.warn('[XInput Bridge] write failed', e); });
  return pad.outChain;
}

function fail(dev, error, stage) {
  if (dev.closed || !devices.has(dev.usb)) return;
  console.warn(`[XInput Bridge] ${dev.name}: ${stage} failed`, error);
  dev.status = 'error';
  dev.error = describeError(error, stage);
  closeDevice(dev);
  publishDevices();
  // Transient errors (a hiccup while the pad wakes, a stall we couldn't clear)
  // usually clear up on a fresh open. Unplugging removes the device instead.
  if (stage === 'read' && dev.retries < 3 && clients.size) {
    setTimeout(() => {
      if (devices.get(dev.usb) !== dev || !clients.size) return;
      devices.delete(dev.usb);
      attach(dev.usb, dev.retries + 1);
    }, 1000 * (dev.retries + 1));
  }
}

function describeError(error, stage) {
  const msg = String(error?.message || error);
  if (/claim/i.test(msg)) {
    return 'Another tab, extension or app is using this controller. Close it (for example an older controller extension, or a page that talks to it over WebUSB) and click Retry.';
  }
  if (/access denied/i.test(msg) || error?.name === 'SecurityError') {
    return 'Chrome was denied access. macOS, another app or another browser may be holding the device. Unplug it, plug it back in and click Retry.';
  }
  if (stage === 'read') return `The controller stopped responding (${msg}).`;
  return msg;
}

function closeDevice(dev) {
  if (dev.closed) return;
  dev.closed = true;
  for (const pad of dev.pads) setPresent(pad, false);
  if (!dev.usb.opened) return;
  const p = dev.usb.close().catch(() => {});
  closing.set(dev.usb, p);
}

function closeAll() {
  for (const dev of devices.values()) closeDevice(dev);
  devices.clear();
  publishDevices();
}

if (usb) {
  usb.addEventListener('connect', e => { if (clients.size) attach(e.device); });
  usb.addEventListener('disconnect', e => {
    const dev = devices.get(e.device);
    if (!dev) return;
    closeDevice(dev);
    devices.delete(e.device);
    publishDevices();
  });
}

// ---------- players and state ----------

function setPresent(pad, present) {
  if (present === pad.present) return;
  pad.present = present;
  if (present) {
    const p = players.indexOf(null);
    if (p < 0) {
      console.warn('[XInput Bridge] all player slots are taken; ignoring', pad.name);
      pad.present = false;
      return;
    }
    players[p] = pad;
    pad.player = p;
    pad.raw = neutralState();
    pad.state = shapeState(pad.raw, settings);
    send(pad, pad.driver.ledPacket(p));
    publishPads({ joined: { p, name: pad.name } });
  } else {
    stopRumble(pad);
    const p = pad.player;
    if (p >= 0) players[p] = null;
    pad.player = -1;
    pad.raw = pad.state = null;
    if (p >= 0) publishPads({ left: { p, name: pad.name } });
  }
}

function updateState(pad, raw) {
  pad.raw = raw;
  const state = shapeState(raw, settings);
  if (sameState(state, pad.state)) return;
  pad.state = state;
  const msg = { t: 's', p: pad.player, b: state.buttons, a: state.axes };
  broadcast(c => c.kind !== 'page' || c.visible, msg);
}

function reshapeAll() {
  for (const pad of players) if (pad?.raw) updateState(pad, pad.raw);
}

// ---------- rumble ----------

function rumble(pad, m, ms, owner) {
  const r = pad.rumble;
  clearTimeout(r.timer);
  const k = settings.rumbleStrength;
  const scaled = {
    strong: clamp01(m.strong) * k, weak: clamp01(m.weak) * k,
    left: clamp01(m.left) * k, right: clamp01(m.right) * k,
  };
  r.owner = owner;
  queueRumble(pad, scaled);
  const live = scaled.strong || scaled.weak || scaled.left || scaled.right;
  if (live) r.timer = setTimeout(() => stopRumble(pad), Math.min(Math.max(0, ms), MAX_EFFECT_MS));
}

function stopRumble(pad) {
  const r = pad.rumble;
  clearTimeout(r.timer);
  r.owner = null;
  if (r.last && (r.last.strong || r.last.weak || r.last.left || r.last.right)) {
    queueRumble(pad, { strong: 0, weak: 0, left: 0, right: 0 });
  }
}

// Games may call playEffect every frame. Only the newest request matters, so
// requests that arrive while a write is in flight replace each other.
function queueRumble(pad, m) {
  const r = pad.rumble;
  r.wanted = m;
  if (r.sending) return;
  r.sending = true;
  (async () => {
    while (r.wanted) {
      const want = r.wanted;
      r.wanted = null;
      if (r.last && sameMotors(r.last, want)) continue;
      r.last = want;
      await send(pad, pad.driver.rumblePacket(want));
    }
    r.sending = false;
  })();
}

const sameMotors = (a, b) => a.strong === b.strong && a.weak === b.weak && a.left === b.left && a.right === b.right;
const clamp01 = v => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

// ---------- clients (pages, popup, dashboard) ----------

class Client {
  constructor(port) {
    this.port = port;
    this.kind = port.name;      // page | popup | dashboard
    this.visible = port.name !== 'page';
    this.top = true;
    this.raw = false;
    this.tabId = port.sender?.tab?.id ?? -1;
    this.frameId = port.sender?.frameId ?? 0;
  }
  post(msg) {
    try { this.port.postMessage(msg); } catch { /* port closed underneath us */ }
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (!['page', 'popup', 'dashboard'].includes(port.name)) return;
  const client = new Client(port);
  clients.add(client);
  port.onMessage.addListener(msg => onClientMessage(client, msg));
  port.onDisconnect.addListener(() => {
    clients.delete(client);
    for (const pad of players) if (pad?.rumble.owner === client) stopRumble(pad);
    clientsChanged();
  });
  clientsChanged();
  ready.then(scan).catch(e => console.warn('[XInput Bridge] scan failed', e)).finally(() => {
    client.post(padsMessage());
    if (client.kind !== 'page') {
      client.post(devicesMessage());
      if (!usb) client.post({ t: 'nousb' });
    }
  });
});

// Pages (through relay.js) may only report visibility and ask for rumble;
// device management is for the extension's own pages.
const PAGE_MESSAGES = new Set(['hello', 'vis', 'rumble']);

function onClientMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (client.kind === 'page' && !PAGE_MESSAGES.has(msg.t)) return;
  switch (msg.t) {
    case 'hello':
      client.visible = !!msg.visible;
      client.top = !!msg.top;
      break;
    case 'vis': {
      const was = client.visible;
      client.visible = !!msg.v;
      if (client.visible && !was) client.post(padsMessage());
      break;
    }
    case 'rumble': {
      const pad = players[msg.p | 0];
      if (!pad || !pad.haptics.length) return;
      if (client.kind === 'page' && !client.visible) return;
      rumble(pad, msg, Number(msg.ms) || 0, client);
      break;
    }
    case 'raw':
      if (client.kind === 'dashboard') client.raw = !!msg.on;
      break;
    case 'scan':
      scan().catch(() => {});
      break;
    case 'retry': {
      const dev = findDevice(msg.key);
      if (!dev) return;
      closeDevice(dev);
      devices.delete(dev.usb);
      attach(dev.usb);
      break;
    }
    case 'forget': {
      const dev = findDevice(msg.key);
      if (!dev) return;
      closeDevice(dev);
      devices.delete(dev.usb);
      publishDevices();
      dev.usb.forget?.().catch(() => {});
      break;
    }
    case 'test-rumble': {
      const pad = players[msg.p | 0];
      if (pad && pad.iface.epOut != null) {
        rumble(pad, { strong: 0.8, weak: 0.5, left: 0, right: 0 }, 400, client);
      }
      break;
    }
  }
}

const findDevice = key => [...devices.values()].find(d => d.key === key);
const rawWatchers = () => [...clients].some(c => c.raw);

function broadcast(filter, msg) {
  for (const c of clients) if (filter(c)) c.post(msg);
}

function padsMessage(change) {
  return { t: 'pads', pads: players.filter(Boolean).map(p => p.info()), change };
}

// Topology goes to every client. A connect/disconnect notice goes to one
// visible frame per tab (the top-most one using the Gamepad API).
function publishPads(change) {
  updateBadge();
  const toastFrame = new Map();
  if (change) {
    for (const c of clients) {
      if (c.kind !== 'page' || !c.visible) continue;
      const best = toastFrame.get(c.tabId);
      if (!best || c.frameId < best.frameId) toastFrame.set(c.tabId, c);
    }
  }
  const toastTargets = new Set(toastFrame.values());
  const plain = padsMessage();
  const withChange = change ? padsMessage(change) : plain;
  for (const c of clients) {
    c.post(c.kind !== 'page' || toastTargets.has(c) ? withChange : plain);
  }
  publishDevices();
}

function devicesMessage() {
  return {
    t: 'devices',
    devices: [...devices.values()].map(d => ({
      key: d.key,
      name: d.name,
      manufacturer: d.usb.manufacturerName || '',
      vid: d.usb.vendorId,
      pid: d.usb.productId,
      status: d.status,
      error: d.error,
      pads: d.pads.map(p => ({
        slot: p.slot, protocol: p.iface.protocol, label: PROTOCOL_LABEL[p.iface.protocol],
        present: p.present, player: p.player,
      })),
    })),
  };
}

function publishDevices() {
  broadcast(c => c.kind !== 'page', devicesMessage());
}

function updateBadge() {
  const n = players.filter(Boolean).length;
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2f9e5b' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
}

// ---------- lifetime ----------
// An open USB device keeps this worker alive (Chrome 118+). While a page is
// connected but no controller is plugged in, an API call every 20 s does the
// same, so a controller plugged in mid-session is picked up right away.

let keepAlive = 0;
let idleTimer = 0;

function clientsChanged() {
  clearTimeout(idleTimer);
  if (clients.size === 0) idleTimer = setTimeout(closeAll, IDLE_CLOSE_MS);
  if (clients.size && !keepAlive) {
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  } else if (!clients.size && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = 0;
  }
}

onSettingsChanged(patch => {
  const prev = settings;
  settings = { ...settings, ...patch };
  if ('deadzone' in patch && patch.deadzone !== prev.deadzone) reshapeAll();
  if (('identity' in patch && patch.identity !== prev.identity) || ('rumble' in patch && patch.rumble !== prev.rumble)) {
    if (!settings.rumble) for (const pad of players) if (pad) stopRumble(pad);
    publishPads();
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  updateBadge();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/dashboard.html#welcome') });
});

const hex4 = n => n.toString(16).padStart(4, '0');

// For poking at from the service worker console, and for the end-to-end tests.
globalThis.xinputBridge = { attach, devices, players, clients, get settings() { return settings; } };
