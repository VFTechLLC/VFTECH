// Captures each design's 1200x630 link-preview card from its own home page, as the site is actually served.
// Run after scripts/assemble.sh:   node scripts/capture-cards.mjs
// Writes design-3/social/, site/social/, design-2/social/, design-4/social/ and design-5/social/ vftech-card.jpg.
// Each card is taken once the 3D mark faces the camera (where a design has one), with motion stopped and the switcher and pause button hidden.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve('_site'), BASE = '/VFTECH/';
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(BASE.length));
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
});
await new Promise(r => server.listen(0, r));
const ORIGIN = `http://localhost:${server.address().port}${BASE}`;

const CARDS = [['', 'site'], ['design-3/', 'design-3'], ['design-2/', 'design-2'], ['design-4/', 'design-4'], ['design-5/', 'design-5'], ['design-6/', 'design-6'], ['design-7/', 'design-7'], ['design-8/', 'design-8'], ['design-9/', 'design-9'], ['design-10/', 'design-10']];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;   // e.g. ONLY=design-6,design-7
for (const [url, out] of CARDS.filter(([, o]) => !ONLY || ONLY.includes(o))) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 756 }, deviceScaleFactor: 1200 / 1440 });
  await page.route(u => !u.href.startsWith('http://localhost'), r => r.abort());
  await page.goto(ORIGIN + url, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '.design-switch,.hero-pause,.x-bookbar{display:none!important}' });
  // designs with the 3D mark wait for it to turn solid; designs without one (6 onward use a hero image) only wait for fonts
  await page.waitForFunction(() => document.fonts.status === 'loaded' && (!document.querySelector('[data-chrome-hero]') || document.querySelector('.chrome-solid')), null, { timeout: 120000 });
  await page.waitForTimeout(1200);
  // wait for the mark to face the camera, then freeze everything on that frame
  await page.waitForFunction(() => {
    const el = document.querySelector('.hero-pool'); if (!el) return true;
    return +getComputedStyle(el).getPropertyValue('--mark-turn') > 0.985;
  }, null, { timeout: 90000, polling: 30 });
  await page.evaluate(() => document.querySelector('[data-motion-control]')?.click());
  await page.waitForTimeout(1200);
  await mkdir(path.join(out, 'social'), { recursive: true });
  const dest = path.join(out, 'social', 'vftech-card.jpg');
  await page.screenshot({ path: dest, type: 'jpeg', quality: 84 });
  console.log(`${out}/social/vftech-card.jpg  ${(statSync(dest).size / 1024).toFixed(0)} KB`);
  await page.close();
}
await browser.close(); server.close();
