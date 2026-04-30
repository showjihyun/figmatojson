/**
 * Iteration 8: Vector path 추출 (PRD §4.2 F-PROC-08, best-effort)
 *
 * 실측 결과 (2026-04-29 inspect-blobs.ts):
 *   - VECTOR 노드는 `vectorData.vectorNetworkBlob` (블롭 인덱스)와
 *     `fillGeometry[*].commandsBlob`/`strokeGeometry[*].commandsBlob` (블롭 인덱스) 보유.
 *   - `message.blobs[idx].bytes` = 실제 path 명령 바이너리.
 *
 * commandsBlob 추정 포맷 (역공학):
 *   - 0x01 MOVE_TO   + 2 × float32 LE (x, y)
 *   - 0x02 LINE_TO   + 2 × float32 LE
 *   - 0x03 CUBIC_TO  + 6 × float32 LE (c1x, c1y, c2x, c2y, x, y)
 *   - 0x04 QUAD_TO   + 4 × float32 LE (cx, cy, x, y)
 *   - 0x05 CLOSE     (no args)
 *
 * 일부 블롭은 첫 1 byte가 0x00 (winding flag 추정) — skip 후 디코드 시도.
 * 모든 알 수 없는 cmd → 디코드 중단, raw bytes 메타로 보존.
 */

import type { TreeNode } from './types.js';

export interface VectorExtractionResult {
  nodeId: string;
  nodeName?: string;
  svg?: string;
  /** 디코드 실패 사유 (있으면) */
  error?: string;
  /** 참조한 블롭 인덱스 (디버깅용) */
  blobIndices: number[];
}

const VECTOR_TYPES = new Set([
  'VECTOR',
  'STAR',
  'LINE',
  'ELLIPSE',
  'REGULAR_POLYGON',
  'BOOLEAN_OPERATION',
  'ROUNDED_RECTANGLE',
]);

