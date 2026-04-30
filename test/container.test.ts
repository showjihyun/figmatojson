/**
 * container.ts — ZIP / raw fig-kiwi 자동 분기, magic byte 검증
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import AdmZip from 'adm-zip';
import { loadContainer } from '../src/container.js';

const FIG_KIWI = new TextEncoder().encode('fig-kiwi');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'figrev-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRawFigKiwi(): Uint8Array {
  // 8B "fig-kiwi" + 4B version + 4B chunk size + dummy bytes
  const out = new Uint8Array(20);
  out.set(FIG_KIWI, 0);
  new DataView(out.buffer).setUint32(8, 1, true); // version
  new DataView(out.buffer).setUint32(12, 4, true); // size
  out.set([1, 2, 3, 4], 16);
  return out;
}

describe('loadContainer', () => {
  it('detects raw fig-kiwi (no ZIP wrap)', () => {
    const rawPath = join(tmp, 'raw.fig');
    writeFileSync(rawPath, makeRawFigKiwi());
    const c = loadContainer(rawPath);
    expect(c.isZipWrapped).toBe(false);
    expect(c.images.size).toBe(0);
    expect(c.metaJson).toBeUndefined();
    expect(c.canvasFig.byteLength).toBe(20);
  });

  it('extracts ZIP-wrapped .fig with all entries', () => {
    const zip = new AdmZip();
    zip.addFile('canvas.fig', Buffer.from(makeRawFigKiwi()));
    zip.addFile('meta.json', Buffer.from(JSON.stringify({ file_name: 'test' })));
    zip.addFile('thumbnail.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    zip.addFile('images/abc123', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const zipPath = join(tmp, 'wrapped.fig');
    zip.writeZip(zipPath);

    const c = loadContainer(zipPath);
    expect(c.isZipWrapped).toBe(true);
    expect(c.metaJson?.file_name).toBe('test');
    expect(c.thumbnail?.byteLength).toBe(4);
    expect(c.images.size).toBe(1);
    expect(c.images.has('abc123')).toBe(true);
  });

  it('throws on unknown magic bytes', () => {
    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);
    const garbagePath = join(tmp, 'garbage.fig');
    writeFileSync(garbagePath, garbage);
    expect(() => loadContainer(garbagePath)).toThrow(/Unknown file magic/);
  });

  it('throws when ZIP lacks canvas.fig entry', () => {
    const zip = new AdmZip();
    zip.addFile('meta.json', Buffer.from('{}'));
    const zipPath = join(tmp, 'no-canvas.fig');
    zip.writeZip(zipPath);
    expect(() => loadContainer(zipPath)).toThrow(/canvas\.fig not found/);
  });

  it('rejects malformed meta.json', () => {
    const zip = new AdmZip();
    zip.addFile('canvas.fig', Buffer.from(makeRawFigKiwi()));
    zip.addFile('meta.json', Buffer.from('{not valid json'));
    const zipPath = join(tmp, 'bad-meta.fig');
    zip.writeZip(zipPath);
    expect(() => loadContainer(zipPath)).toThrow(/meta\.json is not valid/);
  });
});
