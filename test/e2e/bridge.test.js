import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { gipGuideReport, gipReport, x360Report } from '../fixtures.js';
import { GAME_PAGE, launch, serve, waitFor } from './harness.js';

let env;
let page;

before(async () => {
  env = await launch();
  await serve(env.context, 'https://game.test', GAME_PAGE);
  await serve(env.context, 'https://frame.test', GAME_PAGE);
  await serve(env.context, 'https://host.test',
    '<!doctype html><title>host</title><p>no gamepad code here</p><iframe src="https://frame.test/" width="300" height="200"></iframe>');
  await serve(env.context, 'https://plain.test', '<!doctype html><title>plain</title><p>no gamepad code here</p>');
});

after(async () => { await env?.close(); });

const sw = (fn, arg) => env.worker.evaluate(fn, arg);
const push = (name, ep, bytes) => sw(([n, e, b]) => fakes[n].push(e, b), [name, ep, bytes]);
const written = name => sw(n => fakes[n].out, name);
const pageClients = () => sw(() => [...xinputBridge.clients].filter(c => c.kind === 'page').length);

test('a page that never touches the Gamepad API opens no connection', async () => {
  const plain = await env.context.newPage();
  await plain.goto('https://plain.test/');
  await plain.waitForTimeout(300);
  assert.equal(await pageClients(), 0);
  await plain.close();
});

test('wired 360 pad: hidden until a button press, then connected at index 0', async () => {
  page = await env.context.newPage();
  await page.goto('https://game.test/');
  await waitFor(pageClients, { message: 'page to connect' });

  await sw(() => xinputBridge.attach(makeFake('x360')));
  // LED for player 1
  await waitFor(async () => (await written('x360')).some(([, b]) => b.join() === '1,3,6'), { message: 'player LED' });

  // Like Chrome, nothing shows before a button press.
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => events), []);
  assert.deepEqual(await page.evaluate(() => snap()), [null, null, null, null]);

  await push('x360', 1, x360Report({ b1: 0x10 }));   // A down
  await waitFor(() => page.evaluate(() => events.length >= 2), { message: 'connected events' });
  const events = await page.evaluate(() => events);
  assert.deepEqual(events, [
    ['connected', 0, 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', true],
    ['onconnected', 0],
  ], 'one addEventListener call and one on-handler call, no duplicates');

  const [pad] = await page.evaluate(() => snap());
  assert.equal(pad.index, 0);
  assert.equal(pad.mapping, 'standard');
  assert.equal(pad.connected, true);
  assert.equal(pad.isGamepad, true);
  assert.equal(pad.buttons[0], 1);
  assert.equal(pad.pressed[0], true);
  assert.deepEqual(pad.effects, ['dual-rumble']);
});

test('sticks, triggers and simultaneous buttons come through with the deadzone applied', async () => {
  await push('x360', 1, x360Report({ b0: 0x01 | 0x10, b1: 0x10 | 0x80, lt: 255, rt: 20, lx: 32767, ly: 32767, rx: 800, ry: 0 }));
  const pad = await waitFor(async () => {
    const [p] = await page.evaluate(() => snap());
    return p.axes[0] === 1 ? p : null;
  }, { message: 'stick update' });
  assert.deepEqual(pad.axes, [1, -1, 0, 0], 'Y flipped; tiny right-stick offset is inside the deadzone');
  assert.equal(pad.buttons[6], 1);
  assert.ok(Math.abs(pad.buttons[7] - 20 / 255) < 1e-3);
  assert.equal(pad.pressed[7], false, 'light trigger touch stays under the press threshold');
  for (const i of [0, 3, 9, 12]) assert.equal(pad.pressed[i], true, `button ${i}`);
});

test('snapshots are immutable and change identity on every update', async () => {
  const same = await page.evaluate(() => {
    const a = navigator.getGamepads()[0];
    const b = navigator.getGamepads()[0];
    return { same: a === b, frozen: Object.isFrozen(a) && Object.isFrozen(a.buttons) && Object.isFrozen(a.axes) };
  });
  assert.equal(same.same, true, 'no update in between: same snapshot');
  assert.equal(same.frozen, true);

  await page.evaluate(() => { window.before = navigator.getGamepads()[0]; });
  await push('x360', 1, x360Report({}));
  await waitFor(() => page.evaluate(() => navigator.getGamepads()[0] !== window.before), { message: 'new snapshot' });
  const kept = await page.evaluate(() => window.before.buttons[0].pressed);
  assert.equal(kept, true, 'the old snapshot still shows the old state');
});

