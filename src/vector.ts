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

export function decodeCommandsBlob(bytes: Uint8Array): string {
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
          // Figma binary command 0x03 = QUAD (4 floats = 16 bytes)
          // (이전엔 CUBIC으로 잘못 해석 → 0x04와 의미가 swap돼 있던 게 root cause)
          if (offset + 16 > bytes.length) throw new Error(`truncated QUAD`);
          path += `Q${fmt(view.getFloat32(offset, true))} ${fmt(view.getFloat32(offset + 4, true))} ${fmt(view.getFloat32(offset + 8, true))} ${fmt(view.getFloat32(offset + 12, true))} `;
          offset += 16;
          commandCount++;
          break;
        }
        case 0x04: {
          // Figma binary command 0x04 = CUBIC (6 floats = 24 bytes). 아이콘 곡선 대부분이 이 cmd로 인코딩됨.
          if (offset + 24 > bytes.length) throw new Error(`truncated CUBIC`);
          path += `C${fmt(view.getFloat32(offset, true))} ${fmt(view.getFloat32(offset + 4, true))} ${fmt(view.getFloat32(offset + 8, true))} ${fmt(view.getFloat32(offset + 12, true))} ${fmt(view.getFloat32(offset + 16, true))} ${fmt(view.getFloat32(offset + 20, true))} `;
          offset += 24;
          commandCount++;
          break;
        }
        case 0x05: {
          path += 'Z ';
          commandCount++;
          break;
        }
        case 0x00: {
          // Subpath separator / no-op marker. 다음 cmd로 계속 진행.
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
  // 디코드된 float32 → string. 정밀도 손실 없이 그대로 직렬화.
  // (이전엔 toFixed(5)로 잘랐다가 absolute→relative 변환 시 마지막 자리 drift 발생.)
  // SVG/Pen 출력용 후처리(absoluteToRelative)에서 5자리로 반올림.
  return n.toString();
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

// ---------------------------------------------------------------------------
// VectorNetwork blob decoder — pencil.dev 가 path 의 진짜 source 로 사용하는 포맷.
// reverse-engineered from Pencil v1.1.55 (app.asar / parseVectorNetworkBlob).
// ---------------------------------------------------------------------------

export interface VNVertex { styleID: number; x: number; y: number; }
export interface VNTangent { vertex: number; dx: number; dy: number; }
export interface VNSegment { styleID: number; start: VNTangent; end: VNTangent; }
export interface VNRegion { styleID: number; windingRule: 'NONZERO' | 'ODD'; loops: Array<{ segments: number[] }>; }
export interface VectorNetwork { vertices: VNVertex[]; segments: VNSegment[]; regions: VNRegion[]; }

/**
 * vectorNetworkBlob 바이너리 디코더.
 *
 * 포맷 (LE uint32 / float32):
 *   header (12B): vertexCount, segmentCount, regionCount
 *   vertex (12B × N): styleID, x (f32), y (f32)
 *   segment (28B × M): styleID, start.{vertex (u32), dx (f32), dy (f32)},
 *                       end.{vertex (u32), dx (f32), dy (f32)}
 *   region (variable × R): packed (styleID|winding low-bit) (u32), loopCount (u32)
 *                          loop: segmentCount (u32), segmentIndex × N (u32)
 *
 * loop 의 windingRule: 첫 비트 1 = NONZERO, 0 = ODD.
 */
export function parseVectorNetworkBlob(bytes: Uint8Array): VectorNetwork | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const vertexCount = view.getUint32(off, true); off += 4;
  const segmentCount = view.getUint32(off, true); off += 4;
  const regionCount = view.getUint32(off, true); off += 4;

  const vertices: VNVertex[] = [];
  for (let i = 0; i < vertexCount; i++) {
    if (off + 12 > bytes.length) return null;
    vertices.push({
      styleID: view.getUint32(off, true),
      x: view.getFloat32(off + 4, true),
      y: view.getFloat32(off + 8, true),
    });
    off += 12;
  }

  const segments: VNSegment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    if (off + 28 > bytes.length) return null;
    const startVertex = view.getUint32(off + 4, true);
    const endVertex = view.getUint32(off + 16, true);
    if (startVertex >= vertexCount || endVertex >= vertexCount) return null;
    segments.push({
      styleID: view.getUint32(off, true),
      start: {
        vertex: startVertex,
        dx: view.getFloat32(off + 8, true),
        dy: view.getFloat32(off + 12, true),
      },
      end: {
        vertex: endVertex,
        dx: view.getFloat32(off + 20, true),
        dy: view.getFloat32(off + 24, true),
      },
    });
    off += 28;
  }

  const regions: VNRegion[] = [];
  for (let i = 0; i < regionCount; i++) {
    if (off + 8 > bytes.length) return null;
    let packed = view.getUint32(off, true);
    const winding: 'NONZERO' | 'ODD' = (packed & 1) ? 'NONZERO' : 'ODD';
    packed >>= 1;
    const loopCount = view.getUint32(off + 4, true);
    off += 8;
    const loops: Array<{ segments: number[] }> = [];
    for (let j = 0; j < loopCount; j++) {
      if (off + 4 > bytes.length) return null;
      const segCount = view.getUint32(off, true);
      off += 4;
      if (off + segCount * 4 > bytes.length) return null;
      const segs: number[] = [];
      for (let k = 0; k < segCount; k++) {
        const idx = view.getUint32(off, true);
        if (idx >= segmentCount) return null;
        segs.push(idx);
        off += 4;
      }
      loops.push({ segments: segs });
    }
    regions.push({ styleID: packed, windingRule: winding, loops });
  }

  return { vertices, segments, regions };
}

