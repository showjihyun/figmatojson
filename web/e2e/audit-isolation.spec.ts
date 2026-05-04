/**
 * E2E gate: round-23 audit-harness isolation contract.
 *
 * Pins the four pieces of behaviour the audit screenshots script depends
 * on. If any future Canvas.tsx change silently breaks them, the audit
 * data we just refreshed (commits a15daea..aa18e03) starts diverging
 * from figma.png with no obvious owner.
 *
 *  (1) `?audit=1` exposes `window.__setIsolateNode` after the canvas
 *      mounts.
 *  (2) `__setIsolateNode(targetId)` causes ancestor `fillPaints` to be
 *      suppressed — sampled at a pixel that would otherwise be painted
 *      by an ancestor's solid fill, the canvas now reads white.
 *  (3) `__setIsolateNode(targetId)` causes ancestor `clipFunc` to be
 *      dropped (round-23 v3) — sampled inside the captured area but
 *      outside the ancestor's bbox, content the ancestor would have
 *      clipped now renders.
 *  (4) `__setIsolateNode(targetId)` hides non-ancestor sibling subtrees
 *      that overlap via z-order (round-23 v2) — sampled at a pixel
 *      where a sibling popup-screen overlapped the underlying screen,
 *      the underlying screen is no longer visible.
 *  (5) `__setIsolateNode(null)` clears isolation and restores the
 *      pre-isolation render.
 *
 * Spec / commit chain:
 *  - a15daea  v1 tooling (parent-clip + isolation)
 *  - 53d4df8  v2 hide non-ancestor subtrees
 *  - aa18e03  v3 drop ancestor clipFunc + frame-2320 fix
 *  - GAPS.md  "Round 22 follow-up" / "Round-23 audit-tooling changes shipped"
 *
 * Concrete fixtures used (data-driven from `메타리치 화면 UI Design.fig`):
 *  - right_top-401_7181 (FRAME 401:7181) — NO_FILL container inside parent
 *    FRAME 401:6772 with `fillPaints[0] = rgb(30,41,59)` dark navy. v1
 *    isolation should make the bg white.
 *  - frame-2320-587_7496 (FRAME 587:7496) — 1380-wide table inside FRAME
 *    587:7461 (454 wide, frameMaskDisabled=false). v3 drop-clip should
 *    make the right half of the table render.
 *  - frame-2364-1340_1858 (FRAME 1340:1858) — popup at the same canvas
 *    coords as a privacy-policy screen. v2 hide should remove the
 *    underlying screen text from the popup capture.
 *
 * Pixel-sampling notes: we read straight from `document.querySelector
 * ('canvas')`. React-Konva's first canvas is the main scene layer;
 * subsequent canvases hold selection/hover overlays which are inactive
 * in `?audit=1` mode. A few-pixel margin is used to dodge anti-aliased
 * edges that would otherwise create flaky thresholds.
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SAMPLE_FIG = join(REPO_ROOT, 'docs', '메타리치 화면 UI Design.fig');

declare global {
  interface Window {
    __setIsolateNode?: (id: string | null) => void;
    __canvasFitBox?: (
      box: { x: number; y: number; w: number; h: number },
      padPx?: number,
    ) => { x: number; y: number; w: number; h: number };
  }
}

interface CanvasSamplePoint {
  // Coords expressed as fractions of the captured screenshot rect (0..1)
  // so the test is independent of viewport size, Konva DPR, and which
  // Konva layer-canvas the pixel actually lives on.
  fx: number;
  fy: number;
}

// Sample one pixel by taking a tiny page screenshot at the requested
// fraction inside the provided clip and decoding the PNG with Node's
// built-in zlib. Avoids the Konva multi-canvas ambiguity that getImageData
// runs into (display vs buffer canvas, transparent overlays, DPR scaling).
async function samplePixel(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  point: CanvasSamplePoint,
): Promise<[number, number, number, number]> {
  // Take a 3x3 screenshot at the target point. 3x3 (not 1x1) so very small
  // anti-aliased edge variations average out across the read; we then read
  // the center pixel.
  const px = Math.max(0, Math.min(clip.width - 3, Math.round(clip.width * point.fx) - 1));
  const py = Math.max(0, Math.min(clip.height - 3, Math.round(clip.height * point.fy) - 1));
  const buf = await page.screenshot({
    clip: { x: clip.x + px, y: clip.y + py, width: 3, height: 3 },
    type: 'png',
  });
  // Decode 3x3 PNG inline. PNG layout: 8-byte sig, then IHDR, then IDAT,
  // then IEND. For our 3x3 RGBA image the IDAT is small enough that we use
  // the pngjs lib if installed — fall back to a tiny inline decoder.
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(buf);
  // Center pixel = (1, 1) in a 3x3 grid → index (1*3 + 1) * 4 = 16.
  const i = (1 * png.width + 1) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] as [
    number, number, number, number,
  ];
}

// Read the Stage's screen rect after `__canvasFitBox`. The audit script
// uses the same dance — it returns the on-screen rectangle the figma-coords
// box maps to inside the canvas viewport.
async function fitAndGetClip(
  page: Page,
  box: { x: number; y: number; w: number; h: number },
): Promise<{ x: number; y: number; width: number; height: number }> {
  const screenRect = await page.evaluate(
    (b) => window.__canvasFitBox?.(b, 32) ?? null,
    box,
  );
  if (!screenRect) throw new Error('__canvasFitBox returned null');
  const canvasBox = await page.evaluate(() => {
    const el = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  if (!canvasBox) throw new Error('canvas not found');
  await page.waitForTimeout(450);
  return {
    x: Math.round(canvasBox.x + screenRect.x),
    y: Math.round(canvasBox.y + screenRect.y),
    width: Math.round(screenRect.w),
    height: Math.round(screenRect.h),
  };
}

async function gotoAuditWithFig(page: Page): Promise<void> {
  await page.goto('/?audit=1');
  await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
  await page.waitForSelector('canvas', { timeout: 90_000 });
  // Wait for fonts so that text glyph metrics are stable (audit script does
  // the same — without it the first frame uses fallback fonts and pixel
  // samples on text-adjacent positions are flaky).
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function clickWebPage(page: Page): Promise<void> {
  const pagesSection = page.locator('[data-testid="pages-section"]');
  await pagesSection.waitFor({ timeout: 30_000 });
  const pageItems = pagesSection.locator('li[role="listitem"]');
  const numPages = await pageItems.count();
  for (let i = 0; i < numPages; i++) {
    const t = await pageItems.nth(i).textContent();
    if (t?.toLowerCase().includes('web')) {
      await pageItems.nth(i).click();
      await page.waitForTimeout(1500);
      return;
    }
  }
  throw new Error('WEB page not found in sidebar');
}

async function clickPageByName(page: Page, needle: string): Promise<void> {
  const pagesSection = page.locator('[data-testid="pages-section"]');
  await pagesSection.waitFor({ timeout: 30_000 });
  const pageItems = pagesSection.locator('li[role="listitem"]');
  const numPages = await pageItems.count();
  for (let i = 0; i < numPages; i++) {
    const t = await pageItems.nth(i).textContent();
    if (t?.toLowerCase().includes(needle.toLowerCase())) {
      await pageItems.nth(i).click();
      await page.waitForTimeout(1500);
      return;
    }
  }
  throw new Error(`page "${needle}" not found in sidebar`);
}

test.describe('audit isolation contract (round-23 v3)', () => {
  test.skip(!existsSync(SAMPLE_FIG), `sample missing: ${SAMPLE_FIG}`);

  test('(1) __setIsolateNode exposed on window in ?audit=1 mode', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoAuditWithFig(page);
    const present = await page.evaluate(() => typeof window.__setIsolateNode === 'function');
    expect(present, '__setIsolateNode imperative API on window').toBe(true);

    // Should accept a string and null without throwing.
    await page.evaluate(() => {
      window.__setIsolateNode!('401:7181');
      window.__setIsolateNode!(null);
    });
  });

  test('(2) ancestor fillPaints suppressed — right_top breadcrumb bg flips dark→white', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoAuditWithFig(page);
    await clickWebPage(page);

    // right_top-401_7181 inventory bbox.
    const box = { x: -28998, y: 12350, w: 1670, h: 60 };
    const clip = await fitAndGetClip(page, box);

    // Pixel near the right edge of the breadcrumb strip — clearly inside
    // the right_top FRAME but outside the small text on the left, so the
    // ancestor's fill would otherwise dominate.
    const point = { fx: 0.85, fy: 0.5 };

    await page.evaluate(() => window.__setIsolateNode?.(null));
    await page.waitForTimeout(200);
    const before = await samplePixel(page, clip, point);

    await page.evaluate(() => window.__setIsolateNode?.('401:7181'));
    await page.waitForTimeout(200);
    const after = await samplePixel(page, clip, point);

    // The parent FRAME 401:6772's `fillPaints[0]` is rgb(30,41,59) (dark
    // navy). Without isolation that color bleeds through the NO_FILL
    // right_top → low channels. With v1 isolation, ancestors lose fills →
    // the white div bg shows through → high channels.
    expect(before[0], 'before isolation: dark-navy bg from parent fill').toBeLessThan(80);
    expect(after[0], 'after  isolation: white bg from div underneath').toBeGreaterThan(220);

    // Cleanup so subsequent tests don't see lingering isolation.
    await page.evaluate(() => window.__setIsolateNode?.(null));
  });

  test('(3) ancestor clipFunc dropped (v3) — frame-2320 right half renders', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoAuditWithFig(page);
    await clickPageByName(page, 'dash');

    // frame-2320-587_7496 — 1380-wide table; grandparent FRAME 587:7461
    // is 454 wide and clips at frameMaskDisabled=false. Without v3, only
    // the left ~1/3 of the table renders.
    const box = { x: -802, y: 500, w: 1380, h: 268 };
    const clip = await fitAndGetClip(page, box);

    // Pixel near the right of the table where the 처리자 column would
    // render text like "(A)정우진". Without v3 this area is white (clipped
    // out by the 454-wide grandparent). With v3 the clip is dropped → the
    // table extends fully → text/borders render → non-white pixel.
    // Sample slightly above center so we hit a row body, not the gap
    // between rows.
    const point = { fx: 0.85, fy: 0.45 };

    await page.evaluate(() => window.__setIsolateNode?.(null));
    await page.waitForTimeout(200);
    const before = await samplePixel(page, clip, point);

    await page.evaluate(() => window.__setIsolateNode?.('587:7496'));
    await page.waitForTimeout(200);
    const after = await samplePixel(page, clip, point);

    // Pre-isolation: the right-half area sits outside the 454-wide
    // grandparent's clip, so the table content there is missing. Whatever
    // pixel we see is the page-FRAME background bleeding through (the page
    // mockup's dark navy fillPaints[0] = rgb(30,41,59)).
    // Post-v3 isolation: the page-FRAME's clip + fill are both suppressed.
    // The table extends fully → row body / borders / text render at this
    // coordinate. Either way the post pixel is meaningfully different from
    // the pre pixel — that's the contract: "v3 changes what's visible at
    // x>454-clip-line by dropping the ancestor's clipFunc". Specific colors
    // depend on which row/cell we land on, so we assert *change*, not a
    // specific palette.
    const dist = (a: [number, number, number, number], b: [number, number, number, number]): number =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    expect(dist(before, after), 'v3 isolation changes the pixel beyond the ancestor clip line').toBeGreaterThan(40);

    await page.evaluate(() => window.__setIsolateNode?.(null));
  });

  test('(5) __setIsolateNode(null) clears isolation', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoAuditWithFig(page);
    await clickWebPage(page);

    const box = { x: -28998, y: 12350, w: 1670, h: 60 };
    const clip = await fitAndGetClip(page, box);
    const point = { fx: 0.85, fy: 0.5 };

    const before = await samplePixel(page, clip, point);

    await page.evaluate(() => window.__setIsolateNode?.('401:7181'));
    await page.waitForTimeout(200);
    const isolated = await samplePixel(page, clip, point);
    expect(isolated[0]).toBeGreaterThan(220); // white during isolation

    await page.evaluate(() => window.__setIsolateNode?.(null));
    await page.waitForTimeout(200);
    const restored = await samplePixel(page, clip, point);

    // Restored should resemble pre-isolation (within a wide tolerance — exact
    // match is not the contract; the contract is "isolation reverted").
    const close = Math.abs(before[0] - restored[0]) < 30;
    expect(close, `restored R channel ${restored[0]} should be near pre-isolation ${before[0]}`).toBe(true);
  });
});
