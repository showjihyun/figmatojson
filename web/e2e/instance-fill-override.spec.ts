/**
 * E2E gate: instance fill overrides survive the upload → decode → expand
 * pipeline and surface in `_renderChildren` for the canvas to draw.
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md
 *
 * Concrete fixture (data-driven from `메타리치 화면 UI Design.fig`):
 *  - INSTANCE  7:181  (name: "u:sign-out-alt")
 *  - master    4:19839 (SYMBOL "u:sign-out-alt")
 *  - override  → descendant 4:18548 fillPaints = white {r:1, g:1, b:1, a:1}
 *
 * This is the same kind of override that all 402 u:* icon instances in the
 * sample carry; if the renderer reads it correctly here, the fix lands for
 * every button-with-icon in the design.
 */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SAMPLE_FIG = join(REPO_ROOT, 'docs', '메타리치 화면 UI Design.fig');

const BACKEND = 'http://localhost:5274';

interface DocNode {
  guid?: { sessionID?: number; localID?: number };
  type?: string;
  name?: string;
  fillPaints?: Array<{ color?: { r: number; g: number; b: number; a: number } }>;
  children?: DocNode[];
  _renderChildren?: DocNode[];
}

function findByGuid(root: DocNode, target: string): DocNode | null {
  const stack: DocNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const g = n.guid;
    if (g && `${g.sessionID}:${g.localID}` === target) return n;
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
    if (Array.isArray(n._renderChildren)) for (const c of n._renderChildren) stack.push(c);
  }
  return null;
}

function findInRenderChildren(root: DocNode, target: string): DocNode | null {
  // Walk only into _renderChildren — used to verify a node only exists in
  // the per-instance expansion, not the master itself.
  if (!Array.isArray(root._renderChildren)) return null;
  const stack: DocNode[] = [...root._renderChildren];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const g = n.guid;
    if (g && `${g.sessionID}:${g.localID}` === target) return n;
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
    if (Array.isArray(n._renderChildren)) for (const c of n._renderChildren) stack.push(c);
  }
  return null;
}

