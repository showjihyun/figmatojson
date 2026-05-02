/**
 * Tier 2 PoC e2e: Undo/Redo round-trip via the live HTTP API.
 *
 * Spec: docs/specs/web-undo-redo.spec.md
 *
 * This complements the unit-level coverage in
 * `web/core/application/UndoRedo.test.ts` and the cumulative + interleave
 * blocks in `web/server/adapters/driven/applyTool.test.ts`. Those run
 * against in-memory fakes / disk-backed shims; this one drives the full
 * route → use case → journal → message.json path through the running
 * server, so it catches wiring breaks (deps registration, route handler
 * signatures, response shape) that the unit layer can't see.
 *
 * Scope: leaf-level undo/redo only (PATCH /api/doc → POST /api/undo →
 * POST /api/redo). Structural undo (sentinel patches from chat-tool
 * duplicate/group/ungroup) is exhaustively unit-tested but requires a
 * live Anthropic call to drive end-to-end, so it stays out of e2e.
 */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const SAMPLE_FIG = join(REPO_ROOT, 'docs', 'bvp.fig');

const BACKEND = 'http://localhost:5274';

async function waitForDocLoaded(
  page: import('@playwright/test').Page,
  expectedPages: number,
  timeout = 60_000,
) {
  // Same content-driven anchor as upload-edit-save.spec.ts. bvp.fig has 3
  // pages — see the perf-gate test there for that detail.
  const re = new RegExp(`\\b${expectedPages}\\s+pages\\b`);
  await expect(page.getByText(re).first()).toBeVisible({ timeout });
}

const BVP_PAGES = 3;

interface DocNode {
  type?: string;
  textData?: { characters?: string };
  guid?: { sessionID?: number; localID?: number };
  children?: DocNode[];
}

function findText(n: DocNode): DocNode | null {
  if (n?.type === 'TEXT' && n.textData?.characters && n.guid) return n;
  if (Array.isArray(n?.children)) {
    for (const c of n.children) {
      const f = findText(c);
      if (f) return f;
    }
  }
  return null;
}

async function getCharacters(
  request: import('@playwright/test').APIRequestContext,
  sessionId: string,
  guid: string,
): Promise<string | undefined> {
  const doc = (await request.get(`${BACKEND}/api/doc/${sessionId}`).then((r) => r.json())) as DocNode;
  const target = ((): DocNode | null => {
    function walk(n: DocNode): DocNode | null {
      const g = n.guid;
      if (g && `${g.sessionID}:${g.localID}` === guid) return n;
      if (Array.isArray(n.children)) for (const c of n.children) {
        const f = walk(c);
        if (f) return f;
      }
      return null;
    }
    return walk(doc);
  })();
  return target?.textData?.characters;
}

