// USB protocols spoken by Xbox-family controllers, decoded into the W3C
// "standard" gamepad layout. Byte layouts and init sequences follow the Linux
// xpad driver (drivers/input/joystick/xpad.c), which supports the widest range
// of third-party pads.
//
// Pure functions only: no WebUSB or extension APIs here, so it runs under Node
// for the unit tests.

export const Protocol = Object.freeze({
  X360: 'xbox360',            // wired Xbox 360 and most third-party "XInput" pads
  X360W: 'xbox360-wireless',  // Xbox 360 Wireless Receiver, up to 4 pads per dongle
  GIP: 'xbox-one',            // Xbox One / Series wired (Gaming Input Protocol)
});

export const PROTOCOL_LABEL = Object.freeze({
  [Protocol.X360]: 'Xbox 360 (XInput)',
  [Protocol.X360W]: 'Xbox 360 Wireless Receiver',
  [Protocol.GIP]: 'Xbox One / Series (GIP)',
});

// Filters for navigator.usb.requestDevice(). A class filter matches the device
// class or any interface class, so these find pads from any vendor.
export const USB_FILTERS = [
  { classCode: 0xff, subclassCode: 0x5d },  // Xbox 360 family
  { classCode: 0xff, subclassCode: 0x47 },  // Xbox One / Series
];

// W3C standard gamepad button order.
export const B = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9,
  LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, GUIDE: 16,
});
export const BUTTON_COUNT = 17;
export const AXIS_COUNT = 4;
export const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu',
  'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Guide'];

// Chrome's own threshold for reporting an analog button as pressed.
export const PRESS_THRESHOLD = 30 / 255;

export function neutralState() {
  return { buttons: new Array(BUTTON_COUNT).fill(0), axes: new Array(AXIS_COUNT).fill(0) };
}

export function protocolOf(alt) {
  if (alt.interfaceClass !== 0xff) return null;
  if (alt.interfaceSubclass === 0x5d && alt.interfaceProtocol === 0x01) return Protocol.X360;
  if (alt.interfaceSubclass === 0x5d && alt.interfaceProtocol === 0x81) return Protocol.X360W;
  if (alt.interfaceSubclass === 0x47 && alt.interfaceProtocol === 0xd0) return Protocol.GIP;
  return null;
}

// Picks the interfaces that carry controller input out of a USBConfiguration.
// Wired pads also expose headset/audio interfaces with similar class codes;
// those have no interrupt IN endpoint or a different protocol, so they drop out.
export function findPadInterfaces(configuration) {
  if (!configuration) return [];
  const found = [];
  for (const iface of configuration.interfaces) {
    for (const alt of iface.alternates) {
      const protocol = protocolOf(alt);
      if (!protocol) continue;
      const pick = (dir) =>
        alt.endpoints.find(e => e.direction === dir && e.type === 'interrupt') ||
        alt.endpoints.find(e => e.direction === dir && e.type === 'bulk');
      const epIn = pick('in');
      if (!epIn) continue;
      const epOut = pick('out');
      found.push({
        interfaceNumber: iface.interfaceNumber,
        alternateSetting: alt.alternateSetting,
        protocol,
        epIn: epIn.endpointNumber,
        epOut: epOut ? epOut.endpointNumber : null,
      });
      break;
    }
  }
  const wireless = found.filter(f => f.protocol === Protocol.X360W);
  if (wireless.length) return wireless.slice(0, 4);
  return found.slice(0, 1);
}

// ---------- input decoding ----------

const stickAxis = v => (v < 0 ? v / 32768 : v / 32767);
// XInput reports up as positive; the standard mapping wants up = -1.
const stickAxisY = v => -stickAxis(v) || 0;
const bit = (byte, mask) => (byte & mask ? 1 : 0);

