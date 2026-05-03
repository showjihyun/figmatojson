import { describe, expect, it } from 'vitest';

import {
  collectFillOverridesFromInstance,
  collectPropAssignmentsFromInstance,
  collectTextOverridesFromInstance,
  toClientChildForRender,
  toClientNode,
  buildSymbolIndex,
} from './clientNode.js';
import type { TreeNode } from '../../../src/types.js';

/**
 * Hand-built TreeNode fixtures. The real ones come out of kiwi decoding;
 * these mirror the shape buildTree() produces (guid + guidStr + type + data
 * + children) without going through the kiwi pipeline. Smaller surface, no
 * fixture .fig dependency.
 */
function makeNode(
  type: string,
  localID: number,
  data: Record<string, unknown> = {},
  children: TreeNode[] = [],
  name?: string,
): TreeNode {
  const guid = { sessionID: 0, localID };
  return {
    guid,
    guidStr: `0:${localID}`,
    type,
    name: name ?? `${type}_${localID}`,
    children,
    data,
  };
}

describe('collectTextOverridesFromInstance', () => {
  it('returns an empty map when overrides is undefined or non-array', () => {
    expect(collectTextOverridesFromInstance(undefined).size).toBe(0);
    expect(collectTextOverridesFromInstance([]).size).toBe(0);
  });

  it('extracts characters keyed by the LAST guid in guidPath', () => {
    const m = collectTextOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 7 }] },
        textData: { characters: 'override-A' },
      },
      {
        guidPath: { guids: [{ sessionID: 0, localID: 9 }] },
        textData: { characters: 'override-B' },
      },
    ]);
    expect(m.get('0:7')).toBe('override-A');
    expect(m.get('0:9')).toBe('override-B');
  });

  it('skips entries without textData.characters', () => {
    const m = collectTextOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 1 }] },
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
      },
    ]);
    expect(m.size).toBe(0);
  });
});

describe('collectFillOverridesFromInstance', () => {
  it('returns an empty map when overrides is undefined or non-array', () => {
    expect(collectFillOverridesFromInstance(undefined).size).toBe(0);
    expect(collectFillOverridesFromInstance([]).size).toBe(0);
  });

  it('extracts fillPaints keyed by single-step guidPath', () => {
    const fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }];
    const m = collectFillOverridesFromInstance([
      { guidPath: { guids: [{ sessionID: 4, localID: 18548 }] }, fillPaints: fills },
    ]);
    expect(m.size).toBe(1);
    expect(m.get('4:18548')).toBe(fills); // same reference (no deep clone — see spec §8)
  });

  it('keeps multi-step guidPath entries with slash-joined keys (spec v2 — I-C1)', () => {
    const fps = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }];
    const m = collectFillOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 1 }, { sessionID: 0, localID: 2 }] },
        fillPaints: fps,
      },
    ]);
    expect(m.size).toBe(1);
    expect(m.get('0:1/0:2')).toBe(fps);
    // Single-step lookup should NOT match — the path key is the full chain.
    expect(m.get('0:2')).toBeUndefined();
  });

  it('skips entries with non-fillPaints content (text-only overrides)', () => {
    const m = collectFillOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 1 }] },
        textData: { characters: 'just text' },
      },
    ]);
    expect(m.size).toBe(0);
  });

  it('skips entries with corrupt guidPath (no guids array)', () => {
    const m = collectFillOverridesFromInstance([
      { guidPath: {}, fillPaints: [{ type: 'SOLID' }] },
      { fillPaints: [{ type: 'SOLID' }] }, // no guidPath at all
    ]);
    expect(m.size).toBe(0);
  });

  it('lets a later entry win when multiple target the same guid (spec I-C5)', () => {
    const first = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }];
    const second = [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }];
    const m = collectFillOverridesFromInstance([
      { guidPath: { guids: [{ sessionID: 0, localID: 5 }] }, fillPaints: first },
      { guidPath: { guids: [{ sessionID: 0, localID: 5 }] }, fillPaints: second },
    ]);
    expect(m.get('0:5')).toBe(second);
  });

  it('coexists with text overrides — same array, two map outputs', () => {
    const overrides = [
      {
        guidPath: { guids: [{ sessionID: 0, localID: 1 }] },
        textData: { characters: 'hi' },
      },
      {
        guidPath: { guids: [{ sessionID: 0, localID: 2 }] },
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      },
    ];
    expect(collectTextOverridesFromInstance(overrides).get('0:1')).toBe('hi');
    expect(collectFillOverridesFromInstance(overrides).get('0:2')).toBeDefined();
  });
});

