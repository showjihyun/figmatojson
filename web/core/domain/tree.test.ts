import { describe, expect, it } from 'vitest';
import {
  buildAncestorIndex,
  buildAncestorIndexDeep,
  findById,
  findByIdDeep,
} from './tree';

interface N {
  id?: string;
  guid?: { sessionID: number; localID: number };
  type?: string;
  children?: N[];
  _renderChildren?: N[];
  _isInstanceChild?: boolean;
}

function n(sid: number, lid: number, type: string, kids?: N[], rkids?: N[]): N {
  return {
    id: `${sid}:${lid}`,
    guid: { sessionID: sid, localID: lid },
    type,
    ...(kids ? { children: kids } : {}),
    ...(rkids ? { _renderChildren: rkids } : {}),
  };
}

describe('buildAncestorIndex (shallow — .children only)', () => {
  it('records the page-relative ancestor chain for every reachable descendant', () => {
    const page: N = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      children: [
        n(0, 1, 'FRAME', [
          n(0, 2, 'FRAME', [n(0, 3, 'TEXT')]),
        ]),
      ],
    };
    const idx = buildAncestorIndex(page);
    expect(idx.get('0:1')).toEqual([]);
    expect(idx.get('0:2')).toEqual(['0:1']);
    expect(idx.get('0:3')).toEqual(['0:1', '0:2']);
  });

  it('does NOT cross into _renderChildren (LayerTree treats instances as collapsed)', () => {
    const page: N = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      children: [
        n(0, 9289, 'INSTANCE', undefined, [
          { ...n(1, 9209, 'FRAME'), _isInstanceChild: true } as N,
        ]),
      ],
    };
    const idx = buildAncestorIndex(page);
    expect(idx.has('0:9289')).toBe(true);
    expect(idx.has('1:9209')).toBe(false);
  });
});

describe('buildAncestorIndexDeep — walks .children AND _renderChildren', () => {
  it('chains a master subtree descendant back through its outer INSTANCE', () => {
    const page: N = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      children: [
        n(0, 9289, 'INSTANCE', undefined, [
          {
            ...n(1, 9209, 'FRAME', [
              { ...n(1, 9211, 'FRAME', [
                { ...n(1, 9212, 'INSTANCE', undefined, [
                  { ...n(2, 1000, 'TEXT'), _isInstanceChild: true } as N,
                ]), _isInstanceChild: true } as N,
              ]), _isInstanceChild: true } as N,
            ]),
            _isInstanceChild: true,
          } as N,
        ]),
      ],
    };
    const idx = buildAncestorIndexDeep(page);
    expect(idx.get('0:9289')).toEqual([]);
    expect(idx.get('1:9209')).toEqual(['0:9289']);
    expect(idx.get('1:9211')).toEqual(['0:9289', '1:9209']);
    expect(idx.get('1:9212')).toEqual(['0:9289', '1:9209', '1:9211']);
    expect(idx.get('2:1000')).toEqual(['0:9289', '1:9209', '1:9211', '1:9212']);
  });

  it('reuses the first-seen chain when twin instances share descendant guids', () => {
    // Two top-level INSTANCEs of the same master both render a 2:1000 TEXT.
    // The map captures the FIRST occurrence's chain — drill consumers don't
    // need per-copy disambiguation (selection bubbles to the outer INSTANCE
    // anyway), and the alternative (last-wins overwrites) would silently
    // change behaviour as page order shifted.
    const master = (): N => ({
      ...n(1, 9209, 'FRAME'),
      _isInstanceChild: true,
    } as N);
    const page: N = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      children: [
        n(0, 9289, 'INSTANCE', undefined, [master()]),
        n(0, 9388, 'INSTANCE', undefined, [master()]),
      ],
    };
    const idx = buildAncestorIndexDeep(page);
    expect(idx.get('1:9209')).toEqual(['0:9289']); // first wins
  });
});

describe('findByIdDeep — walks .children AND _renderChildren', () => {
  it('finds a master subtree descendant inside an INSTANCE expansion', () => {
    const text = { ...n(2, 1000, 'TEXT'), _isInstanceChild: true } as N;
    const page: N = {
      id: '0:100',
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      children: [
        n(0, 9289, 'INSTANCE', undefined, [
          {
            ...n(1, 9209, 'FRAME', [text]),
            _isInstanceChild: true,
          } as N,
        ]),
      ],
    };
    expect(findById(page, '2:1000')).toBeNull();
    expect(findByIdDeep(page, '2:1000')).toBe(text);
  });

  it('still finds page-resident nodes (no regression vs findById)', () => {
    const text = n(0, 3, 'TEXT');
    const page: N = {
      id: '0:100',
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      children: [n(0, 1, 'FRAME', [n(0, 2, 'FRAME', [text])])],
    };
    expect(findByIdDeep(page, '0:3')).toBe(text);
    expect(findById(page, '0:3')).toBe(text);
  });
});
