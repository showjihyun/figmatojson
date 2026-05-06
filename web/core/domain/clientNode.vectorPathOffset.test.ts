import { describe, expect, it } from 'vitest';

import { toClientNode } from './clientNode.js';
import type { TreeNode } from '../../../src/types.js';

/**
 * Spec: docs/specs/web-render-fidelity-round11.spec.md
 *
 * The vectorNetworkBlob decoder in `src/vector.ts` produces SVG path d= strings
 * whose coords live in `vectorData.normalizedSize` space (0..normalizedSize).
 * Real Figma nodes often have `size > normalizedSize` (stroke outset bumps the
 * node bbox out). To keep the path visually centered inside the node box we
 * attach `_pathOffset = (size - normalizedSize) / 2` to the client node, and
 * Canvas.tsx forwards it as the `<Path x y>` props.
 */

function makeVectorNode(
  data: Record<string, unknown>,
  type = 'VECTOR',
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

describe('toClientNode — vector path offset (round11)', () => {
  // I-3
  it('sets _pathOffset = (size - normalizedSize) / 2 when both defined', () => {
    // Real numbers from Frame 2262 / 700:319 ("Icon"): size 20×20, normalized 16×16
    const n = makeVectorNode({
      size: { x: 20, y: 20 },
      vectorData: { normalizedSize: { x: 16, y: 16 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toEqual({ x: 2, y: 2 });
  });

  // I-3 — non-square diff (700:325 case)
  it('handles asymmetric size/normalized diffs', () => {
    const n = makeVectorNode({
      size: { x: 15.55555534362793, y: 20 },
      vectorData: { normalizedSize: { x: 14, y: 18 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset?.x).toBeCloseTo(0.7777776718139648, 6);
    expect(out._pathOffset?.y).toBe(1);
  });

  // I-4 — size == normalizedSize (700:315 fill-only case): no field added
  it('omits _pathOffset when size equals normalizedSize', () => {
    const n = makeVectorNode({
      size: { x: 20.0, y: 12.0 },
      vectorData: { normalizedSize: { x: 20.0, y: 12.0 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toBeUndefined();
  });

  // I-4 — vectorData missing → no offset (and no crash)
  it('omits _pathOffset when vectorData is missing', () => {
    const n = makeVectorNode({ size: { x: 20, y: 20 } });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toBeUndefined();
  });

  // I-4 — normalizedSize missing → no offset
  it('omits _pathOffset when normalizedSize is missing', () => {
    const n = makeVectorNode({
      size: { x: 20, y: 20 },
      vectorData: {},
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toBeUndefined();
  });

  // I-4 — size missing → no offset
  it('omits _pathOffset when size is missing', () => {
    const n = makeVectorNode({
      vectorData: { normalizedSize: { x: 16, y: 16 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toBeUndefined();
  });

  // I-4 — non-number dimension → no offset
  it('omits _pathOffset when a dimension is non-number', () => {
    const n = makeVectorNode({
      size: { x: 20, y: '20' },
      vectorData: { normalizedSize: { x: 16, y: 16 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toBeUndefined();
  });

  // I-1 — only VECTOR_TYPES are eligible. A FRAME with vectorData is ignored.
  it('does not set _pathOffset on non-vector types', () => {
    const n = makeVectorNode(
      {
        size: { x: 20, y: 20 },
        vectorData: { normalizedSize: { x: 16, y: 16 } },
      },
      'FRAME',
    );
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toBeUndefined();
  });

  // I-5 — size < normalizedSize is now delegated to round 12's `_pathScale`
  // (mutually exclusive). Round 11 only sets _pathOffset on positive diffs.
  it('omits _pathOffset when size < normalizedSize (delegated to round 12)', () => {
    const n = makeVectorNode({
      size: { x: 14, y: 14 },
      vectorData: { normalizedSize: { x: 16, y: 16 } },
    });
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toBeUndefined();
  });

  // Applies to STAR / ELLIPSE / ROUNDED_RECTANGLE / etc. as well.
  it('applies to all VECTOR_TYPES (STAR sample)', () => {
    const n = makeVectorNode(
      {
        size: { x: 20, y: 20 },
        vectorData: { normalizedSize: { x: 18, y: 18 } },
      },
      'STAR',
    );
    const out = toClientNode(n, NO_BLOBS, NO_SYMBOLS);
    expect(out._pathOffset).toEqual({ x: 1, y: 1 });
  });
});
