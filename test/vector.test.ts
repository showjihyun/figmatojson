/**
 * vector.ts — commandsBlob → SVG path 디코더 (best-effort) + vectorNetworkBlob 파서.
 * black-box test via extractVectors. byte 배열을 직접 합성해 명령 시퀀스 검증.
 */
import { describe, expect, it } from 'vitest';
import { extractVectors, parseVectorNetworkBlob, vectorNetworkToPath } from '../src/vector.js';
import type { TreeNode } from '../src/types.js';

/** float32 LE byte를 만든다 */
function f32(n: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, n, true);
  return Array.from(new Uint8Array(buf));
}

function vectorNode(
  guid: string,
  fillBlobIdx: number,
  size = { x: 100, y: 100 },
): TreeNode {
  return {
    guid: { sessionID: 0, localID: 0 },
    guidStr: guid,
    type: 'VECTOR',
    children: [],
    data: {
      type: 'VECTOR',
      size,
      fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: fillBlobIdx }],
    } as never,
  };
}

describe('extractVectors / decodeCommandsBlob', () => {
  it('decodes MOVE_TO + LINE_TO + CLOSE into SVG path', () => {
    // Build a blob: MOVE(0,0) + LINE(10,0) + LINE(10,10) + CLOSE
    const blob = new Uint8Array([
      0x01, ...f32(0), ...f32(0),     // MOVE 0,0
      0x02, ...f32(10), ...f32(0),    // LINE 10,0
      0x02, ...f32(10), ...f32(10),   // LINE 10,10
      0x05,                            // CLOSE
    ]);
    const root = vectorNode('1:1', 0);
    const results = extractVectors(root, [{ bytes: blob }]);
    expect(results).toHaveLength(1);
    expect(results[0]!.svg).toContain('M0 0');
    expect(results[0]!.svg).toContain('L10 0');
    expect(results[0]!.svg).toContain('L10 10');
    expect(results[0]!.svg).toContain('Z');
  });

  // Figma binary command 0x04 = CUBIC (24 bytes), 0x03 = QUAD (16 bytes)
  // (이전에는 swap돼 있어 모든 아이콘 곡선이 직선/근사로 렌더되던 root cause)
  it('decodes CUBIC (cmd 0x04, 6 floats) — Figma\'s native cubic bezier', () => {
    const blob = new Uint8Array([
      0x01, ...f32(0), ...f32(0),
      0x04, ...f32(1), ...f32(2), ...f32(3), ...f32(4), ...f32(5), ...f32(6),
    ]);
    const root = vectorNode('1:2', 0);
    const results = extractVectors(root, [{ bytes: blob }]);
    expect(results[0]!.svg).toContain('C1 2 3 4 5 6');
  });

  it('decodes QUAD (cmd 0x03, 4 floats)', () => {
    const blob = new Uint8Array([
      0x01, ...f32(0), ...f32(0),
      0x03, ...f32(1), ...f32(2), ...f32(3), ...f32(4),
    ]);
    const root = vectorNode('1:3', 0);
    const results = extractVectors(root, [{ bytes: blob }]);
    expect(results[0]!.svg).toContain('Q1 2 3 4');
  });

  it('treats cmd 0x00 as subpath separator (no-op) and continues parsing', () => {
    // 0x00 between two valid commands shouldn't cut the path off.
    const blob = new Uint8Array([
      0x01, ...f32(0), ...f32(0),
      0x00,                                                    // subpath separator
      0x02, ...f32(10), ...f32(10),                            // line that should still be decoded
    ]);
    const root = vectorNode('1:4', 0);
    const results = extractVectors(root, [{ bytes: blob }]);
    expect(results[0]!.svg).toContain('M0 0');
    expect(results[0]!.svg).toContain('L10 10');
  });

  it('handles trailing 1-byte (winding flag) gracefully (best-effort)', () => {
    const blob = new Uint8Array([
      0x01, ...f32(0), ...f32(0),
      0x02, ...f32(5), ...f32(5),
      0x00, // unknown trailing byte → 디코더가 멈추지만 path는 보존
    ]);
    const root = vectorNode('1:4', 0);
    const results = extractVectors(root, [{ bytes: blob }]);
    expect(results[0]!.svg).toBeTruthy();
    expect(results[0]!.svg).toContain('M0 0');
    expect(results[0]!.svg).toContain('L5 5');
  });

  it('reports error when no fillGeometry/strokeGeometry', () => {
    const root: TreeNode = {
      guid: { sessionID: 0, localID: 0 },
      guidStr: '1:5',
      type: 'VECTOR',
      children: [],
      data: { type: 'VECTOR' } as never,
    };
    const results = extractVectors(root, []);
    expect(results[0]!.svg).toBeUndefined();
    expect(results[0]!.error).toMatch(/no fill\/stroke geometry/);
  });

  it('reports error when blob index out of range', () => {
    const root = vectorNode('1:6', 999);
    const results = extractVectors(root, []);
    expect(results[0]!.svg).toBeUndefined();
    expect(results[0]!.error).toMatch(/missing/);
  });

  it('only descends VECTOR-family types', () => {
    const root: TreeNode = {
      guid: { sessionID: 0, localID: 0 },
      guidStr: '1:7',
      type: 'FRAME', // not vector-family
      children: [],
      data: { type: 'FRAME' } as never,
    };
    expect(extractVectors(root, [])).toHaveLength(0);
  });

  it('uses size for SVG viewBox', () => {
    const blob = new Uint8Array([0x01, ...f32(0), ...f32(0)]);
    const root = vectorNode('1:8', 0, { x: 42, y: 17 });
    const [r] = extractVectors(root, [{ bytes: blob }]);
    expect(r!.svg).toContain('viewBox="0 0 42 17"');
  });
});