// Xbox 360 input report, starting at `off`:
// [0]=0x00 type, [1]=length, [2..3]=buttons, [4]=LT, [5]=RT,
// [6..13]=LX, LY, RX, RY as little-endian int16.
// Every report carries the full state of every control.
export function parseX360Input(view, off = 0) {
  if (view.byteLength < off + 14 || view.getUint8(off) !== 0x00) return null;
  const b0 = view.getUint8(off + 2);
  const b1 = view.getUint8(off + 3);
  const buttons = new Array(BUTTON_COUNT);
  buttons[B.A] = bit(b1, 0x10);
  buttons[B.B] = bit(b1, 0x20);
  buttons[B.X] = bit(b1, 0x40);
  buttons[B.Y] = bit(b1, 0x80);
  buttons[B.LB] = bit(b1, 0x01);
  buttons[B.RB] = bit(b1, 0x02);
  buttons[B.LT] = view.getUint8(off + 4) / 255;
  buttons[B.RT] = view.getUint8(off + 5) / 255;
  buttons[B.BACK] = bit(b0, 0x20);
  buttons[B.START] = bit(b0, 0x10);
  buttons[B.LS] = bit(b0, 0x40);
  buttons[B.RS] = bit(b0, 0x80);
  buttons[B.UP] = bit(b0, 0x01);
  buttons[B.DOWN] = bit(b0, 0x02);
  buttons[B.LEFT] = bit(b0, 0x04);
  buttons[B.RIGHT] = bit(b0, 0x08);
  buttons[B.GUIDE] = bit(b1, 0x04);
  const axes = [
    stickAxis(view.getInt16(off + 6, true)),
    stickAxisY(view.getInt16(off + 8, true)),
    stickAxis(view.getInt16(off + 10, true)),
    stickAxisY(view.getInt16(off + 12, true)),
  ];
  return { buttons, axes };
}

// Xbox One / Series input report (GIP command 0x20):
// [4]=menu/view/A/B/X/Y, [5]=d-pad/bumpers/stick clicks,
// [6..9]=LT, RT as uint16 0..1023, [10..17]=LX, LY, RX, RY as int16.
// The guide button arrives separately in a 0x07 report.
export function parseGipInput(view, guide = 0) {
  if (view.byteLength < 18 || view.getUint8(0) !== 0x20) return null;
  const b4 = view.getUint8(4);
  const b5 = view.getUint8(5);
  const buttons = new Array(BUTTON_COUNT);
  buttons[B.A] = bit(b4, 0x10);
  buttons[B.B] = bit(b4, 0x20);
  buttons[B.X] = bit(b4, 0x40);
  buttons[B.Y] = bit(b4, 0x80);
  buttons[B.LB] = bit(b5, 0x10);
  buttons[B.RB] = bit(b5, 0x20);
  buttons[B.LT] = Math.min(1, view.getUint16(6, true) / 1023);
  buttons[B.RT] = Math.min(1, view.getUint16(8, true) / 1023);
  buttons[B.BACK] = bit(b4, 0x08);
  buttons[B.START] = bit(b4, 0x04);
  buttons[B.LS] = bit(b5, 0x40);
  buttons[B.RS] = bit(b5, 0x80);
  buttons[B.UP] = bit(b5, 0x01);
  buttons[B.DOWN] = bit(b5, 0x02);
  buttons[B.LEFT] = bit(b5, 0x04);
  buttons[B.RIGHT] = bit(b5, 0x08);
  buttons[B.GUIDE] = guide;
  const axes = [
    stickAxis(view.getInt16(10, true)),
    stickAxisY(view.getInt16(12, true)),
    stickAxis(view.getInt16(14, true)),
    stickAxisY(view.getInt16(16, true)),
  ];
  return { buttons, axes };
}

// ---------- drivers ----------
// A driver turns USB packets into { state, present, reply } results and builds
// the packets the host sends (init, player LED, rumble). Rumble magnitudes
// come in as 0..1.

const to8 = v => Math.round(Math.max(0, Math.min(1, v)) * 255);

class X360Driver {
  constructor() {
    this.protocol = Protocol.X360;
    this.hotplug = false;      // the pad is present as soon as the USB device is
    this.haptics = ['dual-rumble'];
  }
  initPackets() { return []; }
  // 0x06..0x09 = LED quadrant 1..4 solid on
  ledPacket(player) { return Uint8Array.of(0x01, 0x03, 0x06 + (player & 3)); }
  rumblePacket({ strong, weak }) {
    return Uint8Array.of(0x00, 0x08, 0x00, to8(strong), to8(weak), 0x00, 0x00, 0x00);
  }
  parse(view) {
    const state = parseX360Input(view, 0);
    return state ? { state } : null;
  }
}

