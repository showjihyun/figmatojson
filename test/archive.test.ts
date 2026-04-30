/**
 * archive.ts — fig-kiwi 컨테이너 청크 분해
 */
import { describe, expect, it } from 'vitest';
import { parseFigArchive } from '../src/archive.js';

const PRELUDE = new TextEncoder().encode('fig-kiwi'); // 8 bytes

function buildArchive(version: number, chunks: Uint8Array[]): Uint8Array {
  const total =
    PRELUDE.byteLength + 4 + chunks.reduce((s, c) => s + 4 + c.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  out.set(PRELUDE, off);
  off += PRELUDE.byteLength;
  view.setUint32(off, version, true);
  off += 4;
  for (const c of chunks) {
    view.setUint32(off, c.byteLength, true);
    off += 4;
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe('parseFigArchive', () => {
  it('parses archive with two chunks', () => {
    const c1 = new Uint8Array([1, 2, 3]);
    const c2 = new Uint8Array([4, 5, 6, 7, 8]);
    const archive = parseFigArchive(buildArchive(106, [c1, c2]));
    expect(archive.prelude).toBe('fig-kiwi');
    expect(archive.version).toBe(106);
    expect(archive.chunks.length).toBe(2);
    expect(Array.from(archive.chunks[0]!)).toEqual([1, 2, 3]);
    expect(Array.from(archive.chunks[1]!)).toEqual([4, 5, 6, 7, 8]);
  });

  it('parses archive with zero chunks', () => {
    const archive = parseFigArchive(buildArchive(42, []));
    expect(archive.version).toBe(42);
    expect(archive.chunks.length).toBe(0);
  });

  it('preserves empty chunks (size=0)', () => {
    const archive = parseFigArchive(buildArchive(1, [new Uint8Array(0), new Uint8Array([9])]));
    expect(archive.chunks.length).toBe(2);
    expect(archive.chunks[0]!.byteLength).toBe(0);
    expect(archive.chunks[1]!.byteLength).toBe(1);
  });

  it('throws on invalid prelude', () => {
    const bad = new Uint8Array(12);
    bad.set(new TextEncoder().encode('not-kiwi'), 0); // 8 bytes
    expect(() => parseFigArchive(bad)).toThrow(/Invalid fig-kiwi prelude/);
  });

  it('throws on truncated archive (less than 12 bytes)', () => {
    expect(() => parseFigArchive(new Uint8Array(5))).toThrow(/too short/);
  });

  it('throws when chunk size exceeds remaining bytes', () => {
    const bad = new Uint8Array(16);
    bad.set(PRELUDE, 0);
    new DataView(bad.buffer).setUint32(8, 1, true); // version
    new DataView(bad.buffer).setUint32(12, 99999, true); // claims 99999 bytes but only ~0 left
    expect(() => parseFigArchive(bad)).toThrow(/exceeds data length/);
  });
});
