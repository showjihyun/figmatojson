/**
 * assets.ts — magic 기반 이미지 확장자 추론, hashToHex, imageRef 수집
 */
import { describe, expect, it } from 'vitest';
import { collectImageRefs, detectImageExt, hashToHex } from '../src/assets.js';
import type { TreeNode } from '../src/types.js';

describe('detectImageExt', () => {
  it('detects PNG', () => {
    expect(detectImageExt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
  });

  it('detects JPEG', () => {
    expect(detectImageExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
  });

  it('detects GIF89a', () => {
    expect(detectImageExt(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
  });

  it('detects WebP', () => {
    // RIFF....WEBP
    const buf = new Uint8Array(12);
    buf.set([0x52, 0x49, 0x46, 0x46], 0);  // RIFF
    buf.set([0x57, 0x45, 0x42, 0x50], 8);  // WEBP
    expect(detectImageExt(buf)).toBe('webp');
  });

  it('detects PDF', () => {
    expect(detectImageExt(new TextEncoder().encode('%PDF-1.4'))).toBe('pdf');
  });

  it('detects SVG with xml declaration', () => {
    expect(detectImageExt(new TextEncoder().encode('<?xml version="1.0"?><svg/>'))).toBe('svg');
  });

  it('detects SVG without xml declaration', () => {
    expect(detectImageExt(new TextEncoder().encode('<svg xmlns="..."/>'))).toBe('svg');
  });

  it('returns "bin" for unknown magic', () => {
    expect(detectImageExt(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('bin');
  });

  it('handles tiny buffer gracefully', () => {
    expect(detectImageExt(new Uint8Array([0x00, 0x01]))).toBe('bin');
  });
});

describe('hashToHex', () => {
  it('converts Uint8Array to lowercase hex', () => {
    expect(hashToHex(new Uint8Array([0xab, 0xcd, 0xef, 0x01]))).toBe('abcdef01');
  });

  it('passes through string and lowercases', () => {
    expect(hashToHex('ABCD1234')).toBe('abcd1234');
  });

  it('returns null for null/undefined', () => {
    expect(hashToHex(null)).toBeNull();
    expect(hashToHex(undefined)).toBeNull();
  });

  it('handles empty Uint8Array', () => {
    expect(hashToHex(new Uint8Array(0))).toBe('');
  });
});

describe('collectImageRefs', () => {
  function makeNode(guid: string, type: string, data: Record<string, unknown>): TreeNode {
    const [s, l] = guid.split(':').map(Number);
    return {
      guid: { sessionID: s!, localID: l! },
      guidStr: guid,
      type,
      data: { type, ...data } as never,
      children: [],
    };
  }

  it('returns empty map for null root', () => {
    expect(collectImageRefs(null).size).toBe(0);
  });

  it('finds image.hash references', () => {
    const root = makeNode('0:0', 'DOCUMENT', {});
    const child = makeNode('1:1', 'RECTANGLE', {
      fillPaints: [{ type: 'IMAGE', image: { hash: new Uint8Array([0xaa, 0xbb]) } }],
    });
    root.children = [child];
    const refs = collectImageRefs(root);
    expect(refs.has('aabb')).toBe(true);
    expect(refs.get('aabb')?.has('1:1')).toBe(true);
  });

  it('finds direct hash field on Image-like objects', () => {
    const root = makeNode('0:0', 'DOCUMENT', {
      hash: new Uint8Array([0x12, 0x34]),
    });
    const refs = collectImageRefs(root);
    expect(refs.has('1234')).toBe(true);
  });

  it('finds imageRef string fields', () => {
    const root = makeNode('0:0', 'DOCUMENT', {});
    const child = makeNode('1:1', 'RECTANGLE', { imageRef: 'ABC123' });
    root.children = [child];
    const refs = collectImageRefs(root);
    expect(refs.has('abc123')).toBe(true);
  });

  it('walks deeply nested structures', () => {
    const root = makeNode('0:0', 'DOCUMENT', {
      a: { b: { c: [{ image: { hash: new Uint8Array([0x99]) } }] } },
    });
    const refs = collectImageRefs(root);
    expect(refs.has('99')).toBe(true);
  });
});
