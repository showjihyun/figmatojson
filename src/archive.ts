/**
 * Iteration 2: canvas.fig (fig-kiwi) 청크 분해 (PRD §1.2.3, §6.3 #2)
 *
 * 포맷:
 *   [0..7]   "fig-kiwi" (8 bytes ASCII)
 *   [8..11]  version (LE uint32)
 *   loop:
 *     [+0..3]   chunk size (LE uint32)
 *     [+4..]    chunk bytes
 *
 * 첫 번째 청크 = Kiwi 스키마(압축),
 * 두 번째 청크 = 데이터 메시지(압축).
 */

import type { FigArchive } from './types.js';

const PRELUDE = 'fig-kiwi';
const PRELUDE_LEN = PRELUDE.length;

export function parseFigArchive(data: Uint8Array): FigArchive {
  if (data.length < PRELUDE_LEN + 4) {
    throw new Error(`fig archive too short: ${data.length} bytes`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: false });

  const prelude = decoder.decode(data.subarray(0, PRELUDE_LEN));
  if (prelude !== PRELUDE) {
    throw new Error(`Invalid fig-kiwi prelude: "${prelude}" (expected "${PRELUDE}")`);
  }

  const version = view.getUint32(PRELUDE_LEN, true);
  let offset = PRELUDE_LEN + 4;

  const chunks: Uint8Array[] = [];
  while (offset + 4 <= data.length) {
    const size = view.getUint32(offset, true);
    offset += 4;
    if (size === 0) {
      // 빈 청크는 정상이지만 보존
      chunks.push(new Uint8Array(0));
      continue;
    }
    if (offset + size > data.length) {
      throw new Error(
        `Chunk #${chunks.length} size=${size} at offset=${offset} exceeds data length=${data.length}`,
      );
    }
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
  }

  if (offset !== data.length) {
    // 트레일링 바이트 — 경고만 출력하고 계속 (forward-compat)
    process.stderr.write(
      `[archive] warning: ${data.length - offset} trailing bytes after last chunk\n`,
    );
  }

  return { prelude, version, chunks };
}
