// Controllers Chrome drives itself keep their own index next to bridged ones.
// A stand-in for Chrome's getGamepads() is installed before the extension's
// page script runs, so the bridge treats its pads as native.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { x360Report } from '../fixtures.js';
import { GAME_PAGE, launch, serve, waitFor } from './harness.js';

let env;
let page;

before(async () => {
  env = await launch();
  await env.context.addInitScript(() => {
    const pad = index => ({ id: 'Native Pad', index, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: [] });
    window.nativePads = [null, null, null, null];
    Navigator.prototype.getGamepads = function () { return window.nativePads.slice(); };
    window.plugNative = index => { window.nativePads[index] = pad(index); };
  });
  await serve(env.context, 'https://game.test', GAME_PAGE);
  page = await env.context.newPage();
  await page.goto('https://game.test/');
});

after(async () => { await env?.close(); });

test('the stand-in is what the bridge sees as native', async () => {
  const seenAsNative = await page.evaluate(() => { plugNative(0); return navigator.getGamepads()[0]?.id; });
  assert.equal(seenAsNative, 'Native Pad');
});

test('a bridged pad takes the first slot a native pad is not using', async () => {
  await waitFor(() => env.worker.evaluate(() => [...xinputBridge.clients].some(c => c.kind === 'page')), { message: 'page connection' });
  await env.worker.evaluate(() => xinputBridge.attach(makeFake('x360')));
  await waitFor(() => env.worker.evaluate(() => xinputBridge.players[0] !== null), { message: 'pad attached' });
  await env.worker.evaluate(b => fakes.x360.push(1, b), x360Report({ b1: 0x10 }));
  await waitFor(() => page.evaluate(() => events.some(e => e[0] === 'connected')), { message: 'connected' });
  const pads = await page.evaluate(() => snap().map(g => g && [g.index, g.id.slice(0, 12)]));
  assert.deepEqual(pads, [[0, 'Native Pad'], [1, 'Xbox 360 Con'], null, null]);
  assert.deepEqual(await page.evaluate(() => events.filter(e => e[0] === 'connected').map(e => e[1])), [1]);
});

test('a native pad arriving in a bridged slot moves the bridged pad, not the native one', async () => {
  await page.evaluate(() => { events.length = 0; plugNative(1); });
  const first = await page.evaluate(() => snap().map(g => g && [g.index, g.id.slice(0, 12)]));
  assert.deepEqual(first, [[0, 'Native Pad'], [1, 'Native Pad'], [2, 'Xbox 360 Con'], null]);
  await waitFor(() => page.evaluate(() => events.length >= 2), { message: 'move events' });
  const events = await page.evaluate(() => events.filter(e => e[0] !== 'onconnected').map(e => [e[0], e[1]]));
  assert.deepEqual(events, [['disconnected', 1], ['connected', 2]]);
});