describe('toClientChildForRender — fillPaints override', () => {
  it('replaces a vector descendant fillPaints when its guidStr matches the override (spec I-P3)', () => {
    // Master vector child with red fill — instance overrides it to white.
    const masterChild = makeNode('VECTOR', 18548, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const overrideFills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }];
    const fillOverrides = new Map<string, unknown[]>([['0:18548', overrideFills]]);

    const out = toClientChildForRender(
      masterChild,
      [],
      new Map(),
      new Map(),
      fillOverrides,
      new Map(),
      0,
    );

    expect(out.fillPaints).toBe(overrideFills);
    // The original master node's data is untouched — we only mutated the
    // disposable per-instance copy. (Verify by re-reading masterChild.data.)
    expect((masterChild.data.fillPaints as Array<{ color: { r: number } }>)[0].color.r).toBe(1);
  });

  it('leaves fillPaints untouched when no override targets this guid (spec I-M1)', () => {
    const masterChild = makeNode('VECTOR', 1, {
      fillPaints: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }],
    });
    const out = toClientChildForRender(
      masterChild,
      [],
      new Map(),
      new Map(),
      new Map(), // empty fillOverrides
      new Map(),
      0,
    );
    expect((out.fillPaints as Array<{ color: { r: number } }>)[0].color.r).toBe(0.5);
  });

  it('threads override down through a non-instance descendant (FRAME → VECTOR), keyed by full path', () => {
    const inner = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const wrapper = makeNode('FRAME', 100, {}, [inner]);

    const overrideFills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }];
    const out = toClientChildForRender(
      wrapper,
      [],
      new Map(),
      new Map(),
      // The full path from outer master root is "0:100/0:50" — not just "0:50".
      new Map([['0:100/0:50', overrideFills]]),
      new Map(),
      0,
    );
    const child = (out.children as Array<{ fillPaints?: unknown }>)[0];
    expect(child.fillPaints).toBe(overrideFills);
  });

  it('per-instance visibility override hides matching descendants without touching the master', () => {
    // Common Figma pattern: a Button instance hides the trailing chevron
    // icon for the "확인" variant while other instances keep it visible.
    const icon = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    const wrapper = makeNode('FRAME', 100, {}, [icon]);

    const out = toClientChildForRender(
      wrapper,
      [],
      new Map(),
      new Map(),
      new Map(),
      new Map([['0:100/0:50', false]]), // hide the icon at this path
      0,
    );
    const child = (out.children as Array<{ visible?: boolean }>)[0];
    expect(child.visible).toBe(false);
    // Master node's own data is unchanged.
    expect(icon.data.visible).toBeUndefined();
  });

  it('disambiguates two visits to the same target via different paths (the metarich Dropdown bug)', () => {
    // master root has two FRAME children A and B; each contains a VECTOR
    // with the SAME guid (50). Without path keys, an override targeting
    // VECTOR 50 would apply to BOTH. With path keys, A/50 and B/50 are
    // distinct and only the matching one is overridden.
    //
    // Note: the same guid appearing twice in a tree is unusual, but it's
    // exactly what happens with master-instance expansion in real Figma
    // files (multiple INSTANCEs of the same master share descendant guids
    // when expanded). Path-keyed overrides are the fix.
    const vecA = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const vecB = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const frameA = makeNode('FRAME', 1, {}, [vecA]);
    const frameB = makeNode('FRAME', 2, {}, [vecB]);

    const aFill = [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }];
    const bFill = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }];
    const overrides = new Map<string, unknown[]>([
      ['0:1/0:50', aFill],
      ['0:2/0:50', bFill],
    ]);

    const outA = toClientChildForRender(frameA, [], new Map(), new Map(), overrides, new Map(), 0);
    const outB = toClientChildForRender(frameB, [], new Map(), new Map(), overrides, new Map(), 0);
    expect((outA.children as Array<{ fillPaints?: unknown }>)[0].fillPaints).toBe(aFill);
    expect((outB.children as Array<{ fillPaints?: unknown }>)[0].fillPaints).toBe(bFill);
  });

  it('does NOT leak outer-instance overrides through a nested INSTANCE (spec I-P5)', () => {
    // master_outer: contains a nested INSTANCE that points to master_inner.
    // master_inner: has a VECTOR child at 0:50 with red fill.
    // Outer instance has a fillPaints override targeting 0:50 — it must NOT
    // apply, because the nested INSTANCE switches to its own (empty) overrides.
    const innerVector = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const masterInner = makeNode('SYMBOL', 200, {}, [innerVector]);
    const nestedInstance = makeNode('INSTANCE', 300, {
      symbolData: { symbolID: { sessionID: 0, localID: 200 }, symbolOverrides: [] },
    });

    const symbolIndex = new Map<string, TreeNode>([['0:200', masterInner]]);

    // Outer override would target 0:50 — but it's reached only via a multi-step
    // path through the nested INSTANCE, which our v1 doesn't support.
    const outerFillOverrides = new Map<string, unknown[]>([
      ['0:50', [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }]],
    ]);
    const out = toClientChildForRender(
      nestedInstance,
      [],
      symbolIndex,
      new Map(),
      outerFillOverrides,
      new Map(),
      0,
    );
    // The nested instance expanded with its OWN (empty) fill overrides, so
    // the inner vector keeps its master red fill.
    const renderChildren = out._renderChildren as Array<{ fillPaints?: Array<{ color: { r: number } }> }>;
    expect(renderChildren).toBeDefined();
    expect(renderChildren[0].fillPaints![0].color.r).toBe(1);
  });
});

