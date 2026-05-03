/**
 * Round 11 audit — capture our-side screenshots for every entry in
 * docs/audit-round11/_INVENTORY.json across all 6 metarich pages.
 *
 *   node scripts/audit-round11-screenshots.mjs           # all pages
 *   node scripts/audit-round11-screenshots.mjs <slug>... # only matching pages
 *
 * Pre-reqs: web dev server up at :5273 + :5274 (`npm run dev`).
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const FIG_PATH = resolve(REPO_ROOT, 'docs', '메타리치 화면 UI Design.fig');
const OUT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-round11');
const INV_PATH = resolve(OUT_ROOT, '_INVENTORY.json');

async function main() {
  if (!existsSync(INV_PATH)) {
    throw new Error(`No inventory found at ${INV_PATH}. Run build-audit-inventory.mjs first.`);
  }
  const inv = JSON.parse(readFileSync(INV_PATH, 'utf-8'));
  const filterArgs = process.argv.slice(2);
  const pages = filterArgs.length > 0
    ? inv.pages.filter((p) => filterArgs.includes(p.slug))
    : inv.pages;
  if (pages.length === 0) {
    console.log(`No pages match filter: ${filterArgs.join(', ')}`);
    return;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  // ?audit=1 hides the ZoomBadge + round-10 variant labels so our PNGs
  // match Figma's clean API export (no UI chrome, no editor-only affordances).
  await page.goto('http://localhost:5273/?audit=1');
  await page.locator('input[type="file"][accept=".fig"]').setInputFiles(FIG_PATH);
  await page.waitForSelector('canvas', { timeout: 90_000 });
  await page.waitForTimeout(3500);

  // Make sure the Pages section is open. The collapse toggle is the page's
  // "Pages" heading button; click it if the list isn't visible.
  const pagesSection = page.locator('[data-testid="pages-section"]');
  await pagesSection.waitFor({ timeout: 30_000 });
  const listVisible = await pagesSection.locator('ul').isVisible().catch(() => false);
  if (!listVisible) {
    await pagesSection.locator('button').first().click();
    await page.waitForTimeout(200);
  }

  const canvasBox = await page.evaluate(() => {
    const el = document.querySelector('canvas');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (!canvasBox) throw new Error('canvas element not found');
  console.log('[canvas]', canvasBox);

  // Fit a fig-page bbox into the viewport, then return a screenshot clip
  // whose dims match the on-screen rect of that bbox. `__canvasFitBox`
  // returns the post-fit screen rect; we offset by canvasBox to convert
  // canvas-local coords to page-absolute coords (what page.screenshot wants).
  const fitAndClip = async (box, padPx) => {
    const screenRect = await page.evaluate(
      ({ x, y, w, h, p }) => window.__canvasFitBox?.({ x, y, w, h }, p) ?? null,
      { x: box.x, y: box.y, w: box.w, h: box.h, p: padPx },
    );
    if (!screenRect) throw new Error('__canvasFitBox not exposed on window');
    await page.waitForTimeout(450);
    return {
      x: Math.round(canvasBox.x + screenRect.x),
      y: Math.round(canvasBox.y + screenRect.y),
      width: Math.round(screenRect.w),
      height: Math.round(screenRect.h),
    };
  };

  for (const p of pages) {
    console.log(`\n=== page[${p.index}] ${p.name} (${p.slug}) — ${p.children.length} captures ===`);
    // Click the page in the sidebar by index. Pages render in document order.
    const pageItems = pagesSection.locator('li[role="listitem"]');
    await pageItems.nth(p.index).click();
    // Wait for canvas to settle on the new page (auto-fit needs a beat).
    await page.waitForTimeout(1500);

    // Overview capture (whole page bbox).
    if (p.pageBox) {
      const ovDir = resolve(OUT_ROOT, p.slug, '_overview');
      mkdirSync(ovDir, { recursive: true });
      const clip = await fitAndClip(p.pageBox, 24);
      await page.waitForTimeout(150);
      await page.screenshot({ path: resolve(ovDir, 'ours.png'), clip });
      console.log(`  [shot] _overview`);
    }

    for (const c of p.children) {
      const dir = resolve(OUT_ROOT, p.slug, c.slug);
      mkdirSync(dir, { recursive: true });
      const clip = await fitAndClip({ x: c.x, y: c.y, w: c.w, h: c.h }, 32);
      await page.screenshot({ path: resolve(dir, 'ours.png'), clip });
      console.log(`  [shot] ${c.slug}`);
    }
  }

  await browser.close();
  console.log('\nDone. Drop matching figma.png into the same folders.');
}

main().catch((e) => { console.error(e); process.exit(1); });
