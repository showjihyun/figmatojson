/**
 * Iteration 2: 압축 알고리즘 자동 감지 (PRD §4.2 F-PROC-02, §5.1)
 *
 * 지원: deflate-raw (헤더 없음), deflate-zlib (78 xx), zstd (28 b5 2f fd)
 * 첫 청크 시도가 실패하면 다른 알고리즘으로 fallback.
 */

import { inflate, inflateRaw } from 'pako';
import { decompress as zstdDecompress } from 'fzstd';
import type { Compression } from './types.js';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function detectCompression(buf: Uint8Array): Compression {
  if (buf.length >= 4 && ZSTD_MAGIC.every((b, i) => buf[i] === b)) {
    return 'zstd';
  }
  // zlib header: 1st byte CMF, 2nd byte FLG. CM=8 (deflate) → 0x78.
  // Common 2nd bytes: 0x01, 0x5e, 0x9c, 0xda
  if (buf.length >= 2 && buf[0] === 0x78) {
    const flg = buf[1] ?? 0;
    if ((((buf[0] ?? 0) << 8) | flg) % 31 === 0) {
      return 'deflate-zlib';
    }
  }
  // 기본: deflate-raw (fig-kiwi의 기본 방식)
  return 'deflate-raw';
}

export function decompress(buf: Uint8Array): Uint8Array {
  if (buf.length === 0) return buf;
  const detected = detectCompression(buf);

  // 감지된 방식 → 실패 시 다른 방식 fallback
  const order: Compression[] =
    detected === 'zstd'
      ? ['zstd', 'deflate-raw', 'deflate-zlib']
      : detected === 'deflate-zlib'
        ? ['deflate-zlib', 'deflate-raw', 'zstd']
        : ['deflate-raw', 'deflate-zlib', 'zstd'];

  let lastErr: Error | undefined;
  for (const algo of order) {
    try {
      return tryDecompress(buf, algo);
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw new Error(
    `decompression failed for all algorithms (${order.join(', ')}). ` +
      `last error: ${lastErr?.message}`,
  );
}

function tryDecompress(buf: Uint8Array, algo: Compression): Uint8Array {
  switch (algo) {
    case 'zstd':
      return zstdDecompress(buf);
    case 'deflate-zlib':
      return inflate(buf);
    case 'deflate-raw':
      return inflateRaw(buf);
    default:
      throw new Error(`unsupported algorithm: ${algo}`);
  }
}