describe('toClientNode — INSTANCE expansion picks up fill overrides end-to-end', () => {
  it('expands an INSTANCE with a fillPaints override into _renderChildren whose vector has the override color', () => {
    // master SYMBOL with a single VECTOR child (the icon path).
    const masterVector = makeNode('VECTOR', 18548, {
      fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }], // master = black
    });
    const master = makeNode('SYMBOL', 19839, {}, [masterVector], 'u:sign-out-alt');

    // INSTANCE with a fillPaints override that recolors the vector to white.
    const instance = makeNode('INSTANCE', 181, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 19839 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 18548 }] },
            fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([master, instance]);
    const out = toClientNode(instance, [], symbolIndex);

    const renderChildren = out._renderChildren as Array<{
      type: string;
      fillPaints?: Array<{ color: { r: number; g: number; b: number; a: number } }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    expect(renderChildren[0].type).toBe('VECTOR');
    expect(renderChildren[0].fillPaints![0].color).toEqual({ r: 1, g: 1, b: 1, a: 1 });

    // I-M1: master's own data is untouched — another instance referring to
    // the same master would still see the original black fill.
    expect((masterVector.data.fillPaints as Array<{ color: { r: number } }>)[0].color.r).toBe(0);
  });

  it('two instances of the same master with different fill overrides do not cross-talk (spec I-M2)', () => {
    const masterVector = makeNode('VECTOR', 99, {
      fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    const master = makeNode('SYMBOL', 100, {}, [masterVector]);

    const instA = makeNode('INSTANCE', 200, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 100 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 99 }] },
            fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }], // red
          },
        ],
      },
    });
    const instB = makeNode('INSTANCE', 201, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 100 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 99 }] },
            fillPaints: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }], // green
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([master, instA, instB]);
    const outA = toClientNode(instA, [], symbolIndex);
    const outB = toClientNode(instB, [], symbolIndex);

    const colorA = (outA._renderChildren as Array<{
      fillPaints: Array<{ color: { r: number; g: number } }>;
    }>)[0].fillPaints[0].color;
    const colorB = (outB._renderChildren as Array<{
      fillPaints: Array<{ color: { r: number; g: number } }>;
    }>)[0].fillPaints[0].color;
    expect(colorA.r).toBe(1);
    expect(colorA.g).toBe(0);
    expect(colorB.r).toBe(0);
    expect(colorB.g).toBe(1);
  });

  it('text overrides still work when fillPaints overrides are absent (no regression)', () => {
    const masterText = makeNode('TEXT', 50, { textData: { characters: 'master-text' } });
    const master = makeNode('SYMBOL', 60, {}, [masterText]);
    const instance = makeNode('INSTANCE', 70, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 60 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
            textData: { characters: 'override-text' },
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([master, instance]);
    const out = toClientNode(instance, [], symbolIndex);
    const text = (out._renderChildren as Array<{
      type: string;
      _renderTextOverride?: string;
    }>)[0];
    expect(text.type).toBe('TEXT');
    expect(text._renderTextOverride).toBe('override-text');
  });
});