test.describe('instance fill-override propagation (metarich u:* icons)', () => {
  test.skip(!existsSync(SAMPLE_FIG), `sample missing: ${SAMPLE_FIG}`);

  test('u:sign-out-alt instance carries the white-color override down to its vector', async ({ request }) => {
    test.setTimeout(180_000);

    // API-level upload — UI flow is exercised by other e2e tests; here we
    // care about the data shape that GET /api/doc/:id returns.
    const fsp = await import('node:fs/promises');
    const buf = await fsp.readFile(SAMPLE_FIG);
    const upload = await request.post(`${BACKEND}/api/upload`, {
      multipart: { file: { name: 'metarich.fig', mimeType: 'application/octet-stream', buffer: buf } },
    });
    expect(upload.ok()).toBeTruthy();
    const uploadBody = await upload.json();
    const sessionId = uploadBody.sessionId as string;
    expect(sessionId).toBeTruthy();

    const doc = (await request.get(`${BACKEND}/api/doc/${sessionId}`).then((r) => r.json())) as DocNode;

    // Step 1: locate INSTANCE 7:181 anywhere in the tree.
    const instance = findByGuid(doc, '7:181');
    expect(instance, 'INSTANCE 7:181 (u:sign-out-alt) present in /api/doc tree').toBeTruthy();
    expect(instance!.type).toBe('INSTANCE');
    // The instance should have _renderChildren attached (master expanded).
    expect(Array.isArray(instance!._renderChildren)).toBe(true);
    expect(instance!._renderChildren!.length).toBeGreaterThan(0);

    // Step 2: locate descendant 4:18548 INSIDE this instance's expansion only —
    // confirms it's the per-instance copy, not the master itself.
    const target = findInRenderChildren(instance!, '4:18548');
    expect(target, 'master descendant 4:18548 expanded under instance 7:181').toBeTruthy();

    // Step 3: the override was {r:1, g:1, b:1, a:1} (white). Without our fix
    // the master's original fill would surface here (some non-white color).
    const fps = target!.fillPaints;
    expect(Array.isArray(fps) && fps.length > 0).toBe(true);
    const c = fps![0].color;
    expect(c).toBeDefined();
    expect(c!.r).toBe(1);
    expect(c!.g).toBe(1);
    expect(c!.b).toBe(1);
    expect(c!.a).toBe(1);
  });

  /**
   * Multi-step path coverage — the calendar Dropdown (INSTANCE 15:279)
   * has 6 text overrides whose guidPath is length-2. The earlier single-
   * step lookup collapsed several of them onto the same key and dropped
   * "오늘"/"최근 1주일"/etc — users saw "Option 1" everywhere. This gate
   * proves path-keyed overrides recover those labels end-to-end.
   *
   * Known limit: the 6th option ("직접 선택") uses Figma's *variant swap*
   * (an override that replaces the rendered master with a different
   * variant, then overrides a TEXT belonging to that variant). Variant
   * swap is unimplemented — the 6th option stays at its master "Option 1"
   * for now. That's tracked separately; this gate covers the path-keyed
   * fix (5/6 labels recovered).
   *
   * Spec: docs/specs/web-instance-render-overrides.spec.md §3.1 / §3.2.
   */
  test('multi-step text overrides — calendar Dropdown shows Korean labels', async ({ request }) => {
    test.setTimeout(180_000);
    const fsp = await import('node:fs/promises');
    const buf = await fsp.readFile(SAMPLE_FIG);
    const upload = await request.post(`${BACKEND}/api/upload`, {
      multipart: { file: { name: 'metarich.fig', mimeType: 'application/octet-stream', buffer: buf } },
    });
    const sessionId = (await upload.json()).sessionId as string;

    const doc = (await request.get(`${BACKEND}/api/doc/${sessionId}`).then((r) => r.json())) as DocNode;

    // Collect ALL _renderTextOverride values inside INSTANCE 15:279's
    // expansion. Walk only _renderChildren so we stay inside the per-
    // instance expansion (not the master tree itself).
    const dropdown = findByGuid(doc, '15:279');
    expect(dropdown, 'INSTANCE 15:279 (Dropdown) present').toBeTruthy();
    const overrides: string[] = [];
    function walkRender(n: DocNode | undefined): void {
      if (!n) return;
      const ov = (n as { _renderTextOverride?: string })._renderTextOverride;
      if (typeof ov === 'string') overrides.push(ov);
      const children = (n as { children?: DocNode[]; _renderChildren?: DocNode[] });
      if (Array.isArray(children._renderChildren)) for (const c of children._renderChildren) walkRender(c);
      if (Array.isArray(children.children)) for (const c of children.children) walkRender(c);
    }
    walkRender(dropdown);

    // Path-keyed overrides recover the 5 labels whose target TEXT lives
    // in the same master tree the renderer expands. Without path keys
    // these collide on guid 11:506 and only one survives.
    const directLabels = ['오늘', '최근 1주일', '최근 30일', '금월', '전월'];
    for (const lbl of directLabels) {
      expect(overrides, `label "${lbl}" should be applied as a render override`).toContain(lbl);
    }
    // Distinct overrides (no collisions): at least 5 unique strings.
    expect(new Set(overrides).size).toBeGreaterThanOrEqual(5);
  });

  test('master node 4:18548 is unchanged — override only lives on the per-instance copy', async ({ request }) => {
    test.setTimeout(180_000);

    const fsp = await import('node:fs/promises');
    const buf = await fsp.readFile(SAMPLE_FIG);
    const upload = await request.post(`${BACKEND}/api/upload`, {
      multipart: { file: { name: 'metarich.fig', mimeType: 'application/octet-stream', buffer: buf } },
    });
    const sessionId = (await upload.json()).sessionId as string;

    const doc = (await request.get(`${BACKEND}/api/doc/${sessionId}`).then((r) => r.json())) as DocNode;

    // Locate master 4:18548 (the descendant under the original SYMBOL master,
    // not under any INSTANCE expansion). The walker `findByGuid` above hits
    // the first occurrence — for a master that's defined once in the tree,
    // that occurrence is the master itself. But _renderChildren copies share
    // the same guid, so we walk only `children` (master tree).
    function walkMasterOnly(n: DocNode): DocNode | null {
      const stack: DocNode[] = [n];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        const g = cur.guid;
        if (g && `${g.sessionID}:${g.localID}` === '4:18548') return cur;
        if (Array.isArray(cur.children)) for (const c of cur.children) stack.push(c);
        // Skip _renderChildren — we want the master, not the instance copy.
      }
      return null;
    }

    const master = walkMasterOnly(doc);
    expect(master, 'master node 4:18548 reachable through the document tree').toBeTruthy();
    // Master's fillPaints must still hold whatever the design system set —
    // anything BUT the white-on-white {1,1,1,1} that the override carries.
    // (We don't assert the exact master color since it can evolve with the
    // source file; we just assert the override hasn't bled through onto it.)
    const masterFills = master!.fillPaints;
    if (Array.isArray(masterFills) && masterFills.length > 0 && masterFills[0].color) {
      const mc = masterFills[0].color;
      const isPureWhite = mc.r === 1 && mc.g === 1 && mc.b === 1 && mc.a === 1;
      expect(isPureWhite, 'master must NOT have the per-instance override color baked in').toBe(false);
    }
  });
});
