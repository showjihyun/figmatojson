/**
 * E2E gate: round-24 derivedSymbolData transform baking contract.
 *
 * Pins the visual outcome of round-24's transform baking on a known-
 * affected fixture. If a future Canvas / clientNode change silently
 * stops applying `derivedSymbolData[].transform` to descendants, the
 * audit baseline (commits 89bbaa5..ddad018 + the WEB refresh) starts
 * diverging from figma.png with no obvious owner — same failure mode
 * round-23's isolation gate guards against.
 *
 * Round-24 commit chain:
 *   89bbaa5  feat: spec §3.10 + collector + walk plumbing + 13 unit tests
 *   71f33d0  chore(audit): design-setting baseline (1 win — labe leak)
 *   f493bd8  chore(audit): dash-board   baseline (round-23 frame-2320 OK)
 *   ddad018  chore(audit): mobile       baseline (1 MAJOR win — 5th row)
 *   THIS     test gate covering the 5th-row contract
 *
 * Concrete fixture: mobile/frame-2323-477_6439 — a 5-row customer-list
 * INSTANCE. Pre round-24 only 4 rows rendered; the 5th was placed at
 * its master coord (past the INSTANCE bbox bottom) and INSTANCE
 * auto-clip cut it off. Post round-24 Figma's derivedSymbolData entry
 * for the 5th-row descendant supplies the packed transform.m12 inside
 * the bbox, so the row renders.
 *
 * Spec: docs/specs/web-instance-autolayout-reflow.spec.md §3.10
 *       I-DT1..I-DT5.
 *
 * Pixel-sampling note: same approach as audit-isolation.spec.ts —
 * page.screenshot({clip:3x3}) + pngjs decode dodges Konva's multi-canvas
 * ambiguity (display vs buffer; selection/hover overlays). See that
 * file for the rationale.
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
  fx: number;
  fy: number;
}

async function samplePixel(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  point: CanvasSamplePoint,
): Promise<[number, number, number, number]> {
  const px = Math.max(0, Math.min(clip.width - 3, Math.round(clip.width * point.fx) - 1));
  const py = Math.max(0, Math.min(clip.height - 3, Math.round(clip.height * point.fy) - 1));
  const buf = await page.screenshot({
    clip: { x: clip.x + px, y: clip.y + py, width: 3, height: 3 },
    type: 'png',
  });
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(buf);
  const i = (1 * png.width + 1) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] as [
    number, number, number, number,
  ];
}

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
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
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

test.describe('audit transform baking contract (round-24)', () => {
  test.skip(!existsSync(SAMPLE_FIG), `sample missing: ${SAMPLE_FIG}`);

  test('mobile/frame-2323-477_6439 — 5th customer row renders inside INSTANCE bbox', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoAuditWithFig(page);
    await clickPageByName(page, 'mobile');

    // Inventory bbox for FRAME 477:6439 (5-row customer list).
    const box = { x: -3349, y: -1245, w: 360, h: 488 };
    const clip = await fitAndGetClip(page, box);

    // Each row card is ~80px tall in the 488-px frame (5 rows + spacing).
    // Top-of-card-5 sits at y ≈ 380 (fy ≈ 0.78). The row's left-side
    // text "고경수" renders in dark slate (~rgb(28, 41, 64)) on a near-
    // white card bg. We sample at the customer-name baseline:
    //   fx = 0.18 → ~65 px from card's left edge → middle of "고경수"
    //   fy = 0.81 → middle of row 5's top text line
    //
    // Pre round-24 contract: this pixel was empty container bg (the
    //   5th row sat at master coord, past the INSTANCE bottom edge,
    //   and was auto-clipped). The fixture's PNG was 8076 bytes
    //   smaller as a result — that delta is the row's content.
    // Post round-24 contract: derivedTransform places the row inside
    //   the bbox → text/badge render → this pixel is dark-text or
    //   dark-text antialiased halo.
    const point = { fx: 0.18, fy: 0.81 };
    const pixel = await samplePixel(page, clip, point);

    // Assert: the pixel is NOT near-white. We don't pin a specific dark
    // value because anti-aliased text edges range across many channels;
    // the contract is "row content rendered" = "not the empty bg".
    // The card bg is ≈ rgb(255, 255, 255). Empty container is the page
    // wrapper bg ≈ rgb(229, 231, 234) (light gray). Either way both
    // are >220 on R; text/badge brings it well below.
    const r = pixel[0];
    expect(
      r,
      '5th row text must render (non-near-white) — derivedTransform contract per spec §3.10 I-DT2',
    ).toBeLessThan(220);
  });
});

/**
 * Round-25 path-key normalization contract.
 *
 * Pins the alret modal regression resolved by round-25 (commits 28989be
 * + 721c779). Pre-round-25 our walk used the full visit chain for
 * path-key matching, so the visibility override [60:341] (hide the 취소
 * Button INSTANCE inside the alret SYMBOL's "buttons" FRAME 60:348)
 * silently failed — we computed key "60:348/60:341" but Figma stamps
 * `[60:341]`. Round-25 skips non-INSTANCE container ancestors from the
 * key, so the override resolves and 취소 is hidden as Figma intended.
 *
 * Spec: web-instance-render-overrides.spec.md §3.1 I-C1, §3.2 I-P2 (v3).
 *
 * Concrete fixture: web/alret-364_2962 — alret SYMBOL master 64:376
 * instantiated as INSTANCE 364:2962. Variant override sets header to
 * "DB분배", body to a completion message, hides 취소, leaves only
 * the 삭제 button visible at the right edge of the 330×170 modal.
 */
