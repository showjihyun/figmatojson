/**
 * Iteration 6: 이미지 해시 ↔ imageRef 매핑 + magic 기반 확장자 추론
 * (PRD §4.2 F-PROC-07, §1.2.4)
 *
 * - images/ 디렉토리의 파일명 = 컨텐츠 해시 (확장자 없음)
 * - magic 8 bytes 검사로 PNG/JPEG/GIF/WebP/SVG/PDF 추론
 * - 노드 트리 walk → image.hash, fillPaints[*].image.hash 등에서 hash 수집
 */

import type { TreeNode } from './types.js';

const MAGICS: Array<{ ext: string; magic: number[] }> = [
  { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
];

export function detectImageExt(buf: Uint8Array): string {
  if (buf.length < 4) return 'bin';

  // WebP: RIFF....WEBP (offset 8-11)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }

  // SVG: '<svg' or '<?xml' 시작
  const head = String.fromCharCode(...buf.slice(0, Math.min(buf.length, 16)));
  if (/^\s*<\?xml/.test(head) || /^\s*<svg/i.test(head)) return 'svg';

  for (const { ext, magic } of MAGICS) {
    let ok = true;
    for (let i = 0; i < magic.length; i++) {
      if (buf[i] !== magic[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return ext;
  }
  return 'bin';
}

/**
 * Uint8Array hash → hex 문자열.
 * Buffer.from(typedArray).toString('hex')는 Array.from + map + join보다
 * 5-10배 빠르다 (V8 native path).
 */
export function hashToHex(hash: unknown): string | null {
  if (!hash) return null;
  if (typeof hash === 'string') return hash.toLowerCase();
  if (hash instanceof Uint8Array) {
    // Buffer.from은 Uint8Array를 zero-copy view로 감싼다
    return Buffer.from(hash.buffer, hash.byteOffset, hash.byteLength).toString('hex');
  }
  return null;
}

/**
 * 노드 트리 전체를 재귀 walk하여 imageRef 후보 수집.
 * Kiwi-decoded 데이터는 트리 구조이므로 cycle 보호 불필요 → WeakSet 제거.
 */
export function collectImageRefs(root: TreeNode | null): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  if (!root) return refs;

  const visit = (node: TreeNode): void => {
    walkValue(node.data, node.guidStr, refs);
    for (const c of node.children) visit(c);
  };
  visit(root);
  return refs;
}

function walkValue(
  value: unknown,
  ownerGuid: string,
  refs: Map<string, Set<string>>,
): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (value instanceof Uint8Array) return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walkValue(value[i], ownerGuid, refs);
    return;
  }

  const obj = value as Record<string, unknown>;

  // 직접적인 image.hash 패턴
  const imageObj = obj.image as Record<string, unknown> | undefined;
  if (imageObj && typeof imageObj === 'object') {
    const h = hashToHex(imageObj.hash);
    if (h) addRef(refs, h, ownerGuid);
  }

  // 자기 자신이 hash 필드를 가진 경우 (Image 메시지 같은 곳에서 직접 등장)
  const ownHash = obj.hash;
  if (ownHash instanceof Uint8Array || typeof ownHash === 'string') {
    const h = hashToHex(ownHash);
    if (h) addRef(refs, h, ownerGuid);
  }

  // imageRef (REST API 명세 호환)
  if (typeof obj.imageRef === 'string') {
    addRef(refs, obj.imageRef.toLowerCase(), ownerGuid);
  }

  // for...in이 Object.keys()보다 약간 빠르고 hidden class 캐시에 우호적
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    walkValue(obj[key], ownerGuid, refs);
  }
}

function addRef(refs: Map<string, Set<string>>, hash: string, owner: string): void {
  const set = refs.get(hash) ?? new Set<string>();
  set.add(owner);
  refs.set(hash, set);
}
