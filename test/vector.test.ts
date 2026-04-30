/**
 * vector.ts — commandsBlob → SVG path 디코더 (best-effort)
 * black-box test via extractVectors. byte 배열을 직접 합성해 명령 시퀀스 검증.
 */
import { describe, expect, it } from 'vitest';
import { extractVectors } from '../src/vector.js';
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

  it('decodes CUBIC_TO (6 floats)', () => {
    const blob = new Uint8Array([
      0x01, ...f32(0), ...f32(0),
      0x03, ...f32(1), ...f32(2), ...f32(3), ...f32(4), ...f32(5), ...f32(6),
    ]);
    const root = vectorNode('1:2', 0);
    const results = extractVectors(root, [{ bytes: blob }]);
    expect(results[0]!.svg).toContain('C1 2 3 4 5 6');
  });

  it('decodes QUAD (4 floats)', () => {
    const blob = new Uint8Array([
      0x01, ...f32(0), ...f32(0),
      0x04, ...f32(1), ...f32(2), ...f32(3), ...f32(4),
    ]);
    const root = vectorNode('1:3', 0);
    const results = extractVectors(root, [{ bytes: blob }]);
    expect(results[0]!.svg).toContain('Q1 2 3 4');
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
