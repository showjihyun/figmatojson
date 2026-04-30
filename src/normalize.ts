/**
 * Iteration 7: REST API 호환 정규화 (PRD §4.2 F-PROC-09, §10 결정 b)
 *
 * 정책: "실용형(b)" — Kiwi 원본 키를 보존하면서 REST API 별칭 추가.
 * 양쪽 모두 grep 가능하게 한다.
 *
 * 주요 매핑:
 *   - guid (sessionID:localID) → id ("S:L" 문자열)
 *   - parentIndex.guid → parentId
 *   - size + transform → absoluteBoundingBox (best-effort)
 *   - fillPaints → fills (alias)
 *   - strokePaints → strokes (alias)
 *   - effects → effects (그대로)
 *   - 노드 트리 평탄화: data 필드를 풀어 children + 별칭 부여
 */

import { hashToHex } from './assets.js';
import { guidKey } from './tree.js';
import type { GUID, TreeNode } from './types.js';

export interface NormalizedNode {
  id: string;
  guid: GUID;
  type: string;
  name?: string;
  visible?: boolean;
  parentId?: string;
  /** REST API 별칭 (있을 때만) */
  fills?: unknown;
  strokes?: unknown;
  effects?: unknown;
  /** Bounding box (best-effort: size + 부모상대 transform 기반) */
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  /** 자식 노드들 — 재귀 */
  children?: NormalizedNode[];
  /** Kiwi 원본 데이터 (별칭 추가 후) */
  raw: Record<string, unknown>;
}

export function normalizeTree(root: TreeNode | null): NormalizedNode | null {
  if (!root) return null;
  return normalizeNode(root);
}

function normalizeNode(tn: TreeNode): NormalizedNode {
  const data = tn.data as Record<string, unknown>;

  const out: NormalizedNode = {
    id: tn.guidStr,
    guid: tn.guid,
    type: tn.type,
    name: tn.name,
    parentId: tn.parentGuid ? guidKey(tn.parentGuid) : undefined,
    raw: serializableRaw(data),
  };

  if (typeof data.visible === 'boolean') out.visible = data.visible;

  // fills / strokes 별칭
  if ('fillPaints' in data) out.fills = out.raw.fillPaints;
  if ('strokePaints' in data) out.strokes = out.raw.strokePaints;
  if ('effects' in data) out.effects = out.raw.effects;

  // absoluteBoundingBox (best-effort)
  const bbox = computeBoundingBox(data);
  if (bbox) out.absoluteBoundingBox = bbox;

  // 자식 노드 (CANVAS 내부, FRAME 등)
  if (tn.children.length > 0) {
    out.children = tn.children.map(normalizeNode);
  }

  return out;
}

/**
 * kiwi-decoded raw 객체를 직렬화 안전한 형태로 변환:
 *   - Uint8Array → hex 문자열 (Buffer.toString('hex'))
 *   - BigInt → string
 *   - 그 외는 deep clone하지 않음 (이미 우리가 read-only)
 *
 * Kiwi-decoded 데이터는 트리 구조라 cycle 없음 → WeakMap cache 제거.
 *
 * 추가 최적화: 객체 안의 모든 값이 primitive면 새 객체 생성 없이 원본 반환.
 * (raw 보존 모드에서는 일부 deep copy가 필요 없을 수 있으나, 안전을 위해 항상 복사)
 */
function serializableRaw(value: unknown): Record<string, unknown> {
  return convert(value) as Record<string, unknown>;
}

function convert(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'bigint') return (value as bigint).toString();
  if (t !== 'object') return value;
  if (value instanceof Uint8Array) return hashToHex(value);

  if (Array.isArray(value)) {
    const len = value.length;
    const arr = new Array(len);
    for (let i = 0; i < len; i++) arr[i] = convert(value[i]);
    return arr;
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    out[k] = convert(obj[k]);
  }
  return out;
}

/** size + transform → absoluteBoundingBox (root-relative; canvas 좌표계 가정) */
function computeBoundingBox(
  data: Record<string, unknown>,
): { x: number; y: number; width: number; height: number } | undefined {
  const size = data.size as { x?: number; y?: number } | undefined;
  const transform = data.transform as
    | { m00?: number; m01?: number; m02?: number; m10?: number; m11?: number; m12?: number }
    | undefined;

  if (!size || typeof size.x !== 'number' || typeof size.y !== 'number') return undefined;
  if (!transform) {
    return { x: 0, y: 0, width: size.x, height: size.y };
  }
  // m02, m12 = translation 컴포넌트 (회전·스케일 무시한 best-effort)
  return {
    x: typeof transform.m02 === 'number' ? transform.m02 : 0,
    y: typeof transform.m12 === 'number' ? transform.m12 : 0,
    width: size.x,
    height: size.y,
  };
}