test.describe('audit path-key contract (round-25)', () => {
  test.skip(!existsSync(SAMPLE_FIG), `sample missing: ${SAMPLE_FIG}`);

  test('web/alret-364_2962 — 삭제 button renders fully inside modal (visibility override + size baking align)', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoAuditWithFig(page);
    await clickWebPage(page);

    // Inventory bbox for INSTANCE 364:2962 (alret modal). 330×170.
    const box = { x: -17488, y: 4135, w: 330, h: 170 };
    const clip = await fitAndGetClip(page, box);

    // The 삭제 button is the only one that should render under round-25
    // (취소 hidden by visibility override [60:341]). It's a blue pill
    // near the bottom-right of the modal — center sits roughly at:
    //   absolute x in modal ≈ 286 (m02 of buttons FRAME post-derivedSize
    //     baking is 262, button width 48, so center = 262 + 24 = 286)
    //   absolute y ≈ 134 (m12 = 118, height = 32, center = 134)
    // → fractional fx ≈ 0.866, fy ≈ 0.788 within the 330×170 clip.
    //
    // Pre round-25 contract: at this point, the 삭제 button was clipped
    //   past the modal's right edge (the (round-22 derived) buttons
    //   FRAME was 48 wide, but our pipeline left BOTH master buttons
    //   inside it because [60:341]'s visibility override didn't match).
    //   Sampling here landed on the page background or modal-edge gray.
    // Post round-25 contract: 취소 hidden, 삭제 derivedTransform places
    //   it at FRAME's left edge (m02=0 inside FRAME), so the button
    //   spans within the modal bbox. Sample point lands inside the
    //   solid-blue button background.
    const point = { fx: 0.866, fy: 0.788 };
    const pixel = await samplePixel(page, clip, point);

    // 삭제 button bg is the project's primary blue (Pretendard primary,
    // approximately rgb(76, 120, 248)). Assert blue dominates: B > R AND
    // B > G AND B > 200. Pre-fix, this position would either be page
    // dark-navy bg (R≈30, G≈41, B≈59 — B not > 200) or modal white
    // (R≈G≈B≈255 — B not > R, equal).
    const [r, g, b] = pixel;
    expect(
      b > r && b > g && b > 200,
      `삭제 button blue must be visible — round-25 path-key contract per spec §3.1 I-C1. Got rgb(${r},${g},${b}).`,
    ).toBe(true);
  });
});
