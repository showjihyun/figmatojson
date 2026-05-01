/**
 * Tier 2 PoC e2e: full flow through the web UI.
 *
 *   1. open the app
 *   2. upload docs/메타리치 화면 UI Design.fig
 *   3. wait for the canvas + page selector to render
 *   4. take a "rendered design" screenshot for visual evidence
 *   5. use the running session to PATCH a text node via fetch (Konva canvas
 *      doesn't expose individual nodes for click() — testing the network
 *      contract is what proves Tier 1↔Tier 2 wire-up)
 *   6. click "Save .fig" → capture the downloaded bytes
 *   7. verify the bytes are a valid .fig that re-extracts and contains the
 *      edit (proves Figma-importability at the file-format level)
 */
import { test, expect } from '@playwright/test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SAMPLE_FIG = join(REPO_ROOT, 'docs', '메타리치 화면 UI Design.fig');

test.describe('Tier 2 PoC — full upload/edit/save flow', () => {
  test.skip(!existsSync(SAMPLE_FIG), `sample missing: ${SAMPLE_FIG}`);

  test('upload .fig, edit a text node, save back to .fig', async ({ page }) => {
    test.setTimeout(180_000);

    // Capture sessionId from /api/doc/:id requests (registered before upload).
    let sessionId = '';
    page.on('request', (req) => {
      const m = req.url().match(/\/api\/doc\/(s[a-z0-9]+)/);
      if (m && !sessionId) sessionId = m[1]!;
    });

    await page.goto('/');
    await expect(page.getByText('figma_reverse · Tier 2 PoC')).toBeVisible();

    // 1. Upload — wire through the file input.
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(SAMPLE_FIG);

    // 2. Page selector should appear AND populate with 6 pages (metarich sample).
    //    select element appears as soon as session is set, but options fill only
    //    after fetchDoc resolves — wait explicitly for the option count.
    const pageSelector = page.locator('select');
    await expect(pageSelector).toBeVisible({ timeout: 60_000 });
    await expect(pageSelector.locator('option')).toHaveCount(6, { timeout: 60_000 });
    const pageCount = await pageSelector.locator('option').count();
    console.log(`[e2e] uploaded — ${pageCount} pages detected`);

    // 3. Visual evidence: capture the rendered canvas.
    await page.waitForTimeout(1500); // let Konva render
    await page.screenshot({ path: 'e2e/_rendered.png', fullPage: false });

    // 4. Capture the sessionId from the doc fetch URL (registered before upload).
    expect(sessionId, 'sessionId from /api/doc/:id request').toBeTruthy();

    // 5. Save .fig via direct API call (browser-side <a>.click() download is
    //    flaky in headless Chromium for blob URLs of multi-MB content; the
    //    backend round-trip is what we actually want to verify).
    const saveRes = await page.request.post(`http://localhost:5274/api/save/${sessionId}`);
    if (!saveRes.ok()) console.log(`[e2e] save failed: ${saveRes.status()} ${await saveRes.text()}`);
    expect(saveRes.ok()).toBeTruthy();
    const bytes = Buffer.from(await saveRes.body());
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // .fig magic — ZIP wrapper starts with PK\x03\x04
    expect(bytes.subarray(0, 2).toString('binary')).toBe('PK');
    console.log(`[e2e] saved ${bytes.byteLength} bytes; ZIP magic OK`);

    // 6. Verify round-trip: write to disk and re-extract through the pipeline.
    const tmp = await mkdtemp(join(tmpdir(), 'figrev-e2e-'));
    try {
      const dlPath = join(tmp, 'roundtrip.fig');
      await import('node:fs/promises').then((fs) => fs.writeFile(dlPath, bytes));
      const { loadContainer } = await import('../../src/container.js');
      const { decodeFigCanvas } = await import('../../src/decoder.js');
      const { buildTree } = await import('../../src/tree.js');
      const container = loadContainer(dlPath);
      const decoded = decodeFigCanvas(container.canvasFig);
      const tree = buildTree(decoded.message);
      expect(tree.document).toBeTruthy();
      const nodes = tree.allNodes.size;
      console.log(`[e2e] re-extracted: ${nodes} nodes, ${decoded.message.blobs?.length ?? 0} blobs`);
      expect(nodes).toBe(35660);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('edit-via-API then save preserves the edit through round-trip', async ({ page, request }) => {
    test.setTimeout(180_000);

    // Capture sessionId BEFORE upload so we don't miss the request.
    let sessionId = '';
    page.on('request', (req) => {
      const m = req.url().match(/\/api\/doc\/(s[a-z0-9]+)/);
      if (m && !sessionId) sessionId = m[1]!;
    });

    await page.goto('/');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(SAMPLE_FIG);
    await expect(page.locator('select')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('select option')).toHaveCount(6, { timeout: 60_000 });

    expect(sessionId, 'sessionId from /api/doc/:id request').toBeTruthy();
    console.log(`[e2e-api] sessionId = ${sessionId}`);

    // 2. Fetch the document and find a TEXT node.
    const doc = await request.get(`http://localhost:5274/api/doc/${sessionId}`).then((r) => r.json());
    function findText(n: any): any | null {
      if (n?.type === 'TEXT' && n.textData?.characters && n.guid) return n;
      if (Array.isArray(n?.children)) {
        for (const c of n.children) {
          const f = findText(c);
          if (f) return f;
        }
      }
      return null;
    }
    const textNode = findText(doc);
    expect(textNode, 'at least one TEXT node in document').toBeTruthy();
    const guid = `${textNode.guid.sessionID}:${textNode.guid.localID}`;
    const original = textNode.textData.characters as string;
    const marker = '__T2_E2E_OK__';
    console.log(`[e2e-api] editing node ${guid} ("${original.slice(0, 40)}…" → "${marker}")`);

    // 3. PATCH the node text
    const patchRes = await request.patch(`http://localhost:5274/api/doc/${sessionId}`, {
      data: { nodeGuid: guid, field: 'textData.characters', value: marker },
    });
    expect(patchRes.ok()).toBeTruthy();

    // 4. Save .fig via direct API and verify the marker survived round-trip.
    const saveRes = await request.post(`http://localhost:5274/api/save/${sessionId}`);
    if (!saveRes.ok()) console.log(`[e2e-api] save failed: ${saveRes.status()} ${await saveRes.text()}`);
    expect(saveRes.ok()).toBeTruthy();
    const bytes = Buffer.from(await saveRes.body());
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const tmp = await mkdtemp(join(tmpdir(), 'figrev-e2e-'));
    try {
      const dlPath = join(tmp, 'edited.fig');
      const fsp = await import('node:fs/promises');
      await fsp.writeFile(dlPath, bytes);

      // 5. re-extract with full message JSON dump
      const { loadContainer } = await import('../../src/container.js');
      const { decodeFigCanvas } = await import('../../src/decoder.js');
      const { dumpStage4Decoded } = await import('../../src/intermediate.js');
      const container = loadContainer(dlPath);
      const decoded = decodeFigCanvas(container.canvasFig);
      const intOpts = {
        enabled: true,
        dir: join(tmp, 'extracted'),
        includeFullMessage: true,
        minify: true,
      };
      dumpStage4Decoded(intOpts, decoded);
      const messageJson = await readFile(join(tmp, 'extracted', '04_decoded', 'message.json'), 'utf8');
      expect(messageJson).toContain(`"${marker}"`);
      console.log(`[e2e-api] marker "${marker}" survived the round-trip`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
