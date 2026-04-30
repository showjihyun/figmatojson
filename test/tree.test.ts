/**
 * tree.ts — parent-child 트리 재구성 + position 기반 정렬
 */
import { describe, expect, it } from 'vitest';
import { buildTree, getPages, guidKey } from '../src/tree.js';
import type { KiwiMessage, KiwiNode } from '../src/types.js';

function node(
  guid: string,
  type: string,
  parent?: string,
  position?: string,
  name?: string,
): KiwiNode {
  const [s, l] = guid.split(':').map(Number);
  const out: KiwiNode = {
    guid: { sessionID: s!, localID: l! },
    type,
    name,
  };
  if (parent !== undefined) {
    const [ps, pl] = parent.split(':').map(Number);
    out.parentIndex = {
      guid: { sessionID: ps!, localID: pl! },
      position: position ?? '',
    };
  }
  return out;
}

describe('guidKey', () => {
  it('formats as session:local', () => {
    expect(guidKey({ sessionID: 4, localID: 187 })).toBe('4:187');
  });
  it('handles undefined gracefully', () => {
    expect(guidKey(undefined)).toBe('');
  });
});

describe('buildTree', () => {
  it('builds DOCUMENT → CANVAS → FRAME hierarchy', () => {
    const message: KiwiMessage = {
      nodeChanges: [
        node('0:0', 'DOCUMENT'),
        node('0:1', 'CANVAS', '0:0', 'a'),
        node('1:5', 'FRAME', '0:1', 'a'),
      ],
    };
    const result = buildTree(message);
    expect(result.document?.type).toBe('DOCUMENT');
    expect(result.document?.children.length).toBe(1);
    expect(result.document?.children[0]!.type).toBe('CANVAS');
    expect(result.document?.children[0]!.children[0]!.type).toBe('FRAME');
    expect(result.allNodes.size).toBe(3);
    expect(result.orphans.length).toBe(0);
  });

  it('sorts children by position string (fractional indexing)', () => {
    const message: KiwiMessage = {
      nodeChanges: [
        node('0:0', 'DOCUMENT'),
        node('0:1', 'CANVAS', '0:0', 'b'),
        node('0:2', 'CANVAS', '0:0', 'a'),
        node('0:3', 'CANVAS', '0:0', 'c'),
      ],
    };
    const result = buildTree(message);
    const pages = getPages(result.document);
    expect(pages.map((p) => p.guidStr)).toEqual(['0:2', '0:1', '0:3']);
  });

  it('classifies nodes with missing parent as orphans', () => {
    const message: KiwiMessage = {
      nodeChanges: [
        node('0:0', 'DOCUMENT'),
        node('0:1', 'CANVAS', '99:99', 'a'), // parent doesn't exist
      ],
    };
    const result = buildTree(message);
    expect(result.orphans.length).toBe(1);
    expect(result.orphans[0]!.guidStr).toBe('0:1');
  });

  it('handles empty message', () => {
    const result = buildTree({} as KiwiMessage);
    expect(result.document).toBeNull();
    expect(result.allNodes.size).toBe(0);
  });

  it('only one DOCUMENT becomes the root, rest are orphans', () => {
    const message: KiwiMessage = {
      nodeChanges: [
        node('0:0', 'DOCUMENT'),
        node('1:0', 'DOCUMENT'),
      ],
    };
    const result = buildTree(message);
    expect(result.document?.guidStr).toBe('0:0');
    expect(result.orphans.length).toBe(1);
    expect(result.orphans[0]!.guidStr).toBe('1:0');
  });
});

describe('getPages', () => {
  it('returns only CANVAS children of DOCUMENT', () => {
    const message: KiwiMessage = {
      nodeChanges: [
        node('0:0', 'DOCUMENT'),
        node('0:1', 'CANVAS', '0:0', 'a'),
        node('0:2', 'FRAME', '0:0', 'b'), // 비-CANVAS는 페이지 아님
      ],
    };
    const result = buildTree(message);
    expect(getPages(result.document).length).toBe(1);
  });

  it('returns empty for null', () => {
    expect(getPages(null)).toEqual([]);
  });
});
