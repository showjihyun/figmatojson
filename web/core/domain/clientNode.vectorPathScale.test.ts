import { describe, expect, it } from 'vitest';

import { toClientNode } from './clientNode.js';
import type { TreeNode } from '../../../src/types.js';

/**
 * Spec: docs/specs/web-render-fidelity-round12.spec.md
 *
 * For ELLIPSE / parametric shapes whose path bbox (normalizedSize) is
 * larger than the node's `size` (1440:621: size 80×80, normalizedSize
 * 120×120), `_pathScale = size / normalizedSize` puts the path back into
 * the node box. round 11's inset path is not used here — the two are
 * mutually exclusive (spec §I-3).
 */

function makeVectorNode(
  data: Record<string, unknown>,
  type = 'ELLIPSE',
): TreeNode {
  return {
    guid: { sessionID: 0, localID: 1 },
    guidStr: '0:1',
    type,
    name: type,
    children: [],
    data,
  };
}

const NO_BLOBS: Array<{ bytes: Uint8Array }> = [];
const NO_SYMBOLS = new Map<string, TreeNode>();

describe('toClientNode — vector path scale (round12)', () => {
  // I-2, I-4 — real numbers from HPAI 1440:621 ELLIPSE
  it('sets _pathScale = size / normalizedSize when size < normalizedSize', () => {
    const n = makeVectorNode({
      size: { x: 80, y: 80 },
      vectorData: { normalizedSize: { x: 120, y: 120 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathScale).toBeDefined();
    expect(out._pathScale!.x).toBeCloseTo(80 / 120, 6);
    expect(out._pathScale!.y).toBeCloseTo(80 / 120, 6);
  });

  // I-3 — _pathScale and _pathOffset are mutually exclusive
  it('does NOT set _pathOffset when _pathScale is set', () => {
    const n = makeVectorNode({
      size: { x: 80, y: 80 },
      vectorData: { normalizedSize: { x: 120, y: 120 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathScale).toBeDefined();
    expect(out._pathOffset).toBeUndefined();
  });

  // I-2 — asymmetric: only one dimension smaller still triggers scale
  it('triggers scale when only one dimension is smaller', () => {
    const n = makeVectorNode({
      size: { x: 80, y: 200 },         // y is larger
      vectorData: { normalizedSize: { x: 120, y: 120 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathScale).toBeDefined();
    expect(out._pathScale!.x).toBeCloseTo(80 / 120, 6);
    expect(out._pathScale!.y).toBeCloseTo(200 / 120, 6);
    expect(out._pathOffset).toBeUndefined();
  });

  // I-1 — round 11 regression guard: size > normalizedSize keeps inset path
  it('uses round 11 _pathOffset when size > normalizedSize (regression)', () => {
    const n = makeVectorNode({
      size: { x: 20, y: 20 },          // 700:319 reproduction
      vectorData: { normalizedSize: { x: 16, y: 16 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toEqual({ x: 2, y: 2 });
    expect(out._pathScale).toBeUndefined();
  });

  // I-1 — size === normalizedSize: neither set
  it('omits both when size equals normalizedSize', () => {
    const n = makeVectorNode({
      size: { x: 50, y: 50 },
      vectorData: { normalizedSize: { x: 50, y: 50 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toBeUndefined();
    expect(out._pathScale).toBeUndefined();
  });

  // I-6 — zero-divide guard
  it('omits _pathScale when normalizedSize.x is 0', () => {
    const n = makeVectorNode({
      size: { x: 80, y: 80 },
      vectorData: { normalizedSize: { x: 0, y: 120 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathScale).toBeUndefined();
  });

  it('omits _pathScale when normalizedSize.y is 0', () => {
    const n = makeVectorNode({
      size: { x: 80, y: 80 },
      vectorData: { normalizedSize: { x: 120, y: 0 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathScale).toBeUndefined();
  });

  // applies to STAR / REGULAR_POLYGON / etc., same as round 11
  it('applies to all VECTOR_TYPES (STAR sample)', () => {
    const n = makeVectorNode(
      {
        size: { x: 30, y: 30 },
        vectorData: { normalizedSize: { x: 60, y: 60 } },
      },
      'STAR',
    );
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathScale).toEqual({ x: 0.5, y: 0.5 });
  });

  it('does not set _pathScale on non-vector types', () => {
    const n = makeVectorNode(
      {
        size: { x: 80, y: 80 },
        vectorData: { normalizedSize: { x: 120, y: 120 } },
      },
      'FRAME',
    );
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathScale).toBeUndefined();
  });
});