describe('collectPropAssignmentsFromInstance (spec §3.4 I-C6/I-C7)', () => {
  it('returns an empty map when componentPropAssignments is undefined or non-array', () => {
    expect(collectPropAssignmentsFromInstance({}).size).toBe(0);
    expect(collectPropAssignmentsFromInstance({ componentPropAssignments: null }).size).toBe(0);
    expect(collectPropAssignmentsFromInstance({ componentPropAssignments: [] }).size).toBe(0);
  });

  it('reads boolValue from value.boolValue (direct binding)', () => {
    const m = collectPropAssignmentsFromInstance({
      componentPropAssignments: [
        { defID: { sessionID: 7, localID: 34 }, value: { boolValue: false } },
      ],
    });
    expect(m.size).toBe(1);
    expect(m.get('7:34')).toBe(false);
  });

  it('reads boolValue from varValue.value.boolValue (variant default binding)', () => {
    const m = collectPropAssignmentsFromInstance({
      componentPropAssignments: [
        { defID: { sessionID: 7, localID: 36 }, varValue: { value: { boolValue: true } } },
      ],
    });
    expect(m.get('7:36')).toBe(true);
  });

  it('prefers value.boolValue over varValue when both are present', () => {
    const m = collectPropAssignmentsFromInstance({
      componentPropAssignments: [
        {
          defID: { sessionID: 0, localID: 1 },
          value: { boolValue: false },
          varValue: { value: { boolValue: true } },
        },
      ],
    });
    expect(m.get('0:1')).toBe(false);
  });

  it('skips entries with no boolean (string-prop assignments, missing fields)', () => {
    const m = collectPropAssignmentsFromInstance({
      componentPropAssignments: [
        { defID: { sessionID: 0, localID: 1 }, value: {} }, // no boolValue
        { defID: { sessionID: 0, localID: 2 }, value: { textValue: 'foo' } }, // wrong type
        { defID: { sessionID: 0, localID: 3 } }, // no value at all
      ],
    });
    expect(m.size).toBe(0);
  });

  it('skips entries with corrupt defID (missing sessionID/localID)', () => {
    const m = collectPropAssignmentsFromInstance({
      componentPropAssignments: [
        { defID: {}, value: { boolValue: false } },
        { value: { boolValue: false } }, // no defID at all
      ],
    });
    expect(m.size).toBe(0);
  });
});

