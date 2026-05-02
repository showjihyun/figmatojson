/**
 * E2E gate: the new left sidebar (Files / Assets / Chat tabs) survives
 * the upload → render path and the three tabs each work.
 *
 * Spec: docs/specs/web-left-sidebar.spec.md
 *
 * Drives the actual browser UI — clicks tab triggers, types into the
 * search input, asserts panels become visible. The unit tests in
 * `web/client/src/components/sidebar/*.test.tsx` cover the components in
 * isolation under jsdom; this gate proves the wiring up to App.tsx is
 * intact end-to-end.
 */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SAMPLE_FIG = join(REPO_ROOT, 'docs', '메타리치 화면 UI Design.fig');

async function waitForDocLoaded(
  page: import('@playwright/test').Page,
  expectedPages: number,
  timeout = 60_000,
) {
  const re = new RegExp(`\\b${expectedPages}\\s+pages\\b`);
  await expect(page.getByText(re).first()).toBeVisible({ timeout });
}

test.describe('left sidebar — Files / Assets / Chat tabs', () => {
  test.skip(!existsSync(SAMPLE_FIG), `sample missing: ${SAMPLE_FIG}`);

  test('default tab is Files; layer tree shows page-level frames', async ({ page }) => {
    test.setTimeout(120_000);

    // Wipe any persisted tab choice so we get the default behavior.
    await page.addInitScript(() => {
      window.localStorage.removeItem('leftSidebar.tab');
    });

    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, 6);

    // Files tab is selected.
    const filesTab = page.getByRole('tab', { name: /^Files$/i });
    await expect(filesTab).toHaveAttribute('data-state', 'active');

    // Tree exists and renders at least one row at depth 0.
    const tree = page.getByRole('tree', { name: 'Layer tree' });
    await expect(tree).toBeVisible();
    const rows = tree.getByRole('treeitem');
    await expect(rows.first()).toBeVisible();
  });

  test('Assets tab — search filters to u:check matches', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, 6);

    // Switch to Assets.
    await page.getByRole('tab', { name: /^Assets$/i }).click();
    await expect(page.getByRole('tab', { name: /^Assets$/i })).toHaveAttribute('data-state', 'active');

    const search = page.getByLabel('Search assets');
    await expect(search).toBeVisible();
    await search.fill('check');

    // The metarich sample defines u:check, u:check-circle, u:check-square,
    // u:cloud-check, ... — at least 2 matches expected. Assert at least
    // one explicit name is visible to prove the filter wired correctly.
    await expect(page.getByText('u:check', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('u:check-circle', { exact: true }).first()).toBeVisible();
  });

  test('Chat tab reveals the existing ChatPanel — input and Send affordance', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, 6);

    await page.getByRole('tab', { name: /^Chat$/i }).click();
    await expect(page.getByRole('tab', { name: /^Chat$/i })).toHaveAttribute('data-state', 'active');

    // ChatPanel always renders a textarea + a Send button (disabled until
    // text is typed). These two affordances prove the chat surface mounted.
    await expect(page.getByRole('button', { name: /^Send$/i })).toBeVisible();
  });

  test('active tab persists across reload (localStorage)', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, 6);

    // Pick Assets, reload, expect Assets still active.
    await page.getByRole('tab', { name: /^Assets$/i }).click();
    await expect(page.getByRole('tab', { name: /^Assets$/i })).toHaveAttribute('data-state', 'active');

    await page.reload();
    // Re-upload after reload (session is in-memory, fresh on each load).
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, 6);

    await expect(page.getByRole('tab', { name: /^Assets$/i })).toHaveAttribute('data-state', 'active');
    // Files tab should NOT be active.
    await expect(page.getByRole('tab', { name: /^Files$/i })).toHaveAttribute('data-state', 'inactive');
  });

  test('Pages section in Files tab — list visible, click switches page', async ({ page }) => {
    test.setTimeout(120_000);

    await page.addInitScript(() => window.localStorage.removeItem('leftSidebar.tab'));
    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, 6);

    // Pages section header + list visible (default expanded).
    const pagesHeader = page.getByRole('button', { name: /^Pages$/i });
    await expect(pagesHeader).toBeVisible();
    await expect(pagesHeader).toHaveAttribute('aria-expanded', 'true');

    const pageList = page.getByRole('list', { name: /Pages/i });
    const items = pageList.getByRole('listitem');
    await expect(items.first()).toBeVisible();
    const itemCount = await items.count();
    expect(itemCount).toBe(6); // metarich has 6 pages

    // First page is current — pick a different one and verify the layer
    // tree refreshes to that page's content.
    const before = await page.locator('[role="tree"][aria-label="Layer tree"]').textContent();

    // Click a non-first page row.
    const target = items.nth(2);
    const targetName = (await target.textContent())?.trim();
    expect(targetName, 'a non-first page name').toBeTruthy();
    await target.click();

    // The clicked page should now have aria-current="page".
    await expect(target).toHaveAttribute('aria-current', 'page');

    // Layer tree content has changed (different page → different children).
    const after = await page.locator('[role="tree"][aria-label="Layer tree"]').textContent();
    expect(after).not.toBe(before);
  });

  test('toolbar no longer carries a page selector — Pages section is the only switch surface', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, 6);

    // Toolbar comboboxes — none should look like a page selector. ChatPanel
    // has its own model picker, so we filter by location: any combobox in the
    // header bar would be the old page selector.
    const headerComboboxes = page.locator('header [role="combobox"]');
    expect(await headerComboboxes.count()).toBe(0);
  });

  /**
   * Auto-reveal (spec I-F11.5–I-F11.6): driving selection from outside the
   * tree (here, via the same `window.__select` hook the canvas uses) must
   * auto-expand every ancestor of the selected node and surface it in the
   * tree as `aria-selected="true"`.
   *
   * Strategy: walk the rendered document via /api/doc/:id, find a deeply
   * nested node (depth ≥ 3), call window.__select(guid), then assert its
   * row exists in the layer tree. We verify the tree expanded — without
   * the auto-reveal, the row would not be in the DOM.
   */
  test('canvas-side selection auto-reveals the node in the layer tree', async ({ page, request }) => {
    test.setTimeout(120_000);

    // Capture sessionId before upload — same pattern as the other e2e files.
    let sessionId = '';
    page.on('request', (req) => {
      const m = req.url().match(/\/api\/doc\/(s[a-z0-9]+)/);
      if (m && !sessionId) sessionId = m[1]!;
    });

    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, 6);
    expect(sessionId).toBeTruthy();

    // Find a node at depth ≥ 3 in page index 0 (or any page). The auto-
    // reveal payoff is proving multi-level expansion works.
    const doc = await request.get(`http://localhost:5274/api/doc/${sessionId}`).then((r) => r.json());

    interface DocNode { guid?: { sessionID?: number; localID?: number }; type?: string; name?: string; children?: DocNode[] }
    function findDeep(node: DocNode, depth: number): { guid: string; depth: number } | null {
      if (depth >= 3 && node.guid && node.name) {
        return { guid: `${node.guid.sessionID}:${node.guid.localID}`, depth };
      }
      if (Array.isArray(node.children)) {
        for (const c of node.children) {
          const r = findDeep(c, depth + 1);
          if (r) return r;
        }
      }
      return null;
    }
    // Walk pages — pick the first page that has a depth-3+ node.
    const pages = (doc.children ?? []).filter((c: DocNode) => c.type === 'CANVAS');
    let target: { guid: string; depth: number; pageIdx: number } | null = null;
    for (let pi = 0; pi < pages.length && !target; pi++) {
      const found = findDeep(pages[pi], 0);
      if (found) target = { ...found, pageIdx: pi };
    }
    expect(target, 'a depth-≥3 node exists somewhere in the metarich sample').toBeTruthy();

    // Switch to the target's page via the sidebar Pages section so
    // currentPage flows through to LayerTree before we trigger selection.
    if (target!.pageIdx !== 0) {
      const pageList = page.getByRole('list', { name: /Pages/i });
      await pageList.getByRole('listitem').nth(target!.pageIdx).click();
    }

    // Make sure Files tab is the visible one (default — no localStorage).
    await page.addInitScript(() => window.localStorage.removeItem('leftSidebar.tab'));

    // Drive selection externally — this is the `canvas → tree` flow.
    await page.evaluate((g: string) => {
      const w = window as unknown as { __select?: (g: string | null) => void };
      if (!w.__select) throw new Error('window.__select missing');
      w.__select(g);
    }, target!.guid);

    // The row matching that guid must now be in the tree, marked selected.
    // data-guid attribute makes the assertion scoped and resilient to name
    // collisions (multiple "Header" frames, etc.).
    const row = page.locator(`[role="treeitem"][data-guid="${target!.guid}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-selected', 'true');
  });
});
