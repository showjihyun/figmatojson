/**
 * spec: docs/specs/editable-html.spec.md
 *
 * 통합 테스트 — 실제 sample 파일로 풀 파이프라인 → invariants 검증
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectImageRefs } from '../src/assets.js';
import { loadContainer } from '../src/container.js';
import { decodeFigCanvas } from '../src/decoder.js';
import { generateEditableHtml } from '../src/editable-html.js';
import { exportAll } from '../src/export.js';
import { buildTree } from '../src/tree.js';

const SAMPLE = 'docs/메타리치 화면 UI Design.fig';

let tmp: string;

beforeAll(() => {
  if (!existsSync(SAMPLE)) throw new Error(`sample missing: ${SAMPLE}`);
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'figrev-eh-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('generateEditableHtml — invariants', () => {
  it('throws when no DOCUMENT root (E-1)', () => {
    const fakeTree = { document: null, allNodes: new Map(), orphans: [] };
    expect(() =>
      generateEditableHtml({
        tree: fakeTree as never,
        decoded: {} as never,
        container: {} as never,
        outputDir: tmp,
        htmlOutDir: tmp,
      }),
    ).toThrow(/no DOCUMENT root/);
  });

  it('I-1, I-2, I-4, I-5, I-6, I-7, I-8: end-to-end on real sample', async () => {
    // 1. Extract
    const c = loadContainer(SAMPLE);
    const d = decodeFigCanvas(c.canvasFig);
    const tree = buildTree(d.message);
    const refs = collectImageRefs(tree.document);
    const outputDir = join(tmp, 'output');
    await exportAll({
      outputDir,
      container: c,
      decoded: d,
      tree,
      imageRefs: refs,
      options: { minify: true, includeDocument: false, includeRawMessage: false, extractVectors: true },
    });

    // 2. Editable HTML 생성
    const htmlOutDir = join(tmp, 'editable');
    const result = generateEditableHtml({
      tree,
      decoded: d,
      container: c,
      outputDir,
      htmlOutDir,
    });

    // 3. invariants 검증
    expect(result.stats.totalNodes).toBe(35660);
    expect(result.stats.pages).toBe(6);
    expect(result.stats.sourceFigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.stats.schemaSha256).toMatch(/^[a-f0-9]{64}$/);

    // I-1: 모든 GUID가 HTML에 1번씩 — 단일 패스로 모든 data-figma-id 추출
    const html = require('node:fs').readFileSync(join(htmlOutDir, 'figma.editable.html'), 'utf8') as string;
    const idMatches = html.match(/data-figma-id="([^"]+)"/g) ?? [];
    const idCounts = new Map<string, number>();
    for (const m of idMatches) {
      const id = m.slice('data-figma-id="'.length, -1);
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    const expectedIds = new Set(tree.allNodes.keys());
    expect(idCounts.size).toBe(expectedIds.size);
    for (const guid of expectedIds) {
      expect(idCounts.get(guid)).toBe(1);
    }

    // I-5: 필수 attributes 존재 (DOCUMENT 노드)
    expect(html).toContain('data-figma-id="0:0"');
    expect(html).toContain('data-figma-type="DOCUMENT"');

    // I-7: 메타 attributes
    expect(html).toContain('data-figma-roundtrip="v2"');
    expect(html).toContain(`data-figma-archive-version="106"`);
    expect(html).toContain(`data-figma-source-fig-sha256="${result.stats.sourceFigSha256}"`);

    // I-8: 페이지 구조
    const pageMatches = html.match(/<section class="fig-page"/g);
    expect(pageMatches?.length).toBe(6);

    // README + CSS 생성됨
    expect(existsSync(join(htmlOutDir, 'README.md'))).toBe(true);
    expect(existsSync(join(htmlOutDir, 'figma.editable.css'))).toBe(true);

    // assets 복사됨
    expect(existsSync(join(htmlOutDir, 'assets', 'images'))).toBe(true);
    expect(existsSync(join(htmlOutDir, 'assets', 'thumbnail.png'))).toBe(true);
  });

  it('I-6: deterministic output (same input → same HTML)', async () => {
    const c = loadContainer(SAMPLE);
    const d = decodeFigCanvas(c.canvasFig);
    const tree = buildTree(d.message);
    const outputDir = join(tmp, 'output');
    const refs = collectImageRefs(tree.document);
    await exportAll({
      outputDir,
      container: c,
      decoded: d,
      tree,
      imageRefs: refs,
      options: { minify: true, includeDocument: false, includeRawMessage: false, extractVectors: true },
    });

    const dir1 = join(tmp, 'a');
    const dir2 = join(tmp, 'b');
    generateEditableHtml({ tree, decoded: d, container: c, outputDir, htmlOutDir: dir1 });
    generateEditableHtml({ tree, decoded: d, container: c, outputDir, htmlOutDir: dir2 });

    const fs = require('node:fs');
    const a = fs.readFileSync(join(dir1, 'figma.editable.html'));
    const b = fs.readFileSync(join(dir2, 'figma.editable.html'));
    expect(a.equals(b)).toBe(true);
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
