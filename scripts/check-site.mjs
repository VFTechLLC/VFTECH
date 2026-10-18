// Opens every page of every design in a real browser and fails if something a visitor would see is broken.
// Run after scripts/assemble.sh:   node scripts/check-site.mjs
// For each page, at 1440×900 and 390×844, it fails on:
//   · a script error, or a missing local file (any 4xx/5xx from the site itself);
//   · the page scrolling sideways;
//   · content still hidden after scrolling to the bottom (a reveal that never fired);
//   · text with a contrast ratio under 3:1 against what is actually behind it (axe-core).
// The 404 page is checked too. A full-page screenshot of every page lands in checks-out/ for review.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const ROOT = path.resolve('_site');
const BASE = '/VFTECH/';                      // served under the same prefix as GitHub Pages
const OUT = path.resolve('checks-out');
const PAGES = ['index.html', 'websites.html', 'ai.html', 'advisory.html', 'process.html', 'about.html', 'contact.html'];
const DESIGNS = [['1', ''], ['3', 'design-3/'], ['2', 'design-2/'], ['4', 'design-4/'], ['5', 'design-5/'], ['6', 'design-6/'], ['7', 'design-7/'], ['8', 'design-8/'], ['9', 'design-9/'], ['10', 'design-10/']];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;   // e.g. ONLY=9,10 to check just those designs
const VIEWPORTS = [[1440, 900], [390, 844]];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.xml': 'application/xml', '.txt': 'text/plain', '.json': 'application/json' };

if (!existsSync(ROOT)) { console.error('No _site/. Run: bash scripts/assemble.sh'); process.exit(1); }

// a static server that behaves like GitHub Pages: directory → index.html, unknown path → 404.html with status 404
const server = http.createServer(async (req, res) => {
  let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!url.startsWith(BASE)) { res.writeHead(404); return res.end(); }
  let file = path.join(ROOT, url.slice(BASE.length));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  let status = 200;
  if (!existsSync(file)) { status = 404; file = path.join(ROOT, '404.html'); }
  res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
});
await new Promise(r => server.listen(0, r));
const ORIGIN = `http://localhost:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--disable-webgl'] });   // the SVG fallback stands in for the 3D mark
const failures = [];
let checked = 0;

async function checkPage(label, url, [w, h], { expectStatus = 200 } = {}) {
  const context = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(`script error: ${e.message}`));
  page.on('response', r => {
    const u = r.url();
    if (u.startsWith(ORIGIN) && r.status() >= 400 && !(u === url && r.status() === expectStatus)) problems.push(`HTTP ${r.status()} ${u.slice(ORIGIN.length)}`);
  });
  await page.route(u => !u.href.startsWith(ORIGIN), r => r.abort());   // stay hermetic: no third-party requests
  const resp = await page.goto(url, { waitUntil: 'load' });
  if (resp.status() !== expectStatus) problems.push(`expected HTTP ${expectStatus}, got ${resp.status()}`);
  await page.waitForTimeout(400);

  // scroll the whole page the way a visitor would, so scroll-triggered content gets its chance to appear
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += Math.round(h * 0.6)) { await page.mouse.wheel(0, Math.round(h * 0.6)); await page.waitForTimeout(80); }
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    hidden: [...document.querySelectorAll('.reveal:not(.in)')].map(e => (e.className + ' ' + (e.textContent || '').trim().slice(0, 40)).trim()),
  }));
  if (state.overflow > 1) problems.push(`page scrolls sideways by ${state.overflow}px`);
  if (state.hidden.length) problems.push(`${state.hidden.length} block(s) never revealed: ${state.hidden.slice(0, 3).join(' | ')}`);

  // the main hero button must have a visible fill (axe can't see backgrounds painted by pseudo-elements);
  // designs 6–10 compose their own heroes, so any .hero counts, not only the shared .hero--ref
  const cta = await page.evaluate(() => {
    const c = document.querySelector('.hero--ref .cta, main .hero .cta'); if (!c) return null;
    const alpha = col => { const m = col.match(/rgba?\(([^)]+)\)/); if (!m) return 0; const v = m[1].split(',').map(x => parseFloat(x)); return v.length > 3 ? v[3] : 1; };
    const s = getComputedStyle(c), b = getComputedStyle(c, '::before');
    return { own: alpha(s.backgroundColor), pseudo: b.content !== 'none' && b.content !== 'normal' ? alpha(b.backgroundColor) : 0, hasImage: s.backgroundImage !== 'none' || (b.content !== 'none' && b.backgroundImage !== 'none') };
  });
  if (cta && cta.own < 0.5 && cta.pseudo < 0.5 && !cta.hasImage) problems.push('hero button has no visible fill');

  // contrast, with everything revealed and motion stopped so nothing is caught mid-animation
  await page.evaluate(() => { document.documentElement.classList.add('motion-paused'); document.querySelectorAll('.reveal').forEach(e => e.classList.add('in')); });
  await page.waitForTimeout(300);
  const axe = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  for (const v of axe.violations) for (const n of v.nodes) {
    const ratio = n.any?.[0]?.data?.contrastRatio;
    if (ratio && ratio < 3) problems.push(`contrast ${ratio}:1 on ${n.target.join(' ')} "${(n.html || '').replace(/\s+/g, ' ').slice(0, 60)}"`);
  }

  const shot = path.join(OUT, `${label.replace(/[^\w.-]+/g, '_')}-${w}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  await context.close();
  checked++;
  if (problems.length) failures.push(`${label} @${w}px\n    - ${problems.join('\n    - ')}`);
  console.log(`${problems.length ? 'FAIL' : ' ok '}  ${label} @${w}px`);
}

for (const [n, dir] of DESIGNS.filter(([n]) => !ONLY || ONLY.includes(n))) for (const p of PAGES) for (const vp of VIEWPORTS)
  await checkPage(`design-${n}/${p}`, `${ORIGIN}${BASE}${dir}${p}`, vp);
for (const vp of VIEWPORTS) await checkPage('404', `${ORIGIN}${BASE}design-2/no-such-page.html`, vp, { expectStatus: 404 });

await browser.close();
server.close();
console.log(`\n${checked} page views checked, ${failures.length} with problems. Screenshots: ${path.relative(process.cwd(), OUT)}/`);
if (failures.length) { console.error('\n' + failures.join('\n\n')); process.exit(1); }
await import('../tests/services-browser.mjs');
await import('../tests/services-live-browser.mjs');