describe('toClientChildForRender — component-property visibility binding (spec §3.4 I-P6/I-P7/I-P8)', () => {
  it('hides a master descendant whose componentPropRefs[VISIBLE] resolves to false', () => {
    // The alret-64_376 / input-box-9_42 case: an icon in the button master
    // carries componentPropRefs targeting a defID; the outer instance's
    // assignments map that defID to false → icon should hide.
    const icon = makeNode('VECTOR', 208, {
      fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
      visible: true,
      componentPropRefs: [
        { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const wrapper = makeNode('FRAME', 100, {}, [icon]);

    const propAssignments = new Map<string, boolean>([['7:34', false]]);
    const out = toClientChildForRender(
      wrapper,
      [],
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      0,
      [],
      propAssignments,
    );

    const child = (out.children as Array<{ visible?: boolean }>)[0];
    expect(child.visible).toBe(false);
    // Master node's own data is unchanged — another instance with a TRUE
    // assignment must still see the icon.
    expect(icon.data.visible).toBe(true);
  });

  it('keeps a descendant visible when prop assignment resolves to true', () => {
    const icon = makeNode('VECTOR', 208, {
      visible: true,
      componentPropRefs: [
        { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const wrapper = makeNode('FRAME', 100, {}, [icon]);

    const propAssignments = new Map<string, boolean>([['7:34', true]]);
    const out = toClientChildForRender(
      wrapper,
      [],
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      0,
      [],
      propAssignments,
    );
    const child = (out.children as Array<{ visible?: boolean }>)[0];
    // Either explicitly true or untouched — both render as visible. The
    // important assertion is "not false".
    expect(child.visible).not.toBe(false);
  });

  it('ignores componentPropRefs whose componentPropNodeField is not VISIBLE (e.g. TEXT/INSTANCE_SWAP)', () => {
    const node = makeNode('TEXT', 50, {
      componentPropRefs: [
        { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'TEXT' },
      ],
    });
    const wrapper = makeNode('FRAME', 100, {}, [node]);

    const propAssignments = new Map<string, boolean>([['7:34', false]]);
    const out = toClientChildForRender(
      wrapper, [], new Map(), new Map(), new Map(), new Map(), 0, [], propAssignments,
    );
    const child = (out.children as Array<{ visible?: boolean }>)[0];
    // Spec v3 only handles VISIBLE — other fields are punted (§3.4 비고).
    expect(child.visible).not.toBe(false);
  });

  it('explicit symbolOverrides[].visible wins over prop-binding default', () => {
    // I-P8: explicit visibility override is more authoritative than the
    // prop-binding default. If symbolOverrides says visible=true at this
    // path, the prop-binding's false should be ignored.
    const icon = makeNode('VECTOR', 50, {
      componentPropRefs: [
        { defID: { sessionID: 0, localID: 1 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const wrapper = makeNode('FRAME', 100, {}, [icon]);

    const propAssignments = new Map<string, boolean>([['0:1', false]]);
    const visibilityOverrides = new Map<string, boolean>([['0:100/0:50', true]]);
    const out = toClientChildForRender(
      wrapper, [], new Map(), new Map(), new Map(), visibilityOverrides, 0, [], propAssignments,
    );
    const child = (out.children as Array<{ visible?: boolean }>)[0];
    expect(child.visible).toBe(true);
  });

  it('toClientNode threads prop assignments end-to-end (alret-64_376 fixture)', () => {
    // SYMBOL 5:44 (button master) — has an icon child with VISIBLE ref to defID 7:34
    const iconMaster = makeNode('VECTOR', 208, {
      visible: true,
      componentPropRefs: [
        { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const buttonMaster = makeNode('SYMBOL', 44, {}, [iconMaster]);

    // INSTANCE 60:340 — alret's primary action button. Carries a prop
    // assignment that hides the arrow icon via the boolean-property binding.
    const instance = makeNode('INSTANCE', 340, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 44 },
        symbolOverrides: [], // no direct visibility override here
      },
      componentPropAssignments: [
        { defID: { sessionID: 7, localID: 34 }, value: { boolValue: false } },
      ],
    });

    const symbolIndex = buildSymbolIndex([buttonMaster, instance]);
    const out = toClientNode(instance, [], symbolIndex);

    const renderChildren = out._renderChildren as Array<{ visible?: boolean }>;
    expect(renderChildren).toHaveLength(1);
    expect(renderChildren[0].visible).toBe(false);
    // Master untouched — a sibling instance without the assignment must
    // still render the icon.
    expect(iconMaster.data.visible).toBe(true);
  });

  it('two instances of the same master with opposite prop assignments do not cross-talk (I-M2 + I-P10)', () => {
    const iconMaster = makeNode('VECTOR', 208, {
      visible: true,
      componentPropRefs: [
        { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const master = makeNode('SYMBOL', 44, {}, [iconMaster]);

    const instHidden = makeNode('INSTANCE', 1, {
      symbolData: { symbolID: { sessionID: 0, localID: 44 }, symbolOverrides: [] },
      componentPropAssignments: [
        { defID: { sessionID: 7, localID: 34 }, value: { boolValue: false } },
      ],
    });
    const instShown = makeNode('INSTANCE', 2, {
      symbolData: { symbolID: { sessionID: 0, localID: 44 }, symbolOverrides: [] },
      componentPropAssignments: [
        { defID: { sessionID: 7, localID: 34 }, value: { boolValue: true } },
      ],
    });

    const symbolIndex = buildSymbolIndex([master, instHidden, instShown]);
    const outHidden = toClientNode(instHidden, [], symbolIndex);
    const outShown = toClientNode(instShown, [], symbolIndex);

    const childHidden = (outHidden._renderChildren as Array<{ visible?: boolean }>)[0];
    const childShown = (outShown._renderChildren as Array<{ visible?: boolean }>)[0];
    expect(childHidden.visible).toBe(false);
    expect(childShown.visible).not.toBe(false);
  });
});