/** 단일 segment 를 in-place 로 뒤집음 (start ↔ end). pencil.dev `AQ`. */
function reverseSegment(s: VNSegment): void {
  const ev = s.start.vertex, edx = s.start.dx, edy = s.start.dy;
  s.start.vertex = s.end.vertex; s.start.dx = s.end.dx; s.start.dy = s.end.dy;
  s.end.vertex = ev; s.end.dx = edx; s.end.dy = edy;
}

/**
 * loop 의 segments 를 연속된 endpoint 로 정렬 (필요 시 뒤집음). pencil.dev `EQ`.
 * region.loops[].segments 는 단순 인덱스 배열이라 segment 의 start/end 가 자연 순서가 아닐 수 있음.
 */
function orientSegments(segs: VNSegment[]): VNSegment[] {
  if (segs.length < 2) return segs;
  const out = segs.map((s) => ({ ...s, start: { ...s.start }, end: { ...s.end } }));
  if (out[0]!.end.vertex !== out[1]!.start.vertex && out[0]!.end.vertex !== out[1]!.end.vertex) {
    reverseSegment(out[0]!);
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i - 1]!.end.vertex !== out[i]!.start.vertex) reverseSegment(out[i]!);
  }
  return out;
}

/**
 * pencil.dev `xQ`: 정렬된 segments 를 path command 시퀀스로 변환.
 * 반환값은 SVG path 문자열 (absolute commands, M/L/C/Z). `n.toString()` 으로 정밀도 손실 없이 직렬화.
 *
 * pencil 동작:
 *   - 새 subpath 시작 (이전 endpoint != current start) → moveTo
 *   - 양쪽 tangent 가 모두 0 → lineTo (직선)
 *   - 그 외 → cubicTo (control1 = start + tangent_in, control2 = end + tangent_out)
 *   - subpath 가 startVertex 로 돌아오면 close
 */
function buildPathFromSegments(vertices: VNVertex[], segs: VNSegment[]): string {
  let path = '';
  let lastVertex: number | undefined;
  let subpathStart: number | undefined;
  for (const s of segs) {
    const sv = s.start.vertex, a = vertices[sv]!;
    const ev = s.end.vertex, b = vertices[ev]!;
    if (lastVertex !== sv) {
      path += `M${fmt(a.x)} ${fmt(a.y)} `;
      subpathStart = sv;
    }
    if (s.start.dx === 0 && s.start.dy === 0 && s.end.dx === 0 && s.end.dy === 0) {
      path += `L${fmt(b.x)} ${fmt(b.y)} `;
    } else {
      path +=
        `C${fmt(a.x + s.start.dx)} ${fmt(a.y + s.start.dy)} ` +
        `${fmt(b.x + s.end.dx)} ${fmt(b.y + s.end.dy)} ` +
        `${fmt(b.x)} ${fmt(b.y)} `;
    }
    lastVertex = ev;
    if (subpathStart !== undefined && ev === subpathStart) {
      path += 'Z ';
      lastVertex = undefined;
      subpathStart = undefined;
    }
  }
  return path.trim();
}

/**
 * vectorNetworkBlob → SVG path (absolute). pencil.dev 와 정확히 동일한 알고리즘.
 * 반환값은 후처리(absoluteToRelative) 입력으로 적합.
 */
export function vectorNetworkToPath(vn: VectorNetwork): string {
  if (vn.regions.length > 0) {
    // fill 영역이 있는 경우: 각 region 의 각 loop 별로 segments 정렬 후 path 생성
    const parts: string[] = [];
    const used = new Set<number>();
    for (const region of vn.regions) {
      for (const loop of region.loops) {
        if (loop.segments.length === 0) continue;
        for (const idx of loop.segments) used.add(idx);
        const segs = loop.segments.map((idx) => vn.segments[idx]!);
        parts.push(buildPathFromSegments(vn.vertices, orientSegments(segs)));
      }
    }
    // I-V7a — orphan stroke-only segments (line that no region/loop refs).
    // HPAI 700:319 has 6 such segments (the connecting line of the icon).
    // No orient: orphan list is typically disconnected; orientSegments would
    // make spurious reversals. buildPathFromSegments inserts a fresh M
    // whenever the chain breaks, which is the correct behavior for
    // disconnected lines.
    const orphans: VNSegment[] = [];
    for (let i = 0; i < vn.segments.length; i++) {
      if (!used.has(i)) orphans.push(vn.segments[i]!);
    }
    if (orphans.length > 0) {
      parts.push(buildPathFromSegments(vn.vertices, orphans));
    }
    return parts.filter((p) => p.length > 0).join(' ');
  }
  // region 없음 (stroke-only / line). 모든 segments 를 한 path 로.
  if (vn.segments.length === 0) return '';
  return buildPathFromSegments(vn.vertices, orientSegments(vn.segments));
}
