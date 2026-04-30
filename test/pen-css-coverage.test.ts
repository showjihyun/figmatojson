/**
 * Regression guard for pen export CSS coverage.
 *
 * Runs `generatePenExport` on the real sample .fig, then compares the produced
 * `00_design setting.pen` against `docs/메타리치 화면 UI Design.pen` (reference
 * conversion produced by Pencil itself).
 *
 * For every (type, name, width, height) signature that is unambiguous in both
 * files, compare ALL property values and tally mismatches per node-type bucket.
 * Assert mismatch counts stay below thresholds calibrated from the current
 * known-good state (with comfortable slack for legitimate drift).
 *
 * Single-fork e2e test — runs the full pen export (~2s on sample) and the
 * audit (<100ms) inline. Catches any regression in CSS field emission, value
 * format, unit conversion, or styleIdForText resolution.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadContainer } from '../src/container.js';
import { decodeFigCanvas } from '../src/decoder.js';
import { generatePenExport } from '../src/pen-export.js';
import { buildTree } from '../src/tree.js';

const SAMPLE = 'docs/메타리치 화면 UI Design.fig';
const REF_PEN = 'docs/메타리치 화면 UI Design.pen';

let tmp: string;
beforeAll(() => {
  if (!existsSync(SAMPLE)) throw new Error(`sample missing: ${SAMPLE}`);
  if (!existsSync(REF_PEN)) throw new Error(`reference .pen missing: ${REF_PEN}`);
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'figrev-css-cov-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface AnyNode {
  type?: string;
  name?: string;
  width?: number | string;
  height?: number | string;
  children?: AnyNode[];
  [k: string]: unknown;
}

function* walk(n: AnyNode | undefined): Generator<AnyNode> {
  if (!n || typeof n !== 'object') return;
  yield n;
  if (Array.isArray(n.children)) for (const c of n.children) yield* walk(c);
}

function sig(n: AnyNode): string {
  return [
    n.type,
    n.name ?? '',
    typeof n.width === 'number' ? Math.round(n.width) : (n.width ?? ''),
    typeof n.height === 'number' ? Math.round(n.height) : (n.height ?? ''),
  ].join('|');
}

interface AuditBucket {
  pairs: number;
  totalProps: number;
  mismatches: number;
  /** key → mismatch count, for diagnostics */
  byKey: Record<string, number>;
}

function audit(refDoc: AnyNode, oursDoc: AnyNode): { byType: Record<string, AuditBucket>; pairs: number } {
  const A = new Map<string, AnyNode[]>();
  const B = new Map<string, AnyNode[]>();
  for (const n of walk(refDoc)) {
    if (!n.type) continue;
    const s = sig(n);
    if (!A.has(s)) A.set(s, []);
    A.get(s)!.push(n);
  }
  for (const n of walk(oursDoc)) {
    if (!n.type) continue;
    const s = sig(n);
    if (!B.has(s)) B.set(s, []);
    B.get(s)!.push(n);
  }

  const byType: Record<string, AuditBucket> = {};
  let pairs = 0;
  for (const [s, refs] of A) {
    const ours = B.get(s);
    if (!ours || refs.length !== 1 || ours.length !== 1) continue;
    const a = refs[0]!;
    const b = ours[0]!;
    const t = a.type!;
    if (!byType[t]) byType[t] = { pairs: 0, totalProps: 0, mismatches: 0, byKey: {} };
    byType[t]!.pairs++;
    pairs++;
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of allKeys) {
      if (k === 'id' || k === 'children') continue;
      byType[t]!.totalProps++;
      const inA = k in a, inB = k in b;
      if (!inA || !inB || JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        byType[t]!.mismatches++;
        byType[t]!.byKey[k] = (byType[t]!.byKey[k] ?? 0) + 1;
      }
    }
  }
  return { byType, pairs };
}

