/**
 * pen-export — visibility resolution behavior.
 *
 * Pencil .pen 형식에서 노드의 enabled:false (= 숨김)는 세 메커니즘에서 비롯:
 *   (a) master 노드 자체가 visible:false
 *   (b) INSTANCE의 componentPropAssignments(boolValue:false)가
 *       master 자손의 componentPropRefs(VISIBLE)에 매핑됨
 *   (c) INSTANCE.symbolData.symbolOverrides[].visible 가 자손 가시성 override
 *
 * 본 테스트는 합성된 최소 트리로 generatePenExport를 호출해 결과 JSON을 검사.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePenExport } from '../src/pen-export.js';
import type { BuildTreeResult, ContainerResult, TreeNode, KiwiNode } from '../src/types.js';
import type { DecodedFig } from '../src/decoder.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'figrev-pen-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Test helpers ─────────────────────────────────────────────────────────

interface NodeSpec {
  guid: { sessionID: number; localID: number };
  type: string;
  name?: string;
  data?: Partial<KiwiNode>;
  children?: NodeSpec[];
}

function makeNode(spec: NodeSpec, parent?: { guid: { sessionID: number; localID: number } }): TreeNode {
  const guidStr = `${spec.guid.sessionID}:${spec.guid.localID}`;
  const node: TreeNode = {
    guid: spec.guid,
    guidStr,
    type: spec.type,
    name: spec.name,
    parentGuid: parent?.guid,
    children: [],
    data: { guid: spec.guid, type: spec.type, name: spec.name, ...(spec.data ?? {}) } as KiwiNode,
  };
  if (spec.children) {
    node.children = spec.children.map((c) => makeNode(c, { guid: spec.guid }));
  }
  return node;
}

function buildTreeFrom(rootSpec: NodeSpec): BuildTreeResult {
  const document = makeNode(rootSpec);
  const allNodes = new Map<string, TreeNode>();
  const collect = (n: TreeNode) => {
    allNodes.set(n.guidStr, n);
    for (const c of n.children) collect(c);
  };
  collect(document);
  return { document, allNodes, orphans: [] };
}

function fakeDecoded(): DecodedFig {
  // generatePenExport는 archiveVersion + message.blobs만 읽음
  return {
    archiveVersion: 106,
    message: { blobs: [] },
    // 사용 안 함 - cast로 채움
  } as unknown as DecodedFig;
}

function fakeContainer(): ContainerResult {
  return {
    isZipWrapped: false,
    canvasFig: new Uint8Array([0]), // sha 계산용 1바이트
    images: new Map(),
  };
}

async function runExport(rootSpec: NodeSpec): Promise<Record<string, unknown>> {
  const tree = buildTreeFrom(rootSpec);
  await generatePenExport({
    tree,
    decoded: fakeDecoded(),
    container: fakeContainer(),
    outDir: tmp,
  });
  // 단일 페이지 가정: 00_<pageName>.pen.json
  const pageName = rootSpec.children?.[0]?.name ?? 'page-0';
  const safeName = pageName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  const filePath = join(tmp, `00_${safeName}.pen.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

interface PenNodeOut {
  type: string;
  name?: string;
  enabled?: boolean;
  x?: number;
  y?: number;
  width?: number | string;
  height?: number | string;
  children?: PenNodeOut[];
}

function findByName(root: PenNodeOut | { children?: PenNodeOut[] }, name: string): PenNodeOut[] {
  const out: PenNodeOut[] = [];
  function walk(n: { children?: PenNodeOut[] } & Partial<PenNodeOut>) {
    if (n.name === name && n.type) out.push(n as PenNodeOut);
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  }
  walk(root);
  return out;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('pen-export visibility', () => {
  it('emits CSS-relevant properties: gap, clip, textGrowth (regression — pencil.dev needs these for proper styling)', async () => {
    // 3 bugs found via reference comparison: gap (used wrong Figma field name),
    //   clip (used wrong field name), textGrowth (not emitted at all).
    // Pencil.dev needs each for: spacing between flex children, overflow handling,
    //   and width/height to take effect on text.
    const out = await runExport({
      guid: { sessionID: 0, localID: 1 },
      type: 'DOCUMENT',
      children: [
        {
          guid: { sessionID: 0, localID: 2 },
          type: 'CANVAS',
          name: 'Page',
          children: [
            {
              // (a) frame with stackSpacing:8 → expect gap:8
              // (b) frame with frameMaskDisabled:false → expect clip:true
              guid: { sessionID: 1, localID: 1 },
              type: 'FRAME',
              name: 'gappedClipped',
              data: {
                size: { x: 100, y: 50 },
                stackMode: 'HORIZONTAL',
                stackSpacing: 8,
                frameMaskDisabled: false,
              },
              children: [
                {
                  // (c) TEXT with textAutoResize:HEIGHT → expect textGrowth:"fixed-width"
                  guid: { sessionID: 1, localID: 2 },
                  type: 'TEXT',
                  name: 'wrappingText',
                  data: {
                    transform: { m02: 0, m12: 0 },
                    size: { x: 80, y: 14 },
                    textAutoResize: 'HEIGHT',
                  },
                },
                {
                  // textAutoResize NONE → fixed-width-height
                  guid: { sessionID: 1, localID: 3 },
                  type: 'TEXT',
                  name: 'fixedText',
                  data: {
                    transform: { m02: 0, m12: 0 },
                    size: { x: 80, y: 14 },
                    textAutoResize: 'NONE',
                  },
                },
                {
                  // textAutoResize WIDTH_AND_HEIGHT → omit (default 'auto')
                  guid: { sessionID: 1, localID: 4 },
                  type: 'TEXT',
                  name: 'autoText',
                  data: {
                    transform: { m02: 0, m12: 0 },
                    size: { x: 80, y: 14 },
                    textAutoResize: 'WIDTH_AND_HEIGHT',
                  },
                },
              ],
            },
            {
              // frame with frameMaskDisabled:true → no clip emitted
              guid: { sessionID: 1, localID: 5 },
              type: 'FRAME',
              name: 'unclipped',
              data: {
                transform: { m02: 200, m12: 0 },
                size: { x: 100, y: 50 },
                frameMaskDisabled: true,
              },
            },
          ],
        },
      ],
    });

    const gappedClipped = findByName(out, 'gappedClipped')[0]!;
    expect((gappedClipped as { gap?: number }).gap).toBe(8);
    expect((gappedClipped as { clip?: boolean }).clip).toBe(true);

    const unclipped = findByName(out, 'unclipped')[0]!;
    expect((unclipped as { clip?: boolean }).clip).toBeUndefined();

    const wrap = findByName(out, 'wrappingText')[0]!;
    expect((wrap as { textGrowth?: string }).textGrowth).toBe('fixed-width');

    const fixed = findByName(out, 'fixedText')[0]!;
    expect((fixed as { textGrowth?: string }).textGrowth).toBe('fixed-width-height');

    const auto = findByName(out, 'autoText')[0]!;
    expect((auto as { textGrowth?: string }).textGrowth).toBeUndefined(); // 'auto' is default → omit
  });

  it('emits enabled:false for direct visible:false on master node', async () => {
    const out = await runExport({
      guid: { sessionID: 0, localID: 1 },
      type: 'DOCUMENT',
      children: [
        {
          guid: { sessionID: 0, localID: 2 },
          type: 'CANVAS',
          name: 'Page',
          children: [
            {
              guid: { sessionID: 1, localID: 1 },
              type: 'FRAME',
              name: 'container',
              data: { size: { x: 100, y: 50 } },
              children: [
                {
                  guid: { sessionID: 1, localID: 2 },
                  type: 'TEXT',
                  name: 'visibleText',
                  data: { visible: true, transform: { m02: 0, m12: 0 }, size: { x: 50, y: 14 } },
                },
                {
                  guid: { sessionID: 1, localID: 3 },
                  type: 'TEXT',
                  name: 'hiddenText',
                  data: { visible: false, transform: { m02: 10, m12: 20 }, size: { x: 50, y: 14 } },
                },
              ],
            },
          ],
        },
      ],
    });

    const visible = findByName(out, 'visibleText');
    const hidden = findByName(out, 'hiddenText');
    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(1);
    expect(visible[0]!.enabled).toBeUndefined();
    expect(hidden[0]!.enabled).toBe(false);
  });

  it('emits enabled:false when INSTANCE.componentPropAssignments + master child componentPropRefs(VISIBLE) toggle to false', async () => {
    // 시나리오: master에 prop def(16:1)이 있고, 자식 TEXT가 그 prop을 VISIBLE로 reference.
    // INSTANCE는 16:1=false → 자식 TEXT는 instance에서 hidden.
    const out = await runExport({
      guid: { sessionID: 0, localID: 1 },
      type: 'DOCUMENT',
      children: [
        {
          guid: { sessionID: 0, localID: 2 },
          type: 'CANVAS',
          name: 'Page',
          children: [
            // master SYMBOL with controlled child
            {
              guid: { sessionID: 11, localID: 100 },
              type: 'SYMBOL',
              name: 'masterFrame',
              data: {
                size: { x: 100, y: 50 },
                componentPropDefs: [{ id: { sessionID: 16, localID: 1 } }],
              },
              children: [
                {
                  guid: { sessionID: 11, localID: 101 },
                  type: 'TEXT',
                  name: 'controlledText',
                  data: {
                    visible: true,
                    transform: { m02: 0, m12: 0 },
                    size: { x: 50, y: 14 },
                    componentPropRefs: [
                      { defID: { sessionID: 16, localID: 1 }, componentPropNodeField: 'VISIBLE' },
                    ],
                  },
                },
              ],
            },
            // INSTANCE referencing the master + assignment that toggles to false
            {
              guid: { sessionID: 22, localID: 200 },
              type: 'INSTANCE',
              name: 'masterFrame',
              data: {
                transform: { m02: 200, m12: 0 },
                size: { x: 100, y: 50 },
                symbolData: { symbolID: { sessionID: 11, localID: 100 } },
                componentPropAssignments: [
                  { defID: { sessionID: 16, localID: 1 }, value: { boolValue: false } },
                ],
              },
            },
          ],
        },
      ],
    });

    // master 직접 렌더 → controlledText는 visible (enabled: undefined)
    // instance 렌더 → controlledText는 hidden (enabled: false)
    const occurrences = findByName(out, 'controlledText');
    expect(occurrences).toHaveLength(2);
    const enabledStates = occurrences.map((n) => n.enabled).sort();
    // [false, undefined] — master 자체와 instance가 각각 visible/hidden
    expect(enabledStates).toEqual([false, undefined]);
  });

  it('IDs are globally unique across all pages in the same export run (no cross-file collisions)', async () => {
    // pencil.dev가 ID 기반 dedup을 한다면 두 파일이 같은 ID를 공유할 때 혼동 발생.
    // 한 export run에서 만들어지는 모든 페이지의 모든 ID가 globally unique해야 함.
    const tree = buildTreeFrom({
      guid: { sessionID: 0, localID: 1 },
      type: 'DOCUMENT',
      children: [
        // 다수의 페이지 — 각 페이지가 같은 사이즈의 트리 갖도록 합성
        ...Array.from({ length: 4 }, (_, p) => ({
          guid: { sessionID: 100 + p, localID: 1 },
          type: 'CANVAS',
          name: `page-${p}`,
          children: Array.from({ length: 50 }, (_, i) => ({
            guid: { sessionID: 1000 + p, localID: i },
            type: 'FRAME' as const,
            name: `frame-${p}-${i}`,
            data: { transform: { m02: i * 100, m12: 0 }, size: { x: 50, y: 50 } },
          })),
        })),
      ],
    });
    await generatePenExport({
      tree, decoded: fakeDecoded(), container: fakeContainer(), outDir: tmp,
    });

    function* walkAll(n: { children?: PenNodeOut[] }): Generator<PenNodeOut> {
      if ((n as PenNodeOut).type) yield n as PenNodeOut;
      if (Array.isArray(n.children)) for (const c of n.children) yield* walkAll(c);
    }

    const allIds: string[] = [];
    for (let p = 0; p < 4; p++) {
      const filePath = join(tmp, `${String(p).padStart(2, '0')}_page-${p}.pen`);
      const doc = JSON.parse(readFileSync(filePath, 'utf8')) as { children: PenNodeOut[] };
      for (const c of doc.children) for (const n of walkAll(c)) {
        const id = (n as unknown as { id: string }).id;
        allIds.push(id);
      }
    }
    const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
    expect(dupes).toEqual([]);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('normalizes top-level children so bounding box starts at (0, 0) — pencil.dev default viewport sees content', async () => {
    // 페이지가 절대 좌표 -32000에 있으면 pencil.dev가 빈 화면 표시 → 다른 페이지들이 같은 (빈) 화면처럼 보임.
    const out = await runExport({
      guid: { sessionID: 0, localID: 1 },
      type: 'DOCUMENT',
      children: [
        {
          guid: { sessionID: 0, localID: 2 },
          type: 'CANVAS',
          name: 'Page',
          children: [
            // 멀리 떨어진 절대 좌표
            {
              guid: { sessionID: 1, localID: 10 },
              type: 'FRAME',
              name: 'farFrame',
              data: { transform: { m02: -32000, m12: -1800 }, size: { x: 100, y: 50 } },
            },
            {
              guid: { sessionID: 1, localID: 11 },
              type: 'FRAME',
              name: 'farFrame2',
              data: { transform: { m02: -31900, m12: -1750 }, size: { x: 100, y: 50 } },
            },
          ],
        },
      ],
    });

    const topLevel = (out as { children: PenNodeOut[] }).children;
    expect(topLevel.length).toBe(2);
    // 첫 frame은 (0, 0)에 위치해야 함 (가장 최상단-좌측이었으므로)
    expect(topLevel[0]!.x).toBe(0);
    expect(topLevel[0]!.y).toBe(0);
    // 두 번째 frame은 첫 frame과의 상대 거리(100, 50) 보존
    expect(topLevel[1]!.x).toBe(100);
    expect(topLevel[1]!.y).toBe(50);
  });

  it('different pages get distinct IDs (Pencil identifies files by IDs — must not collide across pages)', async () => {
    // 두 페이지를 같은 트리 구조로 export → 각 페이지가 다른 ID 집합을 가져야 함.
    // (이전 sequential counter는 모든 페이지가 "00000"부터 시작해 pencil.dev가 같은 파일로 인식)
    const exportPage = async (pageGuid: { sessionID: number; localID: number }, pageName: string) => {
      const subTmp = mkdtempSync(join(tmpdir(), 'figrev-pen-multi-'));
      try {
        const tree = buildTreeFrom({
          guid: { sessionID: 0, localID: 1 },
          type: 'DOCUMENT',
          children: [
            {
              guid: pageGuid,
              type: 'CANVAS',
              name: pageName,
              children: [
                { guid: { sessionID: 1, localID: 10 }, type: 'FRAME', name: 'a', data: { size: { x: 10, y: 10 } } },
                { guid: { sessionID: 1, localID: 11 }, type: 'TEXT', name: 'b', data: { transform: { m02: 0, m12: 0 }, size: { x: 10, y: 10 } } },
              ],
            },
          ],
        });
        await generatePenExport({
          tree, decoded: fakeDecoded(), container: fakeContainer(), outDir: subTmp,
        });
        const safeName = pageName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        const doc = JSON.parse(readFileSync(join(subTmp, `00_${safeName}.pen`), 'utf8')) as {
          children: PenNodeOut[];
        };
        const ids: string[] = [];
        function walk(n: PenNodeOut) {
          if (n.type) ids.push((n as unknown as { id: string }).id);
          if (Array.isArray(n.children)) for (const c of n.children) walk(c);
        }
        for (const c of doc.children) walk(c);
        return ids;
      } finally {
        rmSync(subTmp, { recursive: true, force: true });
      }
    };

    const page1Ids = await exportPage({ sessionID: 100, localID: 1 }, 'page-1');
    const page2Ids = await exportPage({ sessionID: 200, localID: 2 }, 'page-2');

    // 두 페이지 모두 동일한 갯수의 노드 (3 = canvas children + their kids... 실제로는 2 frames)
    expect(page1Ids.length).toBe(page2Ids.length);
    expect(page1Ids.length).toBeGreaterThan(0);
    // 첫 ID가 달라야 함 (이게 pencil.dev의 file fingerprint 충돌 방지)
    expect(page1Ids[0]).not.toBe(page2Ids[0]);
    // 두 페이지의 ID 집합 교집합이 거의 없어야 함 (random hash 기반이라 0이거나 매우 작음)
    const set1 = new Set(page1Ids);
    const overlap = page2Ids.filter((id) => set1.has(id));
    expect(overlap.length).toBeLessThan(page1Ids.length); // strict: 모두 같지는 않아야
  });

  it('emits Pencil-valid IDs (base62 only — no colons or slashes)', async () => {
    // pencil.dev는 ID 포맷을 [0-9A-Za-z]로 제한 — Figma의 "11:580" 또는 prefix path "11:1/22:2"는 거부됨.
    const out = await runExport({
      guid: { sessionID: 0, localID: 1 },
      type: 'DOCUMENT',
      children: [
        {
          guid: { sessionID: 0, localID: 2 },
          type: 'CANVAS',
          name: 'Page',
          children: [
            {
              guid: { sessionID: 11, localID: 100 },
              type: 'SYMBOL',
              name: 'card',
              data: { size: { x: 100, y: 50 } },
              children: [
                {
                  guid: { sessionID: 11, localID: 101 },
                  type: 'TEXT',
                  name: 'title',
                  data: { transform: { m02: 0, m12: 0 }, size: { x: 50, y: 14 } },
                },
              ],
            },
            {
              guid: { sessionID: 22, localID: 200 },
              type: 'INSTANCE',
              name: 'card',
              data: {
                transform: { m02: 200, m12: 0 },
                size: { x: 100, y: 50 },
                symbolData: { symbolID: { sessionID: 11, localID: 100 } },
              },
            },
          ],
        },
      ],
    });

    function* walkAll(n: { children?: PenNodeOut[] }): Generator<PenNodeOut> {
      if ((n as PenNodeOut).type) yield n as PenNodeOut;
      if (Array.isArray(n.children)) for (const c of n.children) yield* walkAll(c);
    }
    const validId = /^[0-9A-Za-z]+$/;
    for (const n of walkAll(out as { children?: PenNodeOut[] })) {
      const id = (n as unknown as { id: string }).id;
      expect(id).toMatch(validId);
    }
  });

  it('produces unique IDs across all nodes when same SYMBOL master is referenced by multiple INSTANCEs', async () => {
    // 회귀 보호: pencil.dev가 중복 ID에서 import 실패하므로 unique 보장 필수.
    const out = await runExport({
      guid: { sessionID: 0, localID: 1 },
      type: 'DOCUMENT',
      children: [
        {
          guid: { sessionID: 0, localID: 2 },
          type: 'CANVAS',
          name: 'Page',
          children: [
            // master with 2 children
            {
              guid: { sessionID: 11, localID: 100 },
              type: 'SYMBOL',
              name: 'card',
              data: { size: { x: 100, y: 50 } },
              children: [
                {
                  guid: { sessionID: 11, localID: 101 },
                  type: 'TEXT',
                  name: 'title',
                  data: { transform: { m02: 0, m12: 0 }, size: { x: 50, y: 14 } },
                },
                {
                  guid: { sessionID: 11, localID: 102 },
                  type: 'RECTANGLE',
                  name: 'bg',
                  data: { transform: { m02: 0, m12: 0 }, size: { x: 100, y: 50 } },
                },
              ],
            },
            // 3 instances of the master — naive expansion would duplicate 11:101 and 11:102 each 3 times
            ...[1, 2, 3].map((i) => ({
              guid: { sessionID: 22, localID: 200 + i },
              type: 'INSTANCE',
              name: 'card',
              data: {
                transform: { m02: 200 * i, m12: 0 },
                size: { x: 100, y: 50 },
                symbolData: { symbolID: { sessionID: 11, localID: 100 } },
              },
            })),
          ],
        },
      ],
    });

    // 모든 노드의 id가 unique한지 확인
    function* walkAll(n: { children?: PenNodeOut[]; id?: string; type?: string }): Generator<PenNodeOut> {
      if (n && (n as PenNodeOut).type) yield n as PenNodeOut;
      if (Array.isArray(n.children)) for (const c of n.children) yield* walkAll(c);
    }
    const ids: string[] = [];
    for (const n of walkAll(out as { children?: PenNodeOut[] })) {
      // master + 3 instances 각각 (title, bg) 자손 → 총 4 master tree expansions × 3 nodes (master+2kids) = 12 nodes
      // 각 노드의 id는 unique해야 함
      // (id는 PenNode 타입에 string으로 정의됨)
      const id = (n as unknown as { id: string }).id;
      expect(typeof id).toBe('string');
      ids.push(id);
    }
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    // 정상 시: master 자체(1) + master 자손 2 + 3개 instance(3) + 각 instance의 자손 2개씩(6) = 12
    expect(ids.length).toBe(12);
  });

  it('symbolOverrides[].visible:true makes a master-hidden child visible in INSTANCE', async () => {
    // 시나리오: master에 visible:false 자식이 있고, INSTANCE의 symbolOverrides가 그것을 visible:true로 토글.
    const out = await runExport({
      guid: { sessionID: 0, localID: 1 },
      type: 'DOCUMENT',
      children: [
        {
          guid: { sessionID: 0, localID: 2 },
          type: 'CANVAS',
          name: 'Page',
          children: [
            {
              guid: { sessionID: 11, localID: 200 },
              type: 'SYMBOL',
              name: 'masterFrame',
              data: { size: { x: 100, y: 50 } },
              children: [
                {
                  guid: { sessionID: 11, localID: 201 },
                  type: 'TEXT',
                  name: 'wasHidden',
                  data: {
                    visible: false,
                    transform: { m02: 0, m12: 0 },
                    size: { x: 50, y: 14 },
                  },
                },
              ],
            },
            // INSTANCE: symbolOverrides가 11:201을 visible:true로 토글
            {
              guid: { sessionID: 22, localID: 300 },
              type: 'INSTANCE',
              name: 'masterFrame',
              data: {
                transform: { m02: 200, m12: 0 },
                size: { x: 100, y: 50 },
                symbolData: {
                  symbolID: { sessionID: 11, localID: 200 },
                  symbolOverrides: [
                    {
                      guidPath: { guids: [{ sessionID: 11, localID: 201 }] },
                      visible: true,
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    });

    const occurrences = findByName(out, 'wasHidden');
    expect(occurrences).toHaveLength(2);
    // master 직접 렌더: visible:false → enabled:false
    // instance 렌더: override로 visible:true → enabled undefined (즉, enabled key 없음)
    const enabledStates = occurrences.map((n) => n.enabled).sort();
    expect(enabledStates).toEqual([false, undefined]);
  });
});