class X360WirelessDriver {
  constructor() {
    this.protocol = Protocol.X360W;
    this.hotplug = true;       // pads come and go while the receiver stays plugged in
    this.haptics = ['dual-rumble'];
  }
  // Ask the receiver whether a pad is already paired on this slot.
  initPackets() { return [Uint8Array.of(0x08, 0x00, 0x0f, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0)]; }
  ledPacket(player) {
    return Uint8Array.of(0x00, 0x00, 0x08, 0x40 + 0x06 + (player & 3), 0, 0, 0, 0, 0, 0, 0, 0);
  }
  rumblePacket({ strong, weak }) {
    return Uint8Array.of(0x00, 0x01, 0x0f, 0xc0, 0x00, to8(strong), to8(weak), 0, 0, 0, 0, 0);
  }
  parse(view) {
    if (view.byteLength < 2) return null;
    const type = view.getUint8(0);
    const sub = view.getUint8(1);
    if (type & 0x08) return { present: (sub & 0x80) !== 0 };
    if (sub !== 0x01) return null;   // battery, serial number and other status reports
    const state = parseX360Input(view, 4);
    return state ? { state } : null;
  }
}

// GIP packet header: [command, options, sequence, payload length].
const GIP = Object.freeze({
  ACK: 0x01, ANNOUNCE: 0x02, IDENTIFY: 0x04, POWER: 0x05, AUTH: 0x06,
  VIRTUAL_KEY: 0x07, RUMBLE: 0x09, LED: 0x0a, INPUT: 0x20,
  OPT_INTERNAL: 0x20, OPT_ACK: 0x10,
});

const GIP_POWER_ON = [GIP.POWER, GIP.OPT_INTERNAL, 0, 0x01, 0x00];
// Xbox One S / Elite 2 after they were last used over Bluetooth.
const GIP_S_INIT = [GIP.POWER, GIP.OPT_INTERNAL, 0, 0x0f, 0x06];
// Some Hori and PDP pads won't send stick data until their identify is acked.
const GIP_HORI_ACK = [GIP.ACK, GIP.OPT_INTERNAL, 0, 0x09, 0x00, GIP.IDENTIFY, GIP.OPT_INTERNAL,
  0x3a, 0x00, 0x00, 0x00, 0x80, 0x00];
