// Renders extension/icons/icon.svg to the PNG sizes Chrome wants.
// Usage: npm run icons   (set CHROMIUM_PATH to use a specific Chromium build)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = fileURLToPath(new URL('../extension/icons/', import.meta.url));
const svg = await readFile(dir + 'icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: `${dir}icon-${size}.png`, omitBackground: true });
    await page.close();
    console.log(`icon-${size}.png`);
  }
} finally {
  await browser.close();
}
