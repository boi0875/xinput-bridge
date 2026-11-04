// Regenerates docs/*.png from the real UI, fed by simulated controllers.
// Usage: npm run screenshots   (CHROMIUM_PATH works as for the e2e tests)
import { fileURLToPath } from 'node:url';
import { x360Report } from '../test/fixtures.js';
import { launch, waitFor } from '../test/e2e/harness.js';

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
const env = await launch();
try {
  const dash = await env.context.newPage();
  await dash.setViewportSize({ width: 960, height: 820 });
  await dash.goto(`chrome-extension://${env.extensionId}/src/ui/dashboard.html`);
  await env.worker.evaluate(() => {
    const pad = makeFake('x360', 'Wired Controller');
    pad.manufacturerName = 'PowerA';
    return xinputBridge.attach(pad);
  });
  await dash.waitForSelector('.pad');
  await env.worker.evaluate(bytes => fakes['Wired Controller'].push(1, bytes),
    x360Report({ b1: 0x10 | 0x02, b0: 0x08, lt: 170, lx: 21000, ly: 12000, rx: -6000, ry: -20000 }));
  await waitFor(() => dash.evaluate(() => document.querySelectorAll('.key.down').length === 3));
  await dash.waitForTimeout(250);   // let the key transitions finish
  await dash.screenshot({ path: `${docs}dashboard.png` });

  const popup = await env.context.newPage();
  await popup.setViewportSize({ width: 340, height: 230 });
  await popup.goto(`chrome-extension://${env.extensionId}/src/ui/popup.html`);
  await popup.waitForSelector('.row');
  await popup.screenshot({ path: `${docs}popup.png` });
  console.log('wrote docs/dashboard.png and docs/popup.png');
} finally {
  await env.close();
}
