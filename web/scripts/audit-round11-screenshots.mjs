/**
 * Round 11 audit — capture our-side per-component screenshots.
 *
 *   node scripts/audit-round11-screenshots.mjs
 *
 * Uploads metarich, opens the design setting page, and for each component
 * in the inventory drives `window.__canvasFitBox` to focus that node, then
 * captures a PNG into docs/audit-round11/<slug>/ours.png.
 *
 * Pre-reqs: web dev server up at http://localhost:5273 (Vite) and
 * http://localhost:5274 (backend). Start with `npm run dev`.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const FIG_PATH = resolve(REPO_ROOT, 'docs', '메타리치 화면 UI Design.fig');
const OUT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-round11');

// Section 1 absolute origin on the design setting page.
const SEC1_X = 533;
const SEC1_Y = 700;

/** Each component to capture. Coords are LOCAL to Section 1; we add the
 *  Section 1 origin to convert into page-absolute space, which is what
 *  the canvas auto-fit math operates in. */
const COMPONENTS = [
  { slug: 'button',       name: 'Button',       x:    9, y:   47, w: 2297, h: 248 },
  { slug: 'input-box',    name: 'Input Box',    x:    9, y:  350, w:  407, h: 488 },
  { slug: 'type',         name: 'Type',         x:  432, y:  350, w:  377, h: 274 },
  { slug: 'option-a',     name: 'option (1)',   x:  432, y:  656, w:  140, h: 182 },
  { slug: 'dropdown',     name: 'Dropdown',     x:  586, y:  656, w:  241, h: 130 },
  { slug: 'sidemenu',     name: 'sidemenu',     x: 2042, y:  386, w:  250, h: 417 },
  { slug: 'radio',        name: 'Radio',        x:  843, y:  350, w:  123, h: 196 },
  { slug: 'multicheck',   name: 'MultiCheck',   x:  843, y:  575, w:  123, h: 240 },
  { slug: 'date',         name: 'Date',         x:  998, y:  350, w: 1008, h: 156 },
  { slug: 'datepicker',   name: 'DatePicker',   x:  998, y:  522, w: 1008, h: 316 },
  { slug: 'table-a',      name: 'table (1)',    x:   28, y: 1188, w: 1590, h: 321 },
  { slug: 'table-b',      name: 'table (2)',    x:   28, y: 1544, w: 1590, h: 140 },
  { slug: 'table-nodata', name: 'table_nodata', x:   28, y: 1727, w: 1590, h: 120 },
  { slug: 'option-b',     name: 'option (2)',   x: 2042, y:  859, w:  274, h: 242 },
  { slug: 'breadscrum',   name: 'breadscrum',   x:  592, y:  805, w:  217, h:  44 },
  { slug: 'toast-popup',  name: 'toast popup',  x:    9, y:  868, w:  280, h: 160 },
  { slug: 'alert',        name: 'alret',        x:  330, y:  868, w:  330, h: 170 },
  { slug: 'pagenation',   name: 'pagenation',   x:  747, y:  863, w:  438, h: 108 },
  { slug: 'loader',       name: 'loader',       x:  707, y: 1017, w:  112, h:  78 },
  { slug: 'label',        name: 'labe',         x: 1491, y:  883, w:  185, h: 320 },
];

async function main() {
  // 1) Open the app and upload via the file-input — same pattern as e2e tests.
  //    Avoids needing a query-string session loader the app doesn't yet support.
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto('http://localhost:5273/');
  await page.locator('input[type="file"][accept=".fig"]').setInputFiles(FIG_PATH);
  await page.waitForSelector('canvas', { timeout: 90_000 });
  // Settle: first paint + ImageFill async loads. The metarich doc has
  // ~6k blobs; allow enough time for the first-page assets to land.
  await page.waitForTimeout(4000);

  // 3) Find the canvas pane bounding box. Screenshots will clip to it so
  //    the captures don't include the sidebars or chrome.
  const canvasBox = await page.evaluate(() => {
    const el = document.querySelector('canvas');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (!canvasBox) throw new Error('canvas element not found');
  console.log('[canvas]', canvasBox);

  for (const c of COMPONENTS) {
    const absX = SEC1_X + c.x;
    const absY = SEC1_Y + c.y;
    const slugDir = resolve(OUT_ROOT, c.slug);
    mkdirSync(slugDir, { recursive: true });
    // Drive the debug hook to focus this node.
    await page.evaluate(({ x, y, w, h }) => {
      const fn = window.__canvasFitBox;
      if (typeof fn === 'function') fn({ x, y, w, h }, 32);
    }, { x: absX, y: absY, w: c.w, h: c.h });
    await page.waitForTimeout(600);
    const outPath = resolve(slugDir, 'ours.png');
    await page.screenshot({
      path: outPath,
      clip: { x: canvasBox.x, y: canvasBox.y, width: canvasBox.w, height: canvasBox.h },
    });
    console.log(`[shot] ${c.slug.padEnd(14)} → ${outPath}`);
  }

  await browser.close();
  console.log('\nDone. Drop Figma screenshots into the same folders as `figma.png`.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