describe('pen export CSS coverage (regression guard)', () => {
  it('matches the reference .pen on >= 98.5% of property values for the design-setting page', async () => {
    // Run pen-export on the real sample
    const container = loadContainer(SAMPLE);
    const decoded = decodeFigCanvas(container.canvasFig);
    const tree = buildTree(decoded.message);
    const result = await generatePenExport({ tree, decoded, container, outDir: tmp });
    expect(result.totalPages).toBe(6);

    // Find our .pen for the design-setting page (page index 0)
    const ours = result.files.find((f) => f.penPath.includes('00_design setting.pen'));
    expect(ours).toBeDefined();

    const refDoc = JSON.parse(readFileSync(REF_PEN, 'utf8')) as AnyNode;
    const ourDoc = JSON.parse(readFileSync(ours!.penPath, 'utf8')) as AnyNode;
    const { byType, pairs } = audit(refDoc, ourDoc);

    expect(pairs).toBeGreaterThanOrEqual(180); // healthy pairing coverage
    const total = Object.values(byType).reduce((s, b) => s + b.totalProps, 0);
    const mis = Object.values(byType).reduce((s, b) => s + b.mismatches, 0);
    const matchRate = (total - mis) / total;
    // Diagnostic — only printed on failure via expect's diff message
    expect({ matchRate: matchRate.toFixed(4), mismatches: mis, total }).toEqual(
      expect.objectContaining({ matchRate: expect.stringMatching(/^0\.(98|99|1\.)/) }),
    );
    expect(matchRate).toBeGreaterThanOrEqual(0.985);
  });

  it('text styling is 100% match — fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textAlignVertical', async () => {
    // styleIdForText resolution (the biggest CSS fix) lives or dies here.
    const container = loadContainer(SAMPLE);
    const decoded = decodeFigCanvas(container.canvasFig);
    const tree = buildTree(decoded.message);
    const result = await generatePenExport({ tree, decoded, container, outDir: tmp });
    const ours = result.files.find((f) => f.penPath.includes('00_design setting.pen'));
    const refDoc = JSON.parse(readFileSync(REF_PEN, 'utf8')) as AnyNode;
    const ourDoc = JSON.parse(readFileSync(ours!.penPath, 'utf8')) as AnyNode;
    const { byType } = audit(refDoc, ourDoc);

    const textBucket = byType['text'];
    expect(textBucket).toBeDefined();
    // These keys must match perfectly. If any starts breaking, styleIdForText
    // resolution or the unit conversions have regressed.
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlignVertical', 'textAlign', 'fill', 'content', 'textGrowth']) {
      expect(textBucket!.byKey[k] ?? 0).toBe(0);
    }
  });

  it('per-type mismatch counts stay under thresholds (catch regressions early)', async () => {
    const container = loadContainer(SAMPLE);
    const decoded = decodeFigCanvas(container.canvasFig);
    const tree = buildTree(decoded.message);
    const result = await generatePenExport({ tree, decoded, container, outDir: tmp });
    const ours = result.files.find((f) => f.penPath.includes('00_design setting.pen'));
    const refDoc = JSON.parse(readFileSync(REF_PEN, 'utf8')) as AnyNode;
    const ourDoc = JSON.parse(readFileSync(ours!.penPath, 'utf8')) as AnyNode;
    const { byType } = audit(refDoc, ourDoc);

    // Calibrated from current known-good state with slack for legitimate drift.
    // If one of these starts failing, look at byKey to see which CSS property regressed.
    const thresholds: Record<string, number> = {
      frame: 15,    // currently ~8 (3 x/y intentional + 2 effect minor + 2 misc)
      text: 5,      // currently 2 (1 top-level x/y, edge cases)
      rectangle: 6, // currently ~3
      path: 6,      // currently ~4 (geometry notation differences)
    };
    for (const [type, threshold] of Object.entries(thresholds)) {
      const bucket = byType[type];
      const count = bucket?.mismatches ?? 0;
      // Surface byKey on failure for fast triage
      expect({ type, count, byKey: bucket?.byKey ?? {} }).toMatchObject({
        type,
        count: expect.any(Number),
      });
      expect(count, `${type} mismatches exceeded threshold (byKey: ${JSON.stringify(bucket?.byKey ?? {})})`).toBeLessThanOrEqual(threshold);
    }
  });
});
