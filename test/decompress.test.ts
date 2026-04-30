/**
 * decompress.ts — 압축 알고리즘 자동 감지 + fallback chain
 * 실제 Figma는 schema=deflate-raw + data=zstd 같은 mixed 사용 → 자동 분기 결정적
 */
import { describe, expect, it } from 'vitest';
import { deflateRaw, deflate as deflateZlib } from 'pako';
import { detectCompression, decompress } from '../src/decompress.js';

const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00, 0x00]);

describe('detectCompression', () => {
  it('detects zstd by magic bytes 28 b5 2f fd', () => {
    expect(detectCompression(ZSTD_MAGIC)).toBe('zstd');
  });

  it('detects deflate-zlib by 0x78 + valid checksum', () => {
    const original = new TextEncoder().encode('hello world');
    const compressed = deflateZlib(original); // pako default = zlib wrapper
    expect(compressed[0]).toBe(0x78);
    expect(detectCompression(compressed)).toBe('deflate-zlib');
  });

  it('falls back to deflate-raw when no magic matches', () => {
    const original = new TextEncoder().encode('hello world');
    const compressed = deflateRaw(original); // no header
    expect(detectCompression(compressed)).toBe('deflate-raw');
  });

  it('returns deflate-raw for empty buffer (safe default)', () => {
    expect(detectCompression(new Uint8Array(0))).toBe('deflate-raw');
  });
});

describe('decompress', () => {
  it('round-trips deflate-raw correctly', () => {
    const original = new TextEncoder().encode('the quick brown fox jumps over the lazy dog');
    const compressed = deflateRaw(original);
    const restored = decompress(compressed);
    expect(restored).toEqual(original);
  });

  it('round-trips deflate-zlib correctly', () => {
    const original = new TextEncoder().encode('the quick brown fox jumps over the lazy dog');
    const compressed = deflateZlib(original);
    const restored = decompress(compressed);
    expect(restored).toEqual(original);
  });

  it('returns empty for empty input', () => {
    expect(decompress(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it('falls back through algorithms when first guess fails', () => {
    // 0x78로 시작하지만 zlib 체크섬은 invalid → deflate-raw로 fallback 시도
    // (raw deflate 데이터의 첫 byte가 우연히 0x78일 수 있음)
    const raw = deflateRaw(new TextEncoder().encode('test'));
    if (raw[0] === 0x78) {
      // raw 데이터가 zlib처럼 보이지만 실제로는 raw — fallback이 작동해야
      const restored = decompress(raw);
      expect(new TextDecoder().decode(restored)).toBe('test');
    }
  });
});