export function extractVectors(
  root: TreeNode | null,
  blobs: Array<{ bytes: Uint8Array }> = [],
): VectorExtractionResult[] {
  const out: VectorExtractionResult[] = [];
  if (!root) return out;

  const visit = (n: TreeNode): void => {
    if (VECTOR_TYPES.has(n.type)) {
      out.push(tryExtract(n, blobs));
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

function tryExtract(
  n: TreeNode,
  blobs: Array<{ bytes: Uint8Array }>,
): VectorExtractionResult {
  const data = n.data as Record<string, unknown>;
  const result: VectorExtractionResult = {
    nodeId: n.guidStr,
    nodeName: n.name,
    blobIndices: [],
  };

  const fillGeom = data.fillGeometry as
    | Array<{ windingRule?: string; commandsBlob?: number; styleID?: number }>
    | undefined;
  const strokeGeom = data.strokeGeometry as
    | Array<{ windingRule?: string; commandsBlob?: number; styleID?: number }>
    | undefined;

  const paths: { d: string; fillRule: string; stroke: boolean }[] = [];
  const errors: string[] = [];

  for (const g of fillGeom ?? []) {
    if (typeof g.commandsBlob !== 'number') continue;
    result.blobIndices.push(g.commandsBlob);
    const blob = blobs[g.commandsBlob];
    if (!blob?.bytes) {
      errors.push(`blob[${g.commandsBlob}] missing`);
      continue;
    }
    try {
      const d = decodeCommandsBlob(blob.bytes);
      paths.push({
        d,
        fillRule: (g.windingRule ?? 'NONZERO') === 'ODD' ? 'evenodd' : 'nonzero',
        stroke: false,
      });
    } catch (err) {
      errors.push(`fill blob[${g.commandsBlob}]: ${(err as Error).message}`);
    }
  }
  for (const g of strokeGeom ?? []) {
    if (typeof g.commandsBlob !== 'number') continue;
    result.blobIndices.push(g.commandsBlob);
    const blob = blobs[g.commandsBlob];
    if (!blob?.bytes) {
      errors.push(`blob[${g.commandsBlob}] missing`);
      continue;
    }
    try {
      const d = decodeCommandsBlob(blob.bytes);
      paths.push({
        d,
        fillRule: 'nonzero',
        stroke: true,
      });
    } catch (err) {
      errors.push(`stroke blob[${g.commandsBlob}]: ${(err as Error).message}`);
    }
  }

  if (paths.length === 0) {
    result.error = errors.length > 0 ? errors.join('; ') : 'no fill/stroke geometry';
    return result;
  }

  const size = data.size as { x?: number; y?: number } | undefined;
  const w = size?.x ?? 100;
  const h = size?.y ?? 100;
  const fillColor = pickFill(data);
  const strokeColor = pickStroke(data);
  const strokeWidth = pickStrokeWeight(data);

  const pathEls = paths
    .map((p) => {
      if (p.stroke) {
        return `<path d="${p.d}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`;
      }
      return `<path d="${p.d}" fill="${fillColor}" fill-rule="${p.fillRule}"/>`;
    })
    .join('\n  ');

  result.svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  ${pathEls}
</svg>`;
  if (errors.length > 0) result.error = errors.join('; ');
  return result;
}

// ---------------------------------------------------------------------------
// commandsBlob decoder
// ---------------------------------------------------------------------------

function decodeCommandsBlob(bytes: Uint8Array): string {
  // 두 시작점 후보를 시도하고, "더 많은 명령을 디코드한 쪽"을 선택.
  // 일부 블롭은 첫 1 byte 헤더(winding flag 추정)를 가지므로 offset=1도 시도.
  const attempts = [0, 1]
    .filter((s) => s < bytes.length)
    .map((s) => decodeAt(bytes, s));

  // 가장 명령 개수 많은 쪽 채택. 동률이면 짧은 startOffset 우선.
  attempts.sort((a, b) => b.commandCount - a.commandCount);
  const best = attempts[0];
  if (!best || best.commandCount === 0 || !best.path) {
    throw new Error(
      `no valid commands decoded (tried offsets ${attempts.map((a) => a.startOffset).join(',')}, ` +
        `errors: ${attempts.map((a) => `[${a.startOffset}]${a.error ?? 'ok'}`).join('; ')})`,
    );
  }
  return best.path;
}

interface DecodeAttempt {
  startOffset: number;
  commandCount: number;
  path: string;
  error?: string;
}

function decodeAt(bytes: Uint8Array, startOffset: number): DecodeAttempt {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = startOffset;
  let path = '';
  let commandCount = 0;
  let error: string | undefined;

  while (offset < bytes.length) {
    const cmd = view.getUint8(offset);
    offset += 1;
    try {
      switch (cmd) {
        case 0x01: {
          if (offset + 8 > bytes.length) throw new Error(`truncated MOVE`);
          path += `M${fmt(view.getFloat32(offset, true))} ${fmt(view.getFloat32(offset + 4, true))} `;
          offset += 8;
          commandCount++;
          break;
        }
        case 0x02: {
          if (offset + 8 > bytes.length) throw new Error(`truncated LINE`);
          path += `L${fmt(view.getFloat32(offset, true))} ${fmt(view.getFloat32(offset + 4, true))} `;
          offset += 8;
          commandCount++;
          break;
        }
        case 0x03: {
          if (offset + 24 > bytes.length) throw new Error(`truncated CUBIC`);
          path += `C${fmt(view.getFloat32(offset, true))} ${fmt(view.getFloat32(offset + 4, true))} ${fmt(view.getFloat32(offset + 8, true))} ${fmt(view.getFloat32(offset + 12, true))} ${fmt(view.getFloat32(offset + 16, true))} ${fmt(view.getFloat32(offset + 20, true))} `;
          offset += 24;
          commandCount++;
          break;
        }
        case 0x04: {
          if (offset + 16 > bytes.length) throw new Error(`truncated QUAD`);
          path += `Q${fmt(view.getFloat32(offset, true))} ${fmt(view.getFloat32(offset + 4, true))} ${fmt(view.getFloat32(offset + 8, true))} ${fmt(view.getFloat32(offset + 12, true))} `;
          offset += 16;
          commandCount++;
          break;
        }
        case 0x05: {
          path += 'Z ';
          commandCount++;
          break;
        }
        default: {
          // 알 수 없는 cmd → 종료 마커 또는 trailing metadata로 간주, 디코드 중단.
          error = `unknown cmd 0x${cmd.toString(16).padStart(2, '0')} at offset ${offset - 1}/${bytes.length}`;
          // best-effort: 이미 디코드한 path 보존
          return { startOffset, commandCount, path: path.trim(), error };
        }
      }
    } catch (err) {
      error = `${(err as Error).message} at offset ${offset - 1}`;
      return { startOffset, commandCount, path: path.trim(), error };
    }
  }
  return { startOffset, commandCount, path: path.trim(), error };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Number(n.toFixed(3)).toString();
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function pickFill(data: Record<string, unknown>): string {
  const fills = data.fillPaints as Array<Record<string, unknown>> | undefined;
  const first = fills?.find((f) => f.type === 'SOLID' && (f.visible ?? true) !== false);
  if (first) {
    const c = first.color as { r?: number; g?: number; b?: number; a?: number } | undefined;
    if (c) return paintToCss(c);
  }
  return 'currentColor';
}

function pickStroke(data: Record<string, unknown>): string {
  const strokes = data.strokePaints as Array<Record<string, unknown>> | undefined;
  const first = strokes?.find((f) => f.type === 'SOLID' && (f.visible ?? true) !== false);
  if (first) {
    const c = first.color as { r?: number; g?: number; b?: number; a?: number } | undefined;
    if (c) return paintToCss(c);
  }
  return 'currentColor';
}

function pickStrokeWeight(data: Record<string, unknown>): number {
  const w = data.strokeWeight;
  return typeof w === 'number' && w > 0 ? w : 1;
}

function paintToCss(c: { r?: number; g?: number; b?: number; a?: number }): string {
  const r = Math.round((c.r ?? 0) * 255);
  const g = Math.round((c.g ?? 0) * 255);
  const b = Math.round((c.b ?? 0) * 255);
  const a = c.a ?? 1;
  return a < 1 ? `rgba(${r},${g},${b},${a.toFixed(3)})` : `rgb(${r},${g},${b})`;
}