test.describe('Tier 2 PoC — Undo/Redo round-trip', () => {
  test.skip(!existsSync(SAMPLE_FIG), `sample missing: ${SAMPLE_FIG}`);

  test('leaf edit ×2 → undo ×2 → redo ×2; fresh edit clears future stack', async ({ page, request }) => {
    test.setTimeout(120_000);

    let sessionId = '';
    page.on('request', (req) => {
      const m = req.url().match(/\/api\/doc\/(s[a-z0-9]+)/);
      if (m && !sessionId) sessionId = m[1]!;
    });

    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, BVP_PAGES);
    expect(sessionId, 'sessionId from /api/doc/:id').toBeTruthy();

    // Pick the first TEXT node — its characters are the canary we'll bounce
    // between markers and the original.
    const doc = (await request.get(`${BACKEND}/api/doc/${sessionId}`).then((r) => r.json())) as DocNode;
    const target = findText(doc);
    expect(target, 'a TEXT node in the sample').toBeTruthy();
    const guid = `${target!.guid!.sessionID}:${target!.guid!.localID}`;
    const original = target!.textData!.characters!;
    expect(original.length).toBeGreaterThan(0);

    const patch = (value: string) =>
      request.patch(`${BACKEND}/api/doc/${sessionId}`, {
        data: { nodeGuid: guid, field: 'textData.characters', value },
      });

    // M1, M2 — two leaf edits land on the past stack.
    expect((await patch('UNDO_E2E_M1')).ok()).toBeTruthy();
    expect((await patch('UNDO_E2E_M2')).ok()).toBeTruthy();
    expect(await getCharacters(request, sessionId, guid)).toBe('UNDO_E2E_M2');

    // Undo #1 — back to M1, future depth = 1.
    let res = await request.post(`${BACKEND}/api/undo/${sessionId}`);
    let body = await res.json();
    expect(body).toMatchObject({ ok: true, undoneLabel: 'Edit', past: 1, future: 1 });
    expect(await getCharacters(request, sessionId, guid)).toBe('UNDO_E2E_M1');

    // Undo #2 — back to original, past=0, future=2.
    res = await request.post(`${BACKEND}/api/undo/${sessionId}`);
    body = await res.json();
    expect(body).toMatchObject({ ok: true, undoneLabel: 'Edit', past: 0, future: 2 });
    expect(await getCharacters(request, sessionId, guid)).toBe(original);

    // Empty-stack undo — I-5 / I-E2: ok=false, no throw, no state change.
    res = await request.post(`${BACKEND}/api/undo/${sessionId}`);
    body = await res.json();
    expect(body).toMatchObject({ ok: false, undoneLabel: null, past: 0, future: 2 });
    expect(await getCharacters(request, sessionId, guid)).toBe(original);

    // Redo #1 — climb back to M1, past=1, future=1.
    res = await request.post(`${BACKEND}/api/redo/${sessionId}`);
    body = await res.json();
    expect(body).toMatchObject({ ok: true, redoneLabel: 'Edit', past: 1, future: 1 });
    expect(await getCharacters(request, sessionId, guid)).toBe('UNDO_E2E_M1');

    // Redo #2 — climb to M2, past=2, future=0.
    res = await request.post(`${BACKEND}/api/redo/${sessionId}`);
    body = await res.json();
    expect(body).toMatchObject({ ok: true, redoneLabel: 'Edit', past: 2, future: 0 });
    expect(await getCharacters(request, sessionId, guid)).toBe('UNDO_E2E_M2');

    // Empty redo stack — symmetric of the empty-undo check.
    res = await request.post(`${BACKEND}/api/redo/${sessionId}`);
    body = await res.json();
    expect(body).toMatchObject({ ok: false, redoneLabel: null, past: 2, future: 0 });

    // I-1: a fresh record() must clear the future stack. Undo back to M1
    // first so future has 1 entry, then PATCH a new value — that record
    // must wipe the future.
    res = await request.post(`${BACKEND}/api/undo/${sessionId}`);
    body = await res.json();
    expect(body).toMatchObject({ ok: true, past: 1, future: 1 });

    expect((await patch('UNDO_E2E_BRANCH')).ok()).toBeTruthy();
    res = await request.post(`${BACKEND}/api/redo/${sessionId}`);
    body = await res.json();
    expect(body).toMatchObject({ ok: false, redoneLabel: null });
    expect(body.future).toBe(0);
    // past should now be the M1 edit + the BRANCH edit = 2 (M2 was popped
    // into future and then cleared by the BRANCH record).
    expect(body.past).toBe(2);
  });

  test('cross-session isolation — undo on session A does not affect B', async ({ page, request }) => {
    test.setTimeout(120_000);

    // Session A
    let sidA = '';
    page.on('request', (req) => {
      const m = req.url().match(/\/api\/doc\/(s[a-z0-9]+)/);
      if (m && !sidA) sidA = m[1]!;
    });
    await page.goto('/');
    await page.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(page, BVP_PAGES);
    expect(sidA).toBeTruthy();

    // Session B — separate browser context = separate session id.
    const ctxB = await page.context().browser()!.newContext();
    const pageB = await ctxB.newPage();
    let sidB = '';
    pageB.on('request', (req) => {
      const m = req.url().match(/\/api\/doc\/(s[a-z0-9]+)/);
      if (m && !sidB) sidB = m[1]!;
    });
    await pageB.goto('/');
    await pageB.locator('input[type="file"][accept=".fig"]').setInputFiles(SAMPLE_FIG);
    await waitForDocLoaded(pageB, BVP_PAGES);
    expect(sidB).toBeTruthy();
    expect(sidB).not.toBe(sidA);

    // Edit session A only.
    const docA = (await request.get(`${BACKEND}/api/doc/${sidA}`).then((r) => r.json())) as DocNode;
    const tgtA = findText(docA);
    expect(tgtA).toBeTruthy();
    const guidA = `${tgtA!.guid!.sessionID}:${tgtA!.guid!.localID}`;
    const origA = tgtA!.textData!.characters!;
    await request.patch(`${BACKEND}/api/doc/${sidA}`, {
      data: { nodeGuid: guidA, field: 'textData.characters', value: 'A_ONLY' },
    });

    // Undoing on B — there's nothing on B's stack, so ok=false.
    const undoB = await request.post(`${BACKEND}/api/undo/${sidB}`);
    expect(await undoB.json()).toMatchObject({ ok: false, past: 0, future: 0 });

    // A is still at A_ONLY (B's call didn't touch A's stack).
    expect(await getCharacters(request, sidA, guidA)).toBe('A_ONLY');

    // Now undo on A actually reverts A.
    const undoA = await request.post(`${BACKEND}/api/undo/${sidA}`);
    expect((await undoA.json()).ok).toBe(true);
    expect(await getCharacters(request, sidA, guidA)).toBe(origA);

    await ctxB.close();
  });
});
