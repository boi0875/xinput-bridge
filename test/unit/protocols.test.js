import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  B, GIP_INIT_TABLE, Protocol, applyStickDeadzone, createDriver, findPadInterfaces, gamepadId,
  parseGipInput, parseX360Input, sameState, shapeState,
} from '../../extension/src/protocols.js';
import { x360Report, gipReport, gipGuideReport } from '../fixtures.js';

const view = bytes => new DataView(Uint8Array.from(bytes).buffer);
const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Xbox 360: neutral report decodes to all zeros', () => {
  const s = parseX360Input(view(x360Report()));
  assert.deepEqual(s.buttons, new Array(17).fill(0));
  assert.deepEqual(s.axes, [0, 0, 0, 0]);
});

test('Xbox 360: every button lands on its standard index', () => {
  const cases = [
    [{ b1: 0x10 }, B.A], [{ b1: 0x20 }, B.B], [{ b1: 0x40 }, B.X], [{ b1: 0x80 }, B.Y],
    [{ b1: 0x01 }, B.LB], [{ b1: 0x02 }, B.RB], [{ b1: 0x04 }, B.GUIDE],
    [{ b0: 0x20 }, B.BACK], [{ b0: 0x10 }, B.START], [{ b0: 0x40 }, B.LS], [{ b0: 0x80 }, B.RS],
    [{ b0: 0x01 }, B.UP], [{ b0: 0x02 }, B.DOWN], [{ b0: 0x04 }, B.LEFT], [{ b0: 0x08 }, B.RIGHT],
  ];
  for (const [input, index] of cases) {
    const s = parseX360Input(view(x360Report(input)));
    const expected = new Array(17).fill(0);
    expected[index] = 1;
    assert.deepEqual(s.buttons, expected, JSON.stringify(input));
  }
});

test('Xbox 360: simultaneous presses all come through', () => {
  const s = parseX360Input(view(x360Report({ b0: 0x0f, b1: 0xf3 })));
  for (const i of [B.A, B.B, B.X, B.Y, B.LB, B.RB, B.UP, B.DOWN, B.LEFT, B.RIGHT]) assert.equal(s.buttons[i], 1);
});

test('Xbox 360: triggers and sticks, with Y flipped to up = -1', () => {
  const s = parseX360Input(view(x360Report({ lt: 255, rt: 128, lx: 32767, ly: 32767, rx: -32768, ry: -32768 })));
  assert.equal(s.buttons[B.LT], 1);
  close(s.buttons[B.RT], 128 / 255);
  assert.deepEqual(s.axes, [1, -1, -1, 1]);
});

test('Xbox 360: ignores non-input reports', () => {
  assert.equal(parseX360Input(view([0x01, 0x03, 0x06])), null);
  assert.equal(parseX360Input(view([0x03, 0x03, 0x00])), null);
});

test('Xbox 360 driver: LED and rumble packets', () => {
  const d = createDriver(Protocol.X360);
  assert.deepEqual([...d.ledPacket(0)], [0x01, 0x03, 0x06]);
  assert.deepEqual([...d.ledPacket(3)], [0x01, 0x03, 0x09]);
  assert.deepEqual([...d.rumblePacket({ strong: 1, weak: 0.5 })], [0x00, 0x08, 0x00, 0xff, 0x80, 0, 0, 0]);
  assert.equal(d.hotplug, false);
});

test('Xbox 360 wireless: presence reports and offset input', () => {
  const d = createDriver(Protocol.X360W);
  assert.deepEqual(d.parse(view([0x08, 0x80])), { present: true });
  assert.deepEqual(d.parse(view([0x08, 0x00])), { present: false });
  const input = [0x00, 0x01, 0x00, 0xf0, ...x360Report({ b1: 0x10, lx: 16384 })];
  const r = d.parse(view(input));
  assert.equal(r.state.buttons[B.A], 1);
  close(r.state.axes[0], 16384 / 32767);
  // battery / serial status reports are ignored
  assert.equal(d.parse(view([0x00, 0x0f, 0x00, 0xf0, 0xf0, 0xcc])), null);
  assert.deepEqual([...d.ledPacket(1)], [0x00, 0x00, 0x08, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...d.rumblePacket({ strong: 1, weak: 0 })], [0x00, 0x01, 0x0f, 0xc0, 0x00, 0xff, 0x00, 0, 0, 0, 0, 0]);
  assert.equal(d.initPackets().length, 1);
});