test('rumble: playEffect drives the motors and stops them afterwards', async () => {
  const result = await page.evaluate(() => navigator.getGamepads()[0].vibrationActuator.playEffect('dual-rumble', {
    duration: 120, strongMagnitude: 1, weakMagnitude: 0.5,
  }));
  assert.equal(result, 'complete');
  await waitFor(async () => (await written('x360')).some(([, b]) => b.join() === '0,8,0,0,0,0,0,0'), { message: 'motor stop' });
  const packets = (await written('x360')).map(([, b]) => b.join());
  assert.ok(packets.includes('0,8,0,255,128,0,0,0'), 'motor start packet');

  const preempted = await page.evaluate(async () => {
    const act = navigator.getGamepads()[0].vibrationActuator;
    const first = act.playEffect('dual-rumble', { duration: 1000, strongMagnitude: 0.3 });
    await new Promise(r => setTimeout(r, 30));
    const second = act.reset();
    return [await first, await second];
  });
  assert.deepEqual(preempted, ['preempted', 'complete']);

  const errors = await page.evaluate(async () => {
    const act = navigator.getGamepads()[0].vibrationActuator;
    const out = [];
    for (const [type, params] of [['trigger-rumble', {}], ['dual-rumble', { strongMagnitude: 2 }]]) {
      try { await act.playEffect(type, params); out.push('resolved'); } catch (e) { out.push(e.name); }
    }
    return out;
  });
  assert.deepEqual(errors, ['NotSupportedError', 'TypeError']);
});

test('a second tab sees the same controller', async () => {
  const other = await env.context.newPage();
  await other.goto('https://game.test/?2');
  await other.bringToFront();
  await waitFor(async () => (await pageClients()) >= 2, { message: 'second page connection' });
  await push('x360', 1, x360Report({ b1: 0x20 }));   // B
  const pad = await waitFor(async () => (await other.evaluate(() => snap()))[0], { message: 'pad in second tab' });
  assert.equal(pad.buttons[1], 1);
  await other.close();
  await page.bringToFront();
});

test('cross-origin iframes get the controller too', async () => {
  const host = await env.context.newPage();
  await host.goto('https://host.test/');
  const frame = await waitFor(() => host.frames().find(f => f.url().startsWith('https://frame.test')), { message: 'iframe' });
  await waitFor(() => frame.evaluate(() => typeof snap === 'function'), { message: 'iframe script' });
  await frame.evaluate(() => snap());
  await push('x360', 1, x360Report({ b1: 0x40 }));   // X
  const pad = await waitFor(async () => (await frame.evaluate(() => snap()))[0], { message: 'pad in iframe' });
  assert.equal(pad.buttons[2], 1);
  await host.close();
  await page.bringToFront();
});

test('Xbox One (GIP) pad: init sequence, input, guide ack, trigger rumble', async () => {
  await sw(() => xinputBridge.attach(makeFake('gip')));
  await waitFor(async () => (await written('gip')).length >= 3, { message: 'GIP init' });
  const init = (await written('gip')).slice(0, 3).map(([, b]) => b[0]);
  assert.deepEqual(init, [0x05, 0x09, 0x09], 'power on, then the PowerA rumble kick');

  await push('gip', 2, gipReport({ b4: 0x20, lt: 1023, lx: -32768 }));   // B + full LT + stick left
  const pad = await waitFor(async () => (await page.evaluate(() => snap()))[1], { message: 'GIP pad at index 1' });
  assert.equal(pad.id, 'Xbox One Controller (STANDARD GAMEPAD Vendor: 045e Product: 02dd)');
  assert.equal(pad.buttons[1], 1);
  assert.equal(pad.buttons[6], 1);
  assert.equal(pad.axes[0], -1);
  assert.deepEqual(pad.effects, ['dual-rumble', 'trigger-rumble']);

  await push('gip', 2, gipGuideReport({ pressed: true, seq: 9, ack: true }));
  await waitFor(async () => (await page.evaluate(() => snap()))[1].buttons[16] === 1, { message: 'guide button' });
  assert.ok((await written('gip')).some(([, b]) => b[0] === 0x01 && b[2] === 9 && b[5] === 0x07), 'guide report acked');

  await page.evaluate(() => navigator.getGamepads()[1].vibrationActuator.playEffect('trigger-rumble', {
    duration: 50, leftTrigger: 1, rightTrigger: 0.5,
  }));
  const rumble = (await written('gip')).map(([, b]) => b).find(b => b[0] === 0x09 && b[6] === 100);
  assert.ok(rumble, 'trigger motor packet');
  assert.equal(rumble[7], 50);
});

