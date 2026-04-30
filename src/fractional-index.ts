/**
 * Fractional indexing — 두 형제 사이에 새 위치 문자열 생성.
 * spec: docs/specs/parent-index-position.spec.md
 *
 * Figma의 parentIndex.position은 lexicographic 정렬되는 짧은 문자열.
 * 두 형제 사이에 새 형제를 끼울 때, 양쪽 사이의 새 문자열이 필요하다.
 *
 * 본 모듈은 ASCII printable [0x20, 0x7E] 알파벳 사용.
 */

const ALPHABET_START = 0x21; // '!' — 0x20 (space)는 양 끝 패딩 안 좋아 제외
const ALPHABET_END = 0x7e; // '~'
const MAX_LENGTH = 64;

/** 두 위치 사이의 lex-strictly-between 새 위치 생성 */
export function between(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`between: a (${a}) must be < b (${b})`);
  }

  const minLen = Math.max((a?.length ?? 1), (b?.length ?? 1));
  const aPadded = (a ?? '').padEnd(minLen, String.fromCharCode(ALPHABET_START));
  const bPadded = (b ?? '').padEnd(minLen, String.fromCharCode(ALPHABET_END));

  let result = '';
  for (let i = 0; i < minLen; i++) {
    const aChar = aPadded.charCodeAt(i);
    const bChar = bPadded.charCodeAt(i);
    if (aChar === bChar) {
      result += String.fromCharCode(aChar);
      continue;
    }
    const midChar = Math.floor((aChar + bChar) / 2);
    if (midChar > aChar) {
      // 충분한 거리 — i까지 prefix + midChar 끝
      result += String.fromCharCode(midChar);
      return result;
    }
    // 매우 가까움 — aChar 그대로 두고 다음 char에 ALPHABET_START + 1
    result += String.fromCharCode(aChar);
    result += String.fromCharCode(ALPHABET_START + 1);
    return result;
  }

  // 모든 prefix 동일 → append minimum + 1
  result += String.fromCharCode(ALPHABET_START + 1);
  if (result.length > MAX_LENGTH) {
    throw new Error(
      `between: result exceeds max length (${MAX_LENGTH}). Consider regenerate().`,
    );
  }
  return result;
}

/** 균등 간격으로 n개 위치 생성 */
export function regenerate(n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [String.fromCharCode((ALPHABET_START + ALPHABET_END) >> 1)];

  const range = ALPHABET_END - ALPHABET_START;
  const step = range / (n + 1);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = ALPHABET_START + Math.round(step * (i + 1));
    out.push(String.fromCharCode(c));
  }
  return out;
}

/** Lexicographic 비교 */
export function compare(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