// Most PDP pads need these two before they send input at all.
const GIP_PDP_LED = [GIP.LED, GIP.OPT_INTERNAL, 0, 0x03, 0x00, 0x01, 0x14];
const GIP_PDP_AUTH = [GIP.AUTH, GIP.OPT_INTERNAL, 0, 0x02, 0x01, 0x00];
// Some PowerA pads need a short rumble to start reporting. The second packet
// stops it before the motors spin up.
const GIP_RUMBLE_BEGIN = [GIP.RUMBLE, 0x00, 0, 0x09, 0x00, 0x0f, 0x00, 0x00, 0x1d, 0x1d, 0xff, 0x00, 0x00];
const GIP_RUMBLE_END = [GIP.RUMBLE, 0x00, 0, 0x09, 0x00, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

// [vendorId, productId, packet]; 0 matches any. Sent in this order.
export const GIP_INIT_TABLE = [
  [0x0e6f, 0x0165, GIP_HORI_ACK],
  [0x0f0d, 0x0067, GIP_HORI_ACK],
  [0, 0, GIP_POWER_ON],
  [0x045e, 0x02ea, GIP_S_INIT],
  [0x045e, 0x0b00, GIP_S_INIT],
  [0x0e6f, 0, GIP_PDP_LED],
  [0x20d6, 0xa01a, GIP_PDP_LED],
  [0x0e6f, 0, GIP_PDP_AUTH],
  [0x20d6, 0xa01a, GIP_PDP_AUTH],
  [0x24c6, 0x541a, GIP_RUMBLE_BEGIN],
  [0x24c6, 0x542a, GIP_RUMBLE_BEGIN],
  [0x24c6, 0x543a, GIP_RUMBLE_BEGIN],
  [0x24c6, 0x541a, GIP_RUMBLE_END],
  [0x24c6, 0x542a, GIP_RUMBLE_END],
  [0x24c6, 0x543a, GIP_RUMBLE_END],
];

class GipDriver {
  constructor({ vendorId = 0, productId = 0 } = {}) {
    this.protocol = Protocol.GIP;
    this.hotplug = false;
    this.haptics = ['dual-rumble', 'trigger-rumble'];
    this.vendorId = vendorId;
    this.productId = productId;
    this.seq = 1;
    this.guide = 0;
    this.last = null;
  }
  nextSeq() {
    const s = this.seq;
    this.seq = (this.seq + 1) & 0xff || 1;
    return s;
  }
  initPackets() {
    return GIP_INIT_TABLE
      .filter(([v, p]) => (!v || v === this.vendorId) && (!p || p === this.productId))
      .map(([, , pkt]) => {
        const out = Uint8Array.from(pkt);
        out[2] = this.nextSeq();
        return out;
      });
  }
  ledPacket() { return null; }
  rumblePacket({ strong = 0, weak = 0, left = 0, right = 0 }) {
    // GIP motor magnitudes run 0..100.
    const pct = v => Math.round(Math.max(0, Math.min(1, v)) * 100);
    return Uint8Array.of(GIP.RUMBLE, 0x00, this.nextSeq(), 0x09, 0x00, 0x0f,
      pct(left), pct(right), pct(strong), pct(weak), 0xff, 0x00, 0xff);
  }
  parse(view) {
    if (view.byteLength < 4) return null;
    const cmd = view.getUint8(0);
    if (cmd === GIP.INPUT) {
      const state = parseGipInput(view, this.guide);
      if (state) this.last = state;
      return state ? { state } : null;
    }
    if (cmd === GIP.VIRTUAL_KEY && view.byteLength >= 5) {
      this.guide = view.getUint8(4) & 0x03 ? 1 : 0;
      const base = this.last || neutralState();
      const state = { buttons: base.buttons.slice(), axes: base.axes.slice() };
      state.buttons[B.GUIDE] = this.guide;
      this.last = state;
      const result = { state };
      // The pad keeps resending the guide report until it is acked.
      if (view.getUint8(1) === (GIP.OPT_ACK | GIP.OPT_INTERNAL)) {
        result.reply = [Uint8Array.of(GIP.ACK, GIP.OPT_INTERNAL, view.getUint8(2), 0x09,
          0x00, GIP.VIRTUAL_KEY, GIP.OPT_INTERNAL, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00)];
      }
      return result;
    }
    // A pad announces itself after a power cycle; it needs the init packets again.
    if (cmd === GIP.ANNOUNCE) return { reply: this.initPackets() };
    return null;
  }
}

export function createDriver(protocol, ids = {}) {
  switch (protocol) {
    case Protocol.X360: return new X360Driver();
    case Protocol.X360W: return new X360WirelessDriver();
    case Protocol.GIP: return new GipDriver(ids);
    default: throw new Error('Unknown protocol: ' + protocol);
  }
}

// ---------- shaping ----------

const clamp1 = v => Math.max(-1, Math.min(1, v));

// Radial deadzone: zero inside the circle, then rescaled so motion starts
// smoothly at its edge. Per-axis deadzones snap diagonals to the axes.
export function applyStickDeadzone(x, y, deadzone) {
  if (!(deadzone > 0)) return [x, y];
  const m = Math.hypot(x, y);
  if (m <= deadzone) return [0, 0];
  const k = (m - deadzone) / (1 - deadzone) / m;
  return [clamp1(x * k), clamp1(y * k)];
}

const round4 = v => Math.round(v * 1e4) / 1e4 || 0;

export function shapeState(raw, { deadzone = 0 } = {}) {
  const [lx, ly] = applyStickDeadzone(raw.axes[0], raw.axes[1], deadzone);
  const [rx, ry] = applyStickDeadzone(raw.axes[2], raw.axes[3], deadzone);
  return {
    buttons: raw.buttons.map(round4),
    axes: [lx, ly, rx, ry].map(round4),
  };
}

export function sameState(a, b) {
  if (!a || !b) return false;
  for (let i = 0; i < a.buttons.length; i++) if (a.buttons[i] !== b.buttons[i]) return false;
  for (let i = 0; i < a.axes.length; i++) if (a.axes[i] !== b.axes[i]) return false;
  return true;
}

// The Gamepad.id string Chrome on macOS reports for a genuine Microsoft pad.
// Sites pick button glyphs and layouts from it, so by default bridged pads
// identify as one.
export function gamepadId(protocol, { identity = 'xbox', name = '', vendorId = 0, productId = 0 } = {}) {
  const hex = n => n.toString(16).padStart(4, '0');
  if (identity === 'device') {
    return `${name || 'USB Controller'} (STANDARD GAMEPAD Vendor: ${hex(vendorId)} Product: ${hex(productId)})`;
  }
  return protocol === Protocol.GIP
    ? 'Xbox One Controller (STANDARD GAMEPAD Vendor: 045e Product: 02dd)'
    : 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)';
}

export const hexBytes = view =>
  Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    b => b.toString(16).padStart(2, '0')).join(' ');
