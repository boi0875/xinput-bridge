// XInput Bridge: page side (runs in the page's own JavaScript world).
//
// Adds bridged controllers to navigator.getGamepads() and fires
// gamepadconnected / gamepaddisconnected for them. The data comes from
// relay.js (the extension's isolated content script) over DOM events.
//
// It stays passive until the page shows interest in gamepads, the same signal
// Chrome uses to start its own gamepad polling: a getGamepads() call or a
// gamepad event listener. Pages that never touch the Gamepad API never open a
// connection to the extension.
(() => {
  'use strict';
  if (window.__xinputBridge) return;
  Object.defineProperty(window, '__xinputBridge', { value: true });

  const TO_RELAY = 'xinput-bridge:to-relay';
  const TO_MAIN = 'xinput-bridge:to-main';
  const PRESS_THRESHOLD = 30 / 255;   // Chrome's own analog-button threshold
  const GESTURE_THRESHOLD = 0.5;
  const MAX_EFFECT_MS = 5000;

  // Grab what we need before page scripts get a chance to replace it.
  const nativeGetGamepads = Navigator.prototype.getGamepads;
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeDispatch = EventTarget.prototype.dispatchEvent;
  const NativeEvent = Event;
  const NativeCustomEvent = CustomEvent;
  const { freeze, setPrototypeOf, defineProperty } = Object;
  const { stringify, parse } = JSON;
  const now = performance.now.bind(performance);
  const setT = setTimeout.bind(window);
  const clearT = clearTimeout.bind(window);
  const proto = name => (typeof window[name] === 'function' ? window[name].prototype : Object.prototype);
  const GamepadProto = proto('Gamepad');
  const ButtonProto = proto('GamepadButton');
  const ActuatorProto = proto('GamepadHapticActuator');
  const GamepadEventProto = typeof GamepadEvent === 'function' ? GamepadEvent.prototype : null;

  /** player index -> { index, id, actuator, buttons, axes, timestamp, snapshot, dirty } */
  const pads = new Map();
  let interested = false;
  let exposed = false;      // Chrome hides gamepads until a button is pressed on the page
  let relayId = null;

  // ---------- link to relay.js ----------

  function post(msg) {
    nativeDispatch.call(window, new NativeCustomEvent(TO_RELAY, { detail: stringify(msg) }));
  }

  function noteInterest() {
    if (interested) return;
    interested = true;
    post({ t: 'interest' });
  }

  nativeAdd.call(window, TO_MAIN, e => {
    let msg;
    try { msg = parse(e.detail); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      // A relay just loaded (or reloaded with the extension); listen to it from now on.
      relayId = msg.r;
      if (interested) post({ t: 'interest' });
      return;
    }
    if (msg.r !== relayId) return;
    if (msg.t === 'pads') syncPads(msg.pads || []);
    else if (msg.t === 's') updatePad(msg.p, msg.b, msg.a);
  });

  // ---------- Gamepad objects ----------
  // Snapshots are fresh frozen objects, never mutated, like Chrome's own.
  // Pages keep the previous snapshot and diff it against the next one;
  // mutating a shared object would hide presses and releases.

  const makeButton = value => {
    const pressed = value > PRESS_THRESHOLD;
    return freeze(setPrototypeOf({ pressed, touched: pressed || value > 0, value }, ButtonProto));
  };
  const BUTTON_UP = makeButton(0);
  const BUTTON_DOWN = makeButton(1);
  const button = v => (v === 0 ? BUTTON_UP : v === 1 ? BUTTON_DOWN : makeButton(v));

  function makeSnapshot(entry, connected = true) {
    return freeze(setPrototypeOf({
      id: entry.id,
      index: entry.index,
      connected,
      mapping: 'standard',
      timestamp: entry.timestamp,
      axes: freeze(entry.axes.slice()),
      buttons: freeze(entry.buttons.map(button)),
      vibrationActuator: entry.actuator,
    }, GamepadProto));
  }

  function snapshotOf(entry) {
    if (entry.dirty || !entry.snapshot) {
      entry.snapshot = makeSnapshot(entry);
      entry.dirty = false;
    }
    return entry.snapshot;
  }

  // ---------- haptics ----------

  function makeActuator(index, effects) {
    if (!effects.length) return null;
    let pending = null;
    const settle = result => {
      if (!pending) return;
      clearT(pending.start);
      clearT(pending.end);
      pending.resolve(result);
      pending = null;
    };
    const num = (v, fallback) => (v === undefined ? fallback : Number(v));
    const actuator = {
      type: 'dual-rumble',
      effects: freeze(effects.slice()),
      playEffect(type, params = {}) {
        if (!effects.includes(type)) {
          return Promise.reject(new DOMException(`Effect type "${type}" is not supported`, 'NotSupportedError'));
        }
        const p = {
          duration: num(params.duration, 0), startDelay: num(params.startDelay, 0),
          strong: num(params.strongMagnitude, 0), weak: num(params.weakMagnitude, 0),
          left: num(params.leftTrigger, 0), right: num(params.rightTrigger, 0),
        };
        const magnitudes = [p.strong, p.weak, p.left, p.right];
        if (!(p.duration >= 0) || !(p.startDelay >= 0) || magnitudes.some(m => !(m >= 0 && m <= 1))) {
          return Promise.reject(new TypeError('Invalid haptic effect parameters'));
        }
        if (type === 'dual-rumble') p.left = p.right = 0;
        settle('preempted');
        if (document.visibilityState === 'hidden') return Promise.resolve('preempted');
        return new Promise(resolve => {
          const job = { resolve, start: 0, end: 0 };
          pending = job;
          const ms = Math.min(p.duration, MAX_EFFECT_MS);
          const delay = Math.min(p.startDelay, MAX_EFFECT_MS - ms);
          job.start = setT(() => {
            post({ t: 'rumble', p: index, strong: p.strong, weak: p.weak, left: p.left, right: p.right, ms });
            job.end = setT(() => { if (pending === job) settle('complete'); }, ms);
          }, delay);
        });
      },
      reset() {
        settle('preempted');
        post({ t: 'rumble', p: index, strong: 0, weak: 0, left: 0, right: 0, ms: 0 });
        return Promise.resolve('complete');
      },
    };
    actuator.stop = () => settle('preempted');
    const pub = setPrototypeOf({
      type: actuator.type, effects: actuator.effects,
      playEffect: actuator.playEffect, reset: actuator.reset,
    }, ActuatorProto);
    return { pub: freeze(pub), stop: actuator.stop };
  }

  // ---------- events ----------

  function fire(type, gamepad) {
    const ev = new NativeEvent(type);
    if (GamepadEventProto) setPrototypeOf(ev, GamepadEventProto);
    defineProperty(ev, 'gamepad', { value: gamepad, enumerable: true });
    // dispatchEvent also runs window.ongamepadconnected; don't call it again.
    nativeDispatch.call(window, ev);
  }

  const hidden = () => document.visibilityState === 'hidden';
  const hasGesture = (b, a) => b.some(v => v > GESTURE_THRESHOLD) || a.some(v => Math.abs(v) > GESTURE_THRESHOLD);

  function expose() {
    if (exposed) return;
    exposed = true;
    post({ t: 'engaged' });
    for (const entry of pads.values()) fire('gamepadconnected', snapshotOf(entry));
  }

  // ---------- slots ----------
  // Pads Chrome drives itself keep the index Chrome gave them, so its own
  // gamepad events stay right. Bridged pads take the lowest free index, and
  // move (disconnect, then reconnect at a free index) if Chrome later puts
  // one of its pads in their slot.

  function nativePads() {
    try { return Array.from(nativeGetGamepads.call(navigator) || []); } catch { return []; }
  }

  function freeIndex(native, self) {
    const taken = new Set();
    native.forEach((g, i) => { if (g) taken.add(i); });
    for (const e of pads.values()) if (e !== self && e.index >= 0) taken.add(e.index);
    let i = 0;
    while (taken.has(i)) i++;
    return i;
  }

  function resolveCollisions(native) {
    for (const entry of pads.values()) {
      if (!native[entry.index]) continue;
      const old = makeSnapshot(entry, false);
      entry.index = freeIndex(native, entry);
      entry.dirty = true;
      if (exposed) {
        const moved = snapshotOf(entry);
        // Not from inside getGamepads(): let the caller finish first.
        queueMicrotask(() => {
          fire('gamepaddisconnected', old);
          fire('gamepadconnected', moved);
        });
      }
    }
  }

  nativeAdd.call(window, 'gamepadconnected', e => { if (e.isTrusted) resolveCollisions(nativePads()); });

  // ---------- state from the extension ----------
  // Pads are keyed by player number (which the controller's LED shows);
  // `index` is their slot in getGamepads().

  function syncPads(list) {
    const next = new Map();
    for (const info of list) if (Number.isInteger(info.p) && info.p >= 0) next.set(info.p, info);
    for (const [p, entry] of pads) {
      const info = next.get(p);
      if (!info || info.id !== entry.id || (info.haptics || []).join() !== entry.haptics) removePad(p);
    }
    for (const [p, info] of next) {
      if (pads.has(p)) updatePad(p, info.b, info.a);
      else addPad(info);
    }
  }

  function addPad(info) {
    const haptics = makeActuator(info.p, info.haptics || []);
    const live = !hidden();
    const entry = {
      player: info.p, index: -1, id: String(info.id), haptics: (info.haptics || []).join(),
      actuator: haptics ? haptics.pub : null, stopHaptics: haptics ? haptics.stop : () => {},
      buttons: live ? info.b.slice() : info.b.map(() => 0),
      axes: live ? info.a.slice() : info.a.map(() => 0),
      timestamp: now(), snapshot: null, dirty: true,
    };
    entry.index = freeIndex(nativePads(), entry);
    pads.set(info.p, entry);
    if (exposed) fire('gamepadconnected', snapshotOf(entry));
    else if (live && hasGesture(entry.buttons, entry.axes)) expose();
  }

  function removePad(p) {
    const entry = pads.get(p);
    if (!entry) return;
    pads.delete(p);
    entry.stopHaptics();
    if (exposed) fire('gamepaddisconnected', makeSnapshot(entry, false));
  }

  function updatePad(p, b, a) {
    const entry = pads.get(p);
    if (!entry || !Array.isArray(b) || !Array.isArray(a)) return;
    if (hidden()) return;   // hidden pages see controllers at rest, like Chrome's own
    entry.buttons = b;
    entry.axes = a;
    entry.timestamp = now();
    entry.dirty = true;
    if (!exposed && hasGesture(b, a)) expose();
  }

  // Hidden pages stop getting updates; don't leave a button held down.
  nativeAdd.call(document, 'visibilitychange', () => {
    if (!hidden()) return;
    for (const entry of pads.values()) {
      entry.stopHaptics();
      if (entry.buttons.some(Boolean) || entry.axes.some(Boolean)) {
        entry.buttons = entry.buttons.map(() => 0);
        entry.axes = entry.axes.map(() => 0);
        entry.timestamp = now();
        entry.dirty = true;
      }
    }
  });

  // ---------- navigator.getGamepads ----------

  const patched = {
    getGamepads() {
      noteInterest();
      const real = nativeGetGamepads.apply(this, arguments);
      if (!exposed || pads.size === 0) return real;
      const out = Array.from(real);
      resolveCollisions(out);
      for (const entry of pads.values()) {
        while (out.length <= entry.index) out.push(null);
        out[entry.index] = snapshotOf(entry);
      }
      return out;
    },
  };
  Navigator.prototype.getGamepads = patched.getGamepads;

  // Interest via event listeners: wrap the prototype method in place, so
  // libraries that wrap it later (zone.js, error trackers) still see every
  // call. A bare addEventListener(...) call arrives with `this` undefined.
  const patchedAdd = {
    addEventListener(type) {
      if ((this == null || this === window) && typeof type === 'string' && type.startsWith('gamepad')) noteInterest();
      return nativeAdd.apply(this, arguments);
    },
  };
  EventTarget.prototype.addEventListener = patchedAdd.addEventListener;
  for (const name of ['ongamepadconnected', 'ongamepaddisconnected']) {
    const d = Object.getOwnPropertyDescriptor(window, name);
    if (!d || !d.set || !d.configurable) continue;
    defineProperty(window, name, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set(value) {
        if (value) noteInterest();
        d.set.call(this, value);
      },
    });
  }

  // Whichever of the two scripts loads second completes the handshake.
  post({ t: 'ping' });
})();