test('GIP: input report decodes buttons, 10-bit triggers and sticks', () => {
  const s = parseGipInput(view(gipReport({ b4: 0x10 | 0x04, b5: 0x01 | 0x20, lt: 1023, rt: 512, lx: -32768, ly: 32767 })));
  assert.equal(s.buttons[B.A], 1);
  assert.equal(s.buttons[B.START], 1);
  assert.equal(s.buttons[B.UP], 1);
  assert.equal(s.buttons[B.RB], 1);
  assert.equal(s.buttons[B.B], 0);
  assert.equal(s.buttons[B.LT], 1);
  close(s.buttons[B.RT], 512 / 1023);
  assert.deepEqual(s.axes.slice(0, 2), [-1, -1]);
});

test('GIP: guide button comes in its own report and needs an ack', () => {
  const d = createDriver(Protocol.GIP, { vendorId: 0x24c6, productId: 0x543a });
  d.parse(view(gipReport({ b4: 0x10 })));
  const r = d.parse(view(gipGuideReport({ pressed: true, seq: 0x2a, ack: true })));
  assert.equal(r.state.buttons[B.GUIDE], 1);
  assert.equal(r.state.buttons[B.A], 1, 'keeps the other buttons from the last input report');
  assert.deepEqual([...r.reply[0]], [0x01, 0x20, 0x2a, 0x09, 0x00, 0x07, 0x20, 0x02, 0, 0, 0, 0, 0]);
  // later input reports keep the guide state
  const next = d.parse(view(gipReport({})));
  assert.equal(next.state.buttons[B.GUIDE], 1);
  const up = d.parse(view(gipGuideReport({ pressed: false, seq: 0x2b, ack: false })));
  assert.equal(up.state.buttons[B.GUIDE], 0);
  assert.equal(up.reply, undefined);
});

test('GIP: init packets match the vendor table and carry fresh sequence numbers', () => {
  const generic = createDriver(Protocol.GIP, { vendorId: 0x1234, productId: 0x5678 }).initPackets();
  assert.equal(generic.length, 1);
  assert.deepEqual([...generic[0]], [0x05, 0x20, 0x01, 0x01, 0x00]);

  const pdp = createDriver(Protocol.GIP, { vendorId: 0x0e6f, productId: 0x02ab }).initPackets();
  assert.deepEqual(pdp.map(p => p[0]), [0x05, 0x0a, 0x06]);
  assert.deepEqual(pdp.map(p => p[2]), [1, 2, 3]);

  const powerA = createDriver(Protocol.GIP, { vendorId: 0x24c6, productId: 0x543a }).initPackets();
  assert.deepEqual(powerA.map(p => p[0]), [0x05, 0x09, 0x09]);
  assert.equal(powerA[1][8], 0x1d);
  assert.equal(powerA[2][8], 0x00);

  // the table itself isn't mutated by sequence numbering
  for (const [, , pkt] of GIP_INIT_TABLE) assert.equal(pkt[2], 0);
});

test('GIP: sequence numbers skip 0 when they wrap', () => {
  const d = createDriver(Protocol.GIP);
  d.seq = 0xff;
  assert.equal(d.nextSeq(), 0xff);
  assert.equal(d.nextSeq(), 1);
});

test('GIP: rumble packet uses 0..100 magnitudes, trigger motors included', () => {
  const d = createDriver(Protocol.GIP);
  const p = d.rumblePacket({ strong: 1, weak: 0.5, left: 0.25, right: 0 });
  assert.deepEqual([...p.slice(3)], [0x09, 0x00, 0x0f, 25, 0, 100, 50, 0xff, 0x00, 0xff]);
  assert.equal(p[0], 0x09);
});

test('GIP: announce triggers a fresh init', () => {
  const d = createDriver(Protocol.GIP);
  const r = d.parse(view([0x02, 0x20, 0x01, 0x1c, ...new Array(28).fill(0)]));
  assert.equal(r.reply[0][0], 0x05);
});

// ---------- interface discovery ----------

const ep = (endpointNumber, direction, type = 'interrupt') => ({ endpointNumber, direction, type, packetSize: 32 });
const iface = (interfaceNumber, sub, proto, endpoints) => ({
  interfaceNumber,
  alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: sub, interfaceProtocol: proto, endpoints }],
});