test('wireless receiver: pads join as the receiver reports them', async () => {
  await sw(() => xinputBridge.attach(makeFake('x360w')));
  await waitFor(async () => (await written('x360w')).length >= 4, { message: 'presence queries' });
  // Nothing linked yet.
  assert.equal((await page.evaluate(() => snap()))[2], null);

  await push('x360w', 3, [0x08, 0x80]);   // a pad links on the second slot (interface 2, endpoint 3)
  await push('x360w', 3, [0x00, 0x01, 0x00, 0xf0, ...x360Report({ b1: 0x80 })]);
  const pad = await waitFor(async () => (await page.evaluate(() => snap()))[2], { message: 'wireless pad at index 2' });
  assert.equal(pad.buttons[3], 1);
  assert.ok((await written('x360w')).some(([ep, b]) => ep === 3 && b.join() === '0,0,8,72,0,0,0,0,0,0,0,0'),
    'player 3 LED on the right slot');

  await push('x360w', 3, [0x08, 0x00]);   // pad switched off
  await waitFor(async () => (await page.evaluate(() => snap()))[2] === null, { message: 'wireless pad gone' });
  const events = await page.evaluate(() => events.filter(e => e[0] === 'disconnected'));
  assert.deepEqual(events, [['disconnected', 2, false]]);
});

test('non-controller devices are reported as unsupported and left closed', async () => {
  await sw(() => xinputBridge.attach(makeFake('mouse')));
  const status = await sw(() => [...xinputBridge.devices.values()].find(d => d.usb === fakes.mouse).status);
  assert.equal(status, 'unsupported');
  assert.equal(await sw(() => fakes.mouse.opened), false);
});

test('dashboard lists devices and shows live input', async () => {
  const dash = await env.context.newPage();
  await dash.setViewportSize({ width: 1000, height: 1400 });
  await dash.goto(`chrome-extension://${env.extensionId}/src/ui/dashboard.html`);
  await dash.waitForSelector('.device');
  const names = await dash.$$eval('.device .name', n => n.map(e => e.textContent));
  assert.deepEqual(names, ['Test 360 Pad', 'Test GIP Pad', 'Test Wireless Receiver', 'Test Mouse']);
  await push('x360', 1, x360Report({ b1: 0x10, lx: 16000, ly: -16000, lt: 200 }));
  await waitFor(() => dash.evaluate(() => document.querySelector('.key.down')?.textContent), { message: 'key lit' });
  if (process.env.SCREENSHOTS) await dash.screenshot({ path: `${process.env.SCREENSHOTS}/dashboard.png`, fullPage: true });

  const popup = await env.context.newPage();
  await popup.setViewportSize({ width: 340, height: 420 });
  await popup.goto(`chrome-extension://${env.extensionId}/src/ui/popup.html`);
  await popup.waitForSelector('.row');
  const rows = await popup.$$eval('.row .name', n => n.map(e => e.textContent));
  assert.ok(rows.includes('Test 360 Pad') && rows.includes('Test GIP Pad'));
  if (process.env.SCREENSHOTS) await popup.screenshot({ path: `${process.env.SCREENSHOTS}/popup.png` });
  await popup.close();
  await dash.close();
  await push('x360', 1, x360Report({}));
});

test('changing the deadzone setting reshapes live input', async () => {
  await page.bringToFront();
  await push('x360', 1, x360Report({ lx: 6000 }));   // ~0.18
  await waitFor(async () => (await page.evaluate(() => snap()))[0].axes[0] > 0.1, { message: 'stick moved' });
  await sw(() => chrome.storage.sync.set({ deadzone: 0.25 }));
  await waitFor(async () => (await page.evaluate(() => snap()))[0].axes[0] === 0, { message: 'inside the new deadzone' });
  await sw(() => chrome.storage.sync.set({ deadzone: 0.04 }));
});

test('turning the bridge off for a site disconnects its pads there', async () => {
  await sw(() => chrome.storage.sync.set({ disabledSites: ['game.test'] }));
  await waitFor(async () => (await page.evaluate(() => snap())).every(g => g === null), { message: 'pads removed' });
  await sw(() => chrome.storage.sync.set({ disabledSites: [] }));
  await waitFor(async () => (await page.evaluate(() => snap()))[0], { message: 'pads back' });
});

test('unplugging a pad fires gamepaddisconnected and frees its slot', async () => {
  await page.evaluate(() => { events.length = 0; });
  await sw(() => fakes.x360.unplug());
  await waitFor(async () => (await page.evaluate(() => snap()))[0] === null, { message: 'slot 0 empty' });
  const events = await page.evaluate(() => events);
  assert.deepEqual(events[0], ['disconnected', 0, false]);
  assert.ok((await page.evaluate(() => snap()))[1], 'the GIP pad is still at index 1');
});
