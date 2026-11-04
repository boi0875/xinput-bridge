// Loads the unpacked extension into Chromium and plugs simulated USB
// controllers into its service worker, so the whole path (USB packets ->
// worker -> content scripts -> navigator.getGamepads) runs for real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const EXTENSION = fileURLToPath(new URL('../../extension', import.meta.url));

export async function launch() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'xinput-bridge-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Extensions need full Chromium; Playwright's default headless shell can't load them.
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(FAKE_USB);
  return {
    context,
    worker,
    extensionId,
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

// Serves fixed HTML for a fake https origin.
export async function serve(context, origin, html) {
  await context.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
}

export async function waitFor(fn, { timeout = 5000, interval = 25, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message}; last value: ${JSON.stringify(last)}`);
}

// A page that records what the Gamepad API shows it.
export const GAME_PAGE = `<!doctype html><title>game</title><script>
  window.events = [];
  addEventListener('gamepadconnected', e => events.push(['connected', e.gamepad.index, e.gamepad.id, e instanceof GamepadEvent]));
  addEventListener('gamepaddisconnected', e => events.push(['disconnected', e.gamepad.index, e.gamepad.connected]));
  window.ongamepadconnected = e => events.push(['onconnected', e.gamepad.index]);
  window.snap = () => Array.from(navigator.getGamepads(), g => g && {
    index: g.index, id: g.id, mapping: g.mapping, connected: g.connected,
    isGamepad: g instanceof Gamepad, buttons: g.buttons.map(b => b.value),
    pressed: g.buttons.map(b => b.pressed), axes: Array.from(g.axes),
    effects: g.vibrationActuator ? Array.from(g.vibrationActuator.effects) : null,
  });
</script><p>game</p>`;

// Runs inside the service worker. Defines FakeUSBDevice and a registry.
const FAKE_USB = `(() => {
  class FakeUSBDevice {
    constructor({ vendorId, productId, productName, manufacturerName = 'Test', interfaces }) {
      Object.assign(this, { vendorId, productId, productName, manufacturerName });
      this.opened = false;
      this.gone = false;
      this.configuration = null;
      this.configurations = [{ configurationValue: 1, interfaces }];
      this.claimed = new Set();
      this.queues = new Map();     // endpoint -> pending reports
      this.waiters = new Map();    // endpoint -> pending transferIn calls
      this.out = [];               // [endpoint, bytes] written by the bridge
      this.control = [];           // control transfers the bridge made
    }
    async open() { if (this.gone) throw new DOMException('Device unavailable', 'NotFoundError'); this.opened = true; }
    async close() { this.opened = false; this.claimed.clear(); this.flush(new DOMException('Device closed', 'InvalidStateError')); }
    async selectConfiguration() { this.configuration = this.configurations[0]; }
    async claimInterface(n) { if (!this.opened) throw new DOMException('closed', 'InvalidStateError'); this.claimed.add(n); }
    async selectAlternateInterface() {}
    async clearHalt() {}
    async controlTransferIn(setup, length) {
      this.control.push(setup);
      return { status: 'ok', data: new DataView(new ArrayBuffer(length)) };
    }
    async forget() { this.gone = true; }
    transferIn(ep) {
      const q = this.queues.get(ep);
      if (q && q.length) return Promise.resolve(q.shift());
      return new Promise((resolve, reject) => {
        if (!this.waiters.has(ep)) this.waiters.set(ep, []);
        this.waiters.get(ep).push({ resolve, reject });
      });
    }
    async transferOut(ep, data) {
      this.out.push([ep, Array.from(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength))]);
      return { status: 'ok', bytesWritten: data.byteLength };
    }
    push(ep, bytes) {
      const result = { status: 'ok', data: new DataView(Uint8Array.from(bytes).buffer) };
      const w = this.waiters.get(ep);
      if (w && w.length) w.shift().resolve(result);
      else { if (!this.queues.has(ep)) this.queues.set(ep, []); this.queues.get(ep).push(result); }
    }
    flush(error) {
      for (const list of this.waiters.values()) for (const w of list.splice(0)) w.reject(error);
    }
    unplug() { this.gone = true; this.flush(new DOMException('The device was disconnected.', 'NetworkError')); }
  }

  const ep = (endpointNumber, direction, type = 'interrupt') => ({ endpointNumber, direction, type, packetSize: 32 });
  const alt = (sub, proto, endpoints, alternateSetting = 0) => ({ alternateSetting, interfaceClass: 0xff, interfaceSubclass: sub, interfaceProtocol: proto, endpoints });

  globalThis.fakes = {};
  globalThis.makeFake = (kind, name) => {
    let opts;
    if (kind === 'x360') opts = { vendorId: 0x20d6, productId: 0x2035, productName: name || 'Test 360 Pad', interfaces: [
      { interfaceNumber: 0, alternates: [alt(0x5d, 0x01, [ep(1, 'in'), ep(2, 'out')])] },
      { interfaceNumber: 1, alternates: [alt(0x5d, 0x03, [ep(3, 'in'), ep(4, 'out')])] },
    ] };
    if (kind === 'gip') opts = { vendorId: 0x24c6, productId: 0x543a, productName: name || 'Test GIP Pad', interfaces: [
      { interfaceNumber: 0, alternates: [alt(0x47, 0xd0, [ep(2, 'out'), ep(2, 'in')])] },
      { interfaceNumber: 1, alternates: [alt(0x47, 0xd0, []), alt(0x47, 0xd0, [ep(3, 'in', 'isochronous')], 1)] },
    ] };
    if (kind === 'x360w') opts = { vendorId: 0x045e, productId: 0x0719, productName: name || 'Test Wireless Receiver', interfaces:
      [0, 1, 2, 3].flatMap(i => [
        { interfaceNumber: i * 2, alternates: [alt(0x5d, 0x81, [ep(i * 2 + 1, 'in'), ep(i * 2 + 1, 'out')])] },
        { interfaceNumber: i * 2 + 1, alternates: [alt(0x5d, 0x82, [ep(i * 2 + 2, 'in'), ep(i * 2 + 2, 'out')])] },
      ]) };
    if (kind === 'mouse') opts = { vendorId: 0x046d, productId: 0xc077, productName: 'Test Mouse', interfaces: [
      { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 3, interfaceSubclass: 1, interfaceProtocol: 2, endpoints: [ep(1, 'in')] }] },
    ] };
    const fake = new FakeUSBDevice(opts);
    fakes[name || kind] = fake;
    return fake;
  };
})();`;