test('finds the input interface of a wired 360 pad, skipping headset interfaces', () => {
  const config = { interfaces: [
    iface(0, 0x5d, 0x01, [ep(1, 'in'), ep(2, 'out')]),
    iface(1, 0x5d, 0x03, [ep(3, 'in'), ep(4, 'out')]),
    iface(2, 0x5d, 0x02, [ep(5, 'in')]),
    { interfaceNumber: 3, alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0xfd, interfaceProtocol: 0x13, endpoints: [] }] },
  ] };
  assert.deepEqual(findPadInterfaces(config), [
    { interfaceNumber: 0, alternateSetting: 0, protocol: Protocol.X360, epIn: 1, epOut: 2 },
  ]);
});

test('finds all four pad slots on a wireless receiver', () => {
  const interfaces = [];
  for (let i = 0; i < 4; i++) {
    interfaces.push(iface(i * 2, 0x5d, 0x81, [ep(i * 2 + 1, 'in'), ep(i * 2 + 1, 'out')]));
    interfaces.push(iface(i * 2 + 1, 0x5d, 0x82, [ep(i * 2 + 2, 'in'), ep(i * 2 + 2, 'out')]));
  }
  const found = findPadInterfaces({ interfaces });
  assert.equal(found.length, 4);
  assert.deepEqual(found.map(f => f.interfaceNumber), [0, 2, 4, 6]);
  assert.ok(found.every(f => f.protocol === Protocol.X360W));
});

test('finds the GIP data interface, not the audio ones', () => {
  const config = { interfaces: [
    iface(0, 0x47, 0xd0, [ep(2, 'out'), ep(2, 'in')]),
    { interfaceNumber: 1, alternates: [
      { alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0x47, interfaceProtocol: 0xd0, endpoints: [] },
      { alternateSetting: 1, interfaceClass: 0xff, interfaceSubclass: 0x47, interfaceProtocol: 0xd0,
        endpoints: [ep(3, 'out', 'isochronous'), ep(3, 'in', 'isochronous')] },
    ] },
  ] };
  assert.deepEqual(findPadInterfaces(config), [
    { interfaceNumber: 0, alternateSetting: 0, protocol: Protocol.GIP, epIn: 2, epOut: 2 },
  ]);
});

test('reports nothing for unrelated devices', () => {
  assert.deepEqual(findPadInterfaces({ interfaces: [iface(0, 0x00, 0x00, [ep(1, 'in')])] }), []);
  assert.deepEqual(findPadInterfaces(null), []);
});

// ---------- shaping ----------

test('radial deadzone zeroes the center and rescales the rest', () => {
  assert.deepEqual(applyStickDeadzone(0.03, -0.02, 0.05), [0, 0]);
  const [x, y] = applyStickDeadzone(1, 0, 0.1);
  close(x, 1); close(y, 0);
  const [hx] = applyStickDeadzone(0.55, 0, 0.1);
  close(hx, 0.5);
  // keeps direction on diagonals instead of snapping to an axis
  const [dx, dy] = applyStickDeadzone(0.5, 0.5, 0.1);
  close(dx, dy);
  assert.deepEqual(applyStickDeadzone(0.01, 0, 0), [0.01, 0]);
});

test('shapeState applies the deadzone to both sticks and leaves buttons alone', () => {
  const raw = { buttons: [1, ...new Array(16).fill(0)], axes: [0.02, 0.02, 0.9, 0] };
  const s = shapeState(raw, { deadzone: 0.05 });
  assert.deepEqual(s.axes.slice(0, 2), [0, 0]);
  assert.ok(s.axes[2] > 0.88);
  assert.equal(s.buttons[0], 1);
  assert.ok(sameState(s, shapeState(raw, { deadzone: 0.05 })));
  assert.ok(!sameState(s, shapeState(raw, { deadzone: 0 })));
});

test('gamepad ids', () => {
  assert.equal(gamepadId(Protocol.X360), 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)');
  assert.match(gamepadId(Protocol.GIP), /^Xbox One Controller/);
  assert.equal(
    gamepadId(Protocol.X360, { identity: 'device', name: 'OPS v3 Pro', vendorId: 0x20d6, productId: 0x2035 }),
    'OPS v3 Pro (STANDARD GAMEPAD Vendor: 20d6 Product: 2035)');
});