/** uint32 LE byte 4개 만든다 */
function u32(n: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, n, true);
  return Array.from(new Uint8Array(buf));
}

describe('parseVectorNetworkBlob (pencil.dev format)', () => {
  it('parses header: vertexCount/segmentCount/regionCount', () => {
    // 2 vertices, 1 segment, 0 regions (cursor 케이스 — line 표시)
    const blob = new Uint8Array([
      ...u32(2), ...u32(1), ...u32(0),                 // header
      ...u32(0), ...f32(0), ...f32(0),                 // vertex 0: styleID=0, (0,0)
      ...u32(0), ...f32(0), ...f32(52),                // vertex 1: styleID=0, (0,52)
      ...u32(0),                                        // segment styleID
      ...u32(0), ...f32(0), ...f32(0),                 // start: vertex 0, no tangent
      ...u32(1), ...f32(0), ...f32(0),                 // end: vertex 1, no tangent
    ]);
    const vn = parseVectorNetworkBlob(blob);
    expect(vn).not.toBeNull();
    expect(vn!.vertices).toHaveLength(2);
    expect(vn!.vertices[1]).toEqual({ styleID: 0, x: 0, y: 52 });
    expect(vn!.segments).toHaveLength(1);
    expect(vn!.segments[0]!.start).toEqual({ vertex: 0, dx: 0, dy: 0 });
    expect(vn!.segments[0]!.end).toEqual({ vertex: 1, dx: 0, dy: 0 });
    expect(vn!.regions).toHaveLength(0);
  });

  it('parses region with packed styleID/winding bit', () => {
    // 1 region with NONZERO winding (low bit = 1), 1 loop, 1 segment in loop
    const blob = new Uint8Array([
      ...u32(2), ...u32(1), ...u32(1),                 // header
      ...u32(0), ...f32(0), ...f32(0),                 // vertex 0
      ...u32(0), ...f32(10), ...f32(0),                // vertex 1
      ...u32(0),                                        // segment styleID
      ...u32(0), ...f32(0), ...f32(0),                 // start: vertex 0
      ...u32(1), ...f32(0), ...f32(0),                 // end: vertex 1
      ...u32((5 << 1) | 1),                             // region: styleID=5, winding=NONZERO (bit 0=1)
      ...u32(1),                                        // loopCount=1
      ...u32(1),                                        // loop's segmentCount=1
      ...u32(0),                                        // segment index 0
    ]);
    const vn = parseVectorNetworkBlob(blob);
    expect(vn).not.toBeNull();
    expect(vn!.regions).toHaveLength(1);
    expect(vn!.regions[0]!.windingRule).toBe('NONZERO');
    expect(vn!.regions[0]!.styleID).toBe(5);
    expect(vn!.regions[0]!.loops[0]!.segments).toEqual([0]);
  });

  it('parses ODD winding (low bit = 0)', () => {
    const blob = new Uint8Array([
      ...u32(2), ...u32(1), ...u32(1),
      ...u32(0), ...f32(0), ...f32(0),
      ...u32(0), ...f32(10), ...f32(0),
      ...u32(0), ...u32(0), ...f32(0), ...f32(0), ...u32(1), ...f32(0), ...f32(0),
      ...u32((3 << 1) | 0),                             // styleID=3, winding=ODD (bit 0=0)
      ...u32(1), ...u32(1), ...u32(0),
    ]);
    const vn = parseVectorNetworkBlob(blob);
    expect(vn!.regions[0]!.windingRule).toBe('ODD');
    expect(vn!.regions[0]!.styleID).toBe(3);
  });

  it('returns null on truncated header (< 12 bytes)', () => {
    expect(parseVectorNetworkBlob(new Uint8Array([0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('returns null on out-of-range vertex index in segment', () => {
    const blob = new Uint8Array([
      ...u32(2), ...u32(1), ...u32(0),
      ...u32(0), ...f32(0), ...f32(0),
      ...u32(0), ...f32(10), ...f32(0),
      ...u32(0), ...u32(99), ...f32(0), ...f32(0), ...u32(1), ...f32(0), ...f32(0),
    ]);
    expect(parseVectorNetworkBlob(blob)).toBeNull();
  });
});

describe('vectorNetworkToPath (pencil.dev xQ algorithm)', () => {
  it('emits L for zero-tangent segments (cursor: M0 0 L0 52)', () => {
    const vn = {
      vertices: [{ styleID: 0, x: 0, y: 0 }, { styleID: 0, x: 0, y: 52 }],
      segments: [{
        styleID: 0,
        start: { vertex: 0, dx: 0, dy: 0 },
        end: { vertex: 1, dx: 0, dy: 0 },
      }],
      regions: [],
    };
    const path = vectorNetworkToPath(vn);
    expect(path).toContain('M0 0');
    expect(path).toContain('L0 52');
    expect(path).not.toContain('C');
  });

  it('emits C for cubic with non-zero tangents', () => {
    // start vertex (0,0), end vertex (10,0). Both control points pull up by (0,5).
    // Result: M0 0 C0 5 10 5 10 0
    const vn = {
      vertices: [{ styleID: 0, x: 0, y: 0 }, { styleID: 0, x: 10, y: 0 }],
      segments: [{
        styleID: 0,
        start: { vertex: 0, dx: 0, dy: 5 },   // control1 = (0,0) + (0,5) = (0,5)
        end: { vertex: 1, dx: 0, dy: 5 },     // control2 = (10,0) + (0,5) = (10,5)
      }],
      regions: [],
    };
    const path = vectorNetworkToPath(vn);
    expect(path).toContain('M0 0');
    expect(path).toContain('C0 5 10 5 10 0');
  });

  it('emits Z when subpath returns to start vertex', () => {
    // Triangle: v0→v1, v1→v2, v2→v0
    const vn = {
      vertices: [
        { styleID: 0, x: 0, y: 0 },
        { styleID: 0, x: 10, y: 0 },
        { styleID: 0, x: 5, y: 8 },
      ],
      segments: [
        { styleID: 0, start: { vertex: 0, dx: 0, dy: 0 }, end: { vertex: 1, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 1, dx: 0, dy: 0 }, end: { vertex: 2, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 2, dx: 0, dy: 0 }, end: { vertex: 0, dx: 0, dy: 0 } },
      ],
      regions: [{
        styleID: 0,
        windingRule: 'NONZERO' as const,
        loops: [{ segments: [0, 1, 2] }],
      }],
    };
    const path = vectorNetworkToPath(vn);
    expect(path).toContain('M0 0');
    expect(path).toContain('Z');
  });

  it('handles multiple regions/loops separately (joined by spaces)', () => {
    // 2 separate triangles
    const vn = {
      vertices: [
        { styleID: 0, x: 0, y: 0 }, { styleID: 0, x: 10, y: 0 }, { styleID: 0, x: 5, y: 8 },
        { styleID: 0, x: 20, y: 0 }, { styleID: 0, x: 30, y: 0 }, { styleID: 0, x: 25, y: 8 },
      ],
      segments: [
        { styleID: 0, start: { vertex: 0, dx: 0, dy: 0 }, end: { vertex: 1, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 1, dx: 0, dy: 0 }, end: { vertex: 2, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 2, dx: 0, dy: 0 }, end: { vertex: 0, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 3, dx: 0, dy: 0 }, end: { vertex: 4, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 4, dx: 0, dy: 0 }, end: { vertex: 5, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 5, dx: 0, dy: 0 }, end: { vertex: 3, dx: 0, dy: 0 } },
      ],
      regions: [{
        styleID: 0,
        windingRule: 'NONZERO' as const,
        loops: [{ segments: [0, 1, 2] }, { segments: [3, 4, 5] }],
      }],
    };
    const path = vectorNetworkToPath(vn);
    // 2 M (one per loop) + 2 Z
    expect((path.match(/M/g) ?? []).length).toBe(2);
    expect((path.match(/Z/g) ?? []).length).toBe(2);
  });

  // Spec: vector-decode.spec.md §I-V7a — region+orphan composition.
  // Real reproduction: HPAI 700:319 (data-01 / Icon) carries 4 regions
  // (dots) AND 6 orphan segments (the connecting line). Without this
  // invariant the line is silently dropped.
  it('emits orphan stroke-only segments alongside region paths (I-V7a)', () => {
    // Region: closed triangle on segments[0..2] (vertices 0,1,2).
    // Orphans: a line on segments[3] (vertices 3→4).
    const vn = {
      vertices: [
        { styleID: 0, x: 0, y: 0 }, { styleID: 0, x: 10, y: 0 }, { styleID: 0, x: 5, y: 8 },
        { styleID: 0, x: 20, y: 0 }, { styleID: 0, x: 30, y: 0 },
      ],
      segments: [
        { styleID: 0, start: { vertex: 0, dx: 0, dy: 0 }, end: { vertex: 1, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 1, dx: 0, dy: 0 }, end: { vertex: 2, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 2, dx: 0, dy: 0 }, end: { vertex: 0, dx: 0, dy: 0 } },
        // orphan — not referenced by any region
        { styleID: 1, start: { vertex: 3, dx: 0, dy: 0 }, end: { vertex: 4, dx: 0, dy: 0 } },
      ],
      regions: [{
        styleID: 0,
        windingRule: 'NONZERO' as const,
        loops: [{ segments: [0, 1, 2] }],
      }],
    };
    const path = vectorNetworkToPath(vn);
    // Region path: M0 0 → L10 0 → L5 8 → Z (closed)
    expect(path).toContain('M0 0');
    expect(path).toContain('Z');
    // Orphan line: must include a M-L pair from (20,0) to (30,0)
    expect(path).toContain('M20 0');
    expect(path).toContain('L30 0');
  });

  it('emits multiple disconnected orphan lines as separate subpaths', () => {
    // Region with one closed loop + 2 disconnected orphan lines.
    // Both orphan lines must contribute to the output path.
    const vn = {
      vertices: [
        { styleID: 0, x: 0, y: 0 }, { styleID: 0, x: 10, y: 0 }, { styleID: 0, x: 5, y: 8 },
        { styleID: 0, x: 100, y: 100 }, { styleID: 0, x: 105, y: 100 },
        { styleID: 0, x: 200, y: 200 }, { styleID: 0, x: 210, y: 200 },
      ],
      segments: [
        // region triangle
        { styleID: 0, start: { vertex: 0, dx: 0, dy: 0 }, end: { vertex: 1, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 1, dx: 0, dy: 0 }, end: { vertex: 2, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 2, dx: 0, dy: 0 }, end: { vertex: 0, dx: 0, dy: 0 } },
        // orphan line A
        { styleID: 1, start: { vertex: 3, dx: 0, dy: 0 }, end: { vertex: 4, dx: 0, dy: 0 } },
        // orphan line B (disconnected from A)
        { styleID: 1, start: { vertex: 5, dx: 0, dy: 0 }, end: { vertex: 6, dx: 0, dy: 0 } },
      ],
      regions: [{
        styleID: 0,
        windingRule: 'NONZERO' as const,
        loops: [{ segments: [0, 1, 2] }],
      }],
    };
    const path = vectorNetworkToPath(vn);
    // Both orphan lines must show up — the actual move-direction is up to
    // I-V7a (raw order, no orient): start at v3=(100,100) and v5=(200,200).
    expect(path).toContain('M100 100');
    expect(path).toContain('L105 100');
    expect(path).toContain('M200 200');
    expect(path).toContain('L210 200');
  });

  it('skips orient on disconnected orphans (no spurious reversals)', () => {
    // Region uses segment 0 (closed loop on triangle 0,1,2).
    // Orphan segment 1 is a directed line v3→v4. orphan must not be
    // reversed — output must move from v3=(20,0) to v4=(30,0).
    const vn = {
      vertices: [
        { styleID: 0, x: 0, y: 0 }, { styleID: 0, x: 10, y: 0 }, { styleID: 0, x: 5, y: 8 },
        { styleID: 0, x: 20, y: 0 }, { styleID: 0, x: 30, y: 0 },
      ],
      segments: [
        { styleID: 0, start: { vertex: 0, dx: 0, dy: 0 }, end: { vertex: 1, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 1, dx: 0, dy: 0 }, end: { vertex: 2, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 2, dx: 0, dy: 0 }, end: { vertex: 0, dx: 0, dy: 0 } },
        { styleID: 1, start: { vertex: 3, dx: 0, dy: 0 }, end: { vertex: 4, dx: 0, dy: 0 } },
      ],
      regions: [{
        styleID: 0,
        windingRule: 'NONZERO' as const,
        loops: [{ segments: [0, 1, 2] }],
      }],
    };
    const path = vectorNetworkToPath(vn);
    // direction must be v3 (20,0) → v4 (30,0), not reversed.
    const idx = path.indexOf('M20 0');
    const lIdx = path.indexOf('L30 0');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(lIdx).toBeGreaterThan(idx);
  });

  it('orientSegments reverses out-of-order segments to keep continuity (EQ)', () => {
    // segments stored OUT of natural chain order: v1→v0, v1→v2 (first should be reversed to v0→v1)
    const vn = {
      vertices: [
        { styleID: 0, x: 0, y: 0 }, { styleID: 0, x: 10, y: 0 }, { styleID: 0, x: 20, y: 0 },
      ],
      segments: [
        { styleID: 0, start: { vertex: 1, dx: 0, dy: 0 }, end: { vertex: 0, dx: 0, dy: 0 } },
        { styleID: 0, start: { vertex: 1, dx: 0, dy: 0 }, end: { vertex: 2, dx: 0, dy: 0 } },
      ],
      regions: [],
    };
    const path = vectorNetworkToPath(vn);
    // Expected after orient: v0→v1, v1→v2 — path should start at (0,0), go to (10,0), then (20,0).
    expect(path).toMatch(/M0 0/);
    expect(path).toContain('L10 0');
    expect(path).toContain('L20 0');
  });
});
