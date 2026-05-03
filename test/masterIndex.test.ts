/**
 * masterIndex.ts — GUID → Master lookup, shared between CLI and web.
 *
 * Spec: docs/specs/expansion-context.spec.md §3.4
 */
import { describe, expect, it } from 'vitest';
import { buildMasterIndex } from '../src/masterIndex.js';
import type { TreeNode } from '../src/types.js';

function node(type: string, localID: number): TreeNode {
  return {
    guid: { sessionID: 0, localID },
    guidStr: `0:${localID}`,
    type,
    name: `${type}_${localID}`,
    children: [],
    data: {},
  };
}

describe('buildMasterIndex', () => {
  it('returns an empty map for an empty input', () => {
    expect(buildMasterIndex([]).size).toBe(0);
    expect(buildMasterIndex(new Map()).size).toBe(0);
  });

  it('indexes SYMBOL / COMPONENT / COMPONENT_SET nodes only', () => {
    const nodes = [
      node('SYMBOL', 1),
      node('COMPONENT', 2),
      node('COMPONENT_SET', 3),
      node('FRAME', 4),
      node('TEXT', 5),
      node('VECTOR', 6),
      node('INSTANCE', 7),
    ];
    const idx = buildMasterIndex(nodes);
    expect(idx.size).toBe(3);
    expect(idx.get('0:1')?.type).toBe('SYMBOL');
    expect(idx.get('0:2')?.type).toBe('COMPONENT');
    expect(idx.get('0:3')?.type).toBe('COMPONENT_SET');
    // Non-master types are NOT indexed — guards against an INSTANCE
    // accidentally resolving to a non-master node sharing a GUID.
    expect(idx.get('0:4')).toBeUndefined();
    expect(idx.get('0:5')).toBeUndefined();
    expect(idx.get('0:7')).toBeUndefined();
  });

  it('accepts a Map<string, TreeNode> input (CLI buildTree shape)', () => {
    const m = new Map<string, TreeNode>();
    m.set('0:1', node('SYMBOL', 1));
    m.set('0:2', node('FRAME', 2));
    const idx = buildMasterIndex(m);
    expect(idx.size).toBe(1);
    expect(idx.get('0:1')?.type).toBe('SYMBOL');
  });

  it('last entry wins on duplicate GUID (corrupt-data guard)', () => {
    const a = node('SYMBOL', 5);
    const b = node('SYMBOL', 5);
    b.name = 'second';
    const idx = buildMasterIndex([a, b]);
    expect(idx.get('0:5')?.name).toBe('second');
  });
});
