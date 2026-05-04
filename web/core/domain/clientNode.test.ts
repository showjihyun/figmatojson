import { describe, expect, it } from 'vitest';

import {
  applyInstanceReflow,
  toClientChildForRender,
  toClientNode,
  buildSymbolIndex,
} from './clientNode.js';
// Round 18 step 4: collectors live in src/instanceOverrides — import direct.
import {
  collectDerivedSizesFromInstance,
  collectDerivedTransformsFromInstance,
  collectFillOverridesFromInstance,
  collectPropAssignmentsAtPathFromInstance,
  collectPropAssignmentsFromInstance,
  collectSwapTargetsAtPathFromInstance,
  collectTextOverridesFromInstance,
  collectTextStyleOverridesFromInstance,
  collectVisualStyleOverridesFromInstance,
} from '../../../src/instanceOverrides.js';
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

  it('threads override down through a non-instance descendant (FRAME → VECTOR), FRAME skipped from key (round-25 v3)', () => {
    // Round-25: Figma's path-key scheme skips FRAME / GROUP / SECTION
    // ancestors. The VECTOR's path-key from outer master root is just
    // `"0:50"` — FRAME 100 doesn't contribute. Pre-round-25 we used
    // `"0:100/0:50"` which silently failed to match Figma's `[50]`.
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
      new Map([['0:50', overrideFills]]), // FRAME 100 skipped from key
      new Map(),
      0,
    );
    const child = (out.children as Array<{ fillPaints?: unknown }>)[0];
    expect(child.fillPaints).toBe(overrideFills);
  });

  it('per-instance visibility override hides matching descendants without touching the master (round-25 v3 path-key)', () => {
    // Common Figma pattern: a Button instance hides the trailing chevron
    // icon for the "확인" variant while other instances keep it visible.
    // Round-25: the icon's path-key is just `"0:50"` (FRAME 100 skipped).
    // This was the alret-modal regression case fixed by round-25 — pre-fix
    // the full-chain key `"0:100/0:50"` failed to match Figma's `[50]`.
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
      new Map([['0:50', false]]), // FRAME 100 skipped from key
      0,
    );
    const child = (out.children as Array<{ visible?: boolean }>)[0];
    expect(child.visible).toBe(false);
    // Master node's own data is unchanged.
    expect(icon.data.visible).toBeUndefined();
  });

  it('disambiguates two visits to the same target via different INSTANCE paths (round-25 v3)', () => {
    // Round-25 v3: the disambiguation Figma needs in real .fig files is
    // when the SAME master is instantiated multiple times. Each outer
    // INSTANCE has a unique guid, and the chain of INSTANCE-typed
    // ancestors disambiguates descendants that share leaf guidStrs after
    // master-instance expansion. The FRAME-disambiguation case the
    // pre-round-25 test asserted does NOT occur in real .fig files —
    // within a single master, descendant guids are unique.
    //
    // Test fixture: an outer master with two INSTANCE children pointing
    // to the same inner master. Outer's symbolOverrides path-keyed on
    // each INSTANCE's path resolves correctly to that INSTANCE's
    // expansion only.
    const innerVector = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const masterInner = makeNode('SYMBOL', 200, {}, [innerVector]);
    const instanceA = makeNode('INSTANCE', 1, {
      symbolData: { symbolID: { sessionID: 0, localID: 200 } },
    });
    const instanceB = makeNode('INSTANCE', 2, {
      symbolData: { symbolID: { sessionID: 0, localID: 200 } },
    });
    const symbolIndex = new Map<string, TreeNode>([['0:200', masterInner]]);

    const aFill = [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }];
    const bFill = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }];
    // INSTANCE-disambiguated keys: `<outer-instance-id>/<inner-target>`.
    const overrides = new Map<string, unknown[]>([
      ['0:1/0:50', aFill],
      ['0:2/0:50', bFill],
    ]);

    const outA = toClientChildForRender(instanceA, [], symbolIndex, new Map(), overrides, new Map(), 0);
    const outB = toClientChildForRender(instanceB, [], symbolIndex, new Map(), overrides, new Map(), 0);
    const childA = (outA._renderChildren as Array<{ fillPaints?: unknown }>)[0];
    const childB = (outB._renderChildren as Array<{ fillPaints?: unknown }>)[0];
    expect(childA.fillPaints).toBe(aFill);
    expect(childB.fillPaints).toBe(bFill);
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
    // Round-25: FRAME 100 is skipped from the path-key, so the icon's
    // path-key is just `"0:50"`.
    const visibilityOverrides = new Map<string, boolean>([['0:50', true]]);
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

describe('applyInstanceReflow (spec web-instance-autolayout-reflow §2 / §3)', () => {
  // Helper to fabricate a child DocumentNode-shaped object the way
  // toClientChildForRender would produce. Tests only care about size +
  // transform + visible — the rest of the DocumentNode shape is irrelevant.
  function child(opts: {
    sx: number; sy: number;
    tx?: number; ty?: number;
    visible?: boolean;
    type?: string;
  }): Record<string, unknown> {
    return {
      type: opts.type ?? 'TEXT',
      size: { x: opts.sx, y: opts.sy },
      transform: opts.tx !== undefined || opts.ty !== undefined
        ? { m00: 1, m01: 0, m02: opts.tx ?? 0, m10: 0, m11: 1, m12: opts.ty ?? 0 }
        : undefined,
      ...(opts.visible === false ? { visible: false } : {}),
    };
  }

  it('T-1: HORIZONTAL CENTER master with 1 visible TEXT (icon hidden) — text recenters in shrunk INSTANCE', () => {
    // Master: 88×32 HORIZONTAL CENTER. Children: TEXT (size 40×13 at x=36)
    // + INSTANCE icon (size 20×20 at x=12) — but icon is hidden by visibility.
    // INSTANCE size override: 48×32. After reflow, visible TEXT should
    // sit centered in 48 → tx = (48 - 40) / 2 = 4. Counter axis: y =
    // (32 - 13) / 2 = 9.5.
    const text = child({ sx: 40, sy: 13, tx: 36, ty: 9.5, visible: true });
    const icon = child({ sx: 20, sy: 20, tx: 12, ty: 6, visible: false });
    const masterData = {
      stackMode: 'HORIZONTAL',
      stackPrimaryAlignItems: 'CENTER',
      stackCounterAlignItems: 'CENTER',
      stackSpacing: 4,
    };
    const out = applyInstanceReflow([text, icon], masterData, { x: 88, y: 32 }, { x: 48, y: 32 });
    const newText = out[0] as { transform: { m02: number; m12: number } };
    expect(newText.transform.m02).toBeCloseTo(4);
    expect(newText.transform.m12).toBeCloseTo(9.5);
    // Icon (invisible) keeps master coords.
    const newIcon = out[1] as { transform: { m02: number; m12: number } };
    expect(newIcon.transform.m02).toBe(12);
    expect(newIcon.transform.m12).toBe(6);
  });

  it('T-2: HORIZONTAL CENTER master with 2 visible children + INSTANCE size unchanged — no reflow', () => {
    const a = child({ sx: 40, sy: 13, tx: 12, ty: 9.5, visible: true });
    const b = child({ sx: 20, sy: 20, tx: 56, ty: 6, visible: true });
    const masterData = { stackMode: 'HORIZONTAL', stackPrimaryAlignItems: 'CENTER', stackCounterAlignItems: 'CENTER', stackSpacing: 4 };
    const out = applyInstanceReflow([a, b], masterData, { x: 88, y: 32 }, { x: 88, y: 32 });
    expect((out[0] as { transform: { m02: number } }).transform.m02).toBe(12);
    expect((out[1] as { transform: { m02: number } }).transform.m02).toBe(56);
  });

  it('T-3: VERTICAL CENTER master with 1 visible child — recenters on y axis when INSTANCE shrunk', () => {
    const item = child({ sx: 40, sy: 12, tx: 0, ty: 6, visible: true });
    const masterData = { stackMode: 'VERTICAL', stackPrimaryAlignItems: 'CENTER', stackCounterAlignItems: 'CENTER' };
    const out = applyInstanceReflow([item], masterData, { x: 40, y: 24 }, { x: 40, y: 16 });
    const newItem = out[0] as { transform: { m02: number; m12: number } };
    // Primary axis (VERTICAL → y): single child centered → ty = (16-12)/2 = 2
    expect(newItem.transform.m12).toBeCloseTo(2);
    // Counter axis (x): width unchanged so x = (40-40)/2 = 0
    expect(newItem.transform.m02).toBeCloseTo(0);
  });

  it('T-4: stackMode === NONE — no reflow', () => {
    const c = child({ sx: 20, sy: 20, tx: 5, ty: 5, visible: true });
    const masterData = { stackMode: 'NONE' };
    const out = applyInstanceReflow([c], masterData, { x: 50, y: 50 }, { x: 30, y: 30 });
    expect((out[0] as { transform: { m02: number } }).transform.m02).toBe(5);
  });

  it('T-5: stackPrimaryAlignItems === MIN — no reflow (v1 only handles CENTER)', () => {
    const c = child({ sx: 20, sy: 20, tx: 5, ty: 5, visible: true });
    const masterData = { stackMode: 'HORIZONTAL', stackPrimaryAlignItems: 'MIN', stackCounterAlignItems: 'CENTER' };
    const out = applyInstanceReflow([c], masterData, { x: 50, y: 50 }, { x: 30, y: 30 });
    expect((out[0] as { transform: { m02: number } }).transform.m02).toBe(5);
  });

  it('T-6: invisible children excluded from primary-sum + their transforms unchanged', () => {
    const visible = child({ sx: 30, sy: 10, tx: 25, ty: 5, visible: true });
    const hidden = child({ sx: 50, sy: 10, tx: 0, ty: 5, visible: false });
    const masterData = { stackMode: 'HORIZONTAL', stackPrimaryAlignItems: 'CENTER', stackCounterAlignItems: 'CENTER' };
    const out = applyInstanceReflow([visible, hidden], masterData, { x: 80, y: 20 }, { x: 50, y: 20 });
    // Only visible's 30 width contributes → centered in 50 → tx = (50-30)/2 = 10
    expect((out[0] as { transform: { m02: number } }).transform.m02).toBeCloseTo(10);
    // Hidden child untouched.
    expect((out[1] as { transform: { m02: number } }).transform.m02).toBe(0);
  });

  it('T-7: counter-only size change — counter recenters, primary keeps master values', () => {
    // 2 visible children, INSTANCE primary axis unchanged but counter shrunk.
    // Primary positions: same as master (since primary axis size unchanged).
    // Counter (y) recenters per child.
    const a = child({ sx: 20, sy: 20, tx: 12, ty: 6, visible: true });
    const b = child({ sx: 20, sy: 10, tx: 36, ty: 11, visible: true });
    const masterData = { stackMode: 'HORIZONTAL', stackPrimaryAlignItems: 'CENTER', stackCounterAlignItems: 'CENTER', stackSpacing: 4 };
    const out = applyInstanceReflow([a, b], masterData, { x: 60, y: 32 }, { x: 60, y: 24 });
    // Primary axis (x): size unchanged so center math gives same: total = 20+4+20 = 44, start = (60-44)/2 = 8 → a at 8, b at 32
    expect((out[0] as { transform: { m02: number } }).transform.m02).toBeCloseTo(8);
    expect((out[1] as { transform: { m02: number } }).transform.m02).toBeCloseTo(32);
    // Counter (y): a centered = (24-20)/2 = 2, b centered = (24-10)/2 = 7
    expect((out[0] as { transform: { m12: number } }).transform.m12).toBeCloseTo(2);
    expect((out[1] as { transform: { m12: number } }).transform.m12).toBeCloseTo(7);
  });

  it('T-overlap-1: VERTICAL master with overlapping visible children — reflowed to flow positions (Phase B)', () => {
    // Mirrors the metarich Dropdown rail: master has 3 visible children
    // stacked at the same y=127, the first should keep its position and
    // the second should flow down by (size.y + spacing).
    const a = child({ sx: 233, sy: 40, tx: 4, ty: 127, visible: true });
    const b = child({ sx: 233, sy: 40, tx: 4, ty: 127, visible: true });
    const masterData = { stackMode: 'VERTICAL', stackSpacing: 1 };
    // Sizes don't differ → I-T1 false → CENTER reflow doesn't fire,
    // but overlap-group reflow does (alignment-independent per I-O*).
    const out = applyInstanceReflow([a, b], masterData, { x: 241, y: 130 }, { x: 111, y: 276 });
    expect((out[0] as { transform: { m12: number } }).transform.m12).toBeCloseTo(127);
    expect((out[1] as { transform: { m12: number } }).transform.m12).toBeCloseTo(127 + 40 + 1);
  });

  it('T-overlap-2: HORIZONTAL master with overlapping visible children — primary axis = x', () => {
    const a = child({ sx: 30, sy: 16, tx: 50, ty: 0, visible: true });
    const b = child({ sx: 30, sy: 16, tx: 50, ty: 0, visible: true });
    const masterData = { stackMode: 'HORIZONTAL', stackSpacing: 4 };
    const out = applyInstanceReflow([a, b], masterData, { x: 100, y: 16 }, { x: 100, y: 16 });
    expect((out[0] as { transform: { m02: number } }).transform.m02).toBe(50);
    expect((out[1] as { transform: { m02: number } }).transform.m02).toBeCloseTo(50 + 30 + 4);
  });

  it('T-overlap-3: invisible children excluded from overlap detection (do not cause reflow on their own)', () => {
    const visible = child({ sx: 233, sy: 40, tx: 4, ty: 0, visible: true });
    const hidden = child({ sx: 233, sy: 40, tx: 4, ty: 0, visible: false });
    const masterData = { stackMode: 'VERTICAL', stackSpacing: 1 };
    const out = applyInstanceReflow([visible, hidden], masterData, { x: 100, y: 100 }, { x: 100, y: 100 });
    // Only one visible child → no overlap → no reflow fires (visible
    // child stays at master position).
    expect((out[0] as { transform: { m12: number } }).transform.m12).toBe(0);
    // Hidden child untouched.
    expect((out[1] as { transform: { m12: number } }).transform.m12).toBe(0);
  });

  it('T-overlap-4: no overlap between visible children → no reflow even though master has stackMode', () => {
    const a = child({ sx: 50, sy: 16, tx: 0, ty: 0, visible: true });
    const b = child({ sx: 50, sy: 16, tx: 0, ty: 20, visible: true });
    const masterData = { stackMode: 'VERTICAL', stackSpacing: 4 };
    const out = applyInstanceReflow([a, b], masterData, { x: 50, y: 36 }, { x: 50, y: 36 });
    expect((out[0] as { transform: { m12: number } }).transform.m12).toBe(0);
    expect((out[1] as { transform: { m12: number } }).transform.m12).toBe(20);
  });

  it('T-min-1: VERTICAL MIN-aligned master with some visible-filtered children — re-pack visible from anchor (Round 19)', () => {
    // Source: WEB lnb sidemenu — master has 9 items; outer override hides 5,
    // remaining 4 should pack from the master's first child y (anchor=4) with
    // the master's spacing (1). Without this round-19 fix, the kept items at
    // their master y positions overflow the section's bbox and get clipped.
    const c1 = child({ sx: 250, sy: 48, tx: 0, ty: 4, visible: true });   // anchor — first master child
    const c2 = child({ sx: 250, sy: 48, tx: 0, ty: 53, visible: false }); // hidden by override
    const c3 = child({ sx: 250, sy: 48, tx: 0, ty: 102, visible: true });
    const c4 = child({ sx: 250, sy: 48, tx: 0, ty: 151, visible: false });
    const c5 = child({ sx: 250, sy: 48, tx: 0, ty: 200, visible: true });
    const masterData = { stackMode: 'VERTICAL', stackSpacing: 1 }; // primary undefined = MIN
    const out = applyInstanceReflow([c1, c2, c3, c4, c5], masterData, { x: 250, y: 247 }, { x: 250, y: 247 });
    // Expected: c1 at y=4 (anchor), c3 at y=53 (4+48+1), c5 at y=102 (53+48+1).
    expect((out[0] as { transform: { m12: number } }).transform.m12).toBeCloseTo(4);
    expect((out[2] as { transform: { m12: number } }).transform.m12).toBeCloseTo(53);
    expect((out[4] as { transform: { m12: number } }).transform.m12).toBeCloseTo(102);
    // Hidden children untouched.
    expect((out[1] as { transform: { m12: number } }).transform.m12).toBe(53);
    expect((out[3] as { transform: { m12: number } }).transform.m12).toBe(151);
  });

  it('T-min-2: HORIZONTAL MIN-aligned with hidden children — primary axis = x', () => {
    const a = child({ sx: 60, sy: 30, tx: 8, ty: 0, visible: true });   // anchor
    const b = child({ sx: 60, sy: 30, tx: 72, ty: 0, visible: false }); // hidden
    const c = child({ sx: 60, sy: 30, tx: 136, ty: 0, visible: true });
    const masterData = { stackMode: 'HORIZONTAL', stackSpacing: 4 };
    const out = applyInstanceReflow([a, b, c], masterData, { x: 200, y: 30 }, { x: 200, y: 30 });
    expect((out[0] as { transform: { m02: number } }).transform.m02).toBeCloseTo(8);
    expect((out[2] as { transform: { m02: number } }).transform.m02).toBeCloseTo(72); // 8 + 60 + 4
  });

  it('T-min-3: all children visible — MIN reflow does NOT fire (master positions kept)', () => {
    const a = child({ sx: 60, sy: 30, tx: 0, ty: 4, visible: true });
    const b = child({ sx: 60, sy: 30, tx: 0, ty: 38, visible: true });
    const masterData = { stackMode: 'VERTICAL', stackSpacing: 4 };
    const out = applyInstanceReflow([a, b], masterData, { x: 60, y: 100 }, { x: 60, y: 100 });
    // Both transforms unchanged (master positions kept).
    expect((out[0] as { transform: { m12: number } }).transform.m12).toBe(4);
    expect((out[1] as { transform: { m12: number } }).transform.m12).toBe(38);
  });

  it('T-min-4: explicit MIN alignment (not undefined) also fires', () => {
    const a = child({ sx: 60, sy: 30, tx: 0, ty: 4, visible: true });
    const b = child({ sx: 60, sy: 30, tx: 0, ty: 100, visible: false });
    const c = child({ sx: 60, sy: 30, tx: 0, ty: 150, visible: true });
    const masterData = { stackMode: 'VERTICAL', stackSpacing: 1, stackPrimaryAlignItems: 'MIN' };
    const out = applyInstanceReflow([a, b, c], masterData, { x: 60, y: 200 }, { x: 60, y: 200 });
    expect((out[0] as { transform: { m12: number } }).transform.m12).toBeCloseTo(4);
    expect((out[2] as { transform: { m12: number } }).transform.m12).toBeCloseTo(35); // 4 + 30 + 1
  });

  it('T-min-5: anchor preserved from master first child even when hidden', () => {
    // First child hidden but its master y (4) anchors the pack.
    const a = child({ sx: 60, sy: 30, tx: 0, ty: 4, visible: false });
    const b = child({ sx: 60, sy: 30, tx: 0, ty: 35, visible: true });
    const c = child({ sx: 60, sy: 30, tx: 0, ty: 100, visible: true });
    const masterData = { stackMode: 'VERTICAL', stackSpacing: 1 };
    const out = applyInstanceReflow([a, b, c], masterData, { x: 60, y: 200 }, { x: 60, y: 200 });
    // Anchor = 4 (from hidden first child); b packs at 4, c packs at 35.
    expect((out[1] as { transform: { m12: number } }).transform.m12).toBeCloseTo(4);
    expect((out[2] as { transform: { m12: number } }).transform.m12).toBeCloseTo(35);
  });

  it('T-overlap-5: VERTICAL overlap with intervening invisible-but-overlap-positioned child', () => {
    // a at y=0 (visible), b at y=0 (hidden), c at y=0 (visible).
    // After Phase B: a stays at 0, c moves down to size+spacing (b doesn't
    // contribute because it's hidden).
    const a = child({ sx: 233, sy: 40, tx: 4, ty: 0, visible: true });
    const b = child({ sx: 233, sy: 40, tx: 4, ty: 0, visible: false });
    const c = child({ sx: 233, sy: 40, tx: 4, ty: 0, visible: true });
    const masterData = { stackMode: 'VERTICAL', stackSpacing: 1 };
    const out = applyInstanceReflow([a, b, c], masterData, { x: 233, y: 100 }, { x: 233, y: 100 });
    expect((out[0] as { transform: { m12: number } }).transform.m12).toBeCloseTo(0);
    // Hidden b unchanged.
    expect((out[1] as { transform: { m12: number } }).transform.m12).toBe(0);
    // c should slot into the next flow position.
    expect((out[2] as { transform: { m12: number } }).transform.m12).toBeCloseTo(41);
  });

  it('T-8: missing transform on a visible child — new transform is generated', () => {
    const c = child({ sx: 20, sy: 20, visible: true });
    delete (c as { transform?: unknown }).transform;
    const masterData = { stackMode: 'HORIZONTAL', stackPrimaryAlignItems: 'CENTER', stackCounterAlignItems: 'CENTER' };
    const out = applyInstanceReflow([c], masterData, { x: 40, y: 40 }, { x: 30, y: 30 });
    const newC = out[0] as { transform: { m02: number; m12: number } };
    expect(newC.transform).toBeDefined();
    expect(newC.transform.m02).toBeCloseTo(5);
    expect(newC.transform.m12).toBeCloseTo(5);
  });
});

describe('collectPropAssignmentsAtPathFromInstance (spec §3.4 I-P11, round 15 Phase A)', () => {
  it('returns an empty map when symbolOverrides is undefined or non-array', () => {
    expect(collectPropAssignmentsAtPathFromInstance(undefined).size).toBe(0);
    expect(collectPropAssignmentsAtPathFromInstance([]).size).toBe(0);
  });

  it('extracts componentPropAssignments from a symbolOverride entry, keyed by guidPath', () => {
    const m = collectPropAssignmentsAtPathFromInstance([
      {
        guidPath: { guids: [{ sessionID: 15, localID: 292 }] },
        visible: true,
        componentPropAssignments: [
          { defID: { sessionID: 23, localID: 11 }, value: { boolValue: false } },
        ],
      },
    ]);
    expect(m.size).toBe(1);
    const inner = m.get('15:292');
    expect(inner).toBeDefined();
    expect(inner!.get('23:11')).toBe(false);
  });

  it('skips entries without componentPropAssignments', () => {
    const m = collectPropAssignmentsAtPathFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 1 }] },
        textData: { characters: 'just text' },
      },
    ]);
    expect(m.size).toBe(0);
  });

  it('skips entries with corrupt guidPath', () => {
    const m = collectPropAssignmentsAtPathFromInstance([
      {
        guidPath: {},
        componentPropAssignments: [
          { defID: { sessionID: 0, localID: 1 }, value: { boolValue: false } },
        ],
      },
    ]);
    expect(m.size).toBe(0);
  });

  it('handles multi-step guidPath (joined with /)', () => {
    const m = collectPropAssignmentsAtPathFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 5 }, { sessionID: 0, localID: 9 }] },
        componentPropAssignments: [
          { defID: { sessionID: 0, localID: 100 }, varValue: { value: { boolValue: true } } },
        ],
      },
    ]);
    expect(m.get('0:5/0:9')!.get('0:100')).toBe(true);
  });
});

describe('toClientChildForRender — outer-override propAssignments propagation (round 15 Phase A)', () => {
  it('hides an inner-master child whose VISIBLE prop is bound by an outer symbolOverride entry', () => {
    // Mirrors the metarich Dropdown rail case: outer Dropdown INSTANCE
    // carries symbolOverrides[] entries for child option-rows. Each entry
    // has a guidPath pointing at the option-row INSTANCE (master child)
    // AND componentPropAssignments that should toggle the row's icon
    // visibility. Without Phase A, we only read componentPropAssignments
    // from the option-row INSTANCE itself (empty), missing the outer
    // override and leaving the icon visible.
    //
    // Setup: outer master with one INSTANCE child (the "option row") whose
    // own master has a VECTOR icon bound to defID 23:11 via VISIBLE prop.
    // Outer override entry on path [option-row guid] passes prop
    // assignment {23:11 → false}. Expected: icon ends up visible:false.
    const innerIconMaster = makeNode('VECTOR', 200, {
      visible: true,
      componentPropRefs: [
        { defID: { sessionID: 23, localID: 11 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const innerMaster = makeNode('SYMBOL', 514, {}, [innerIconMaster]);
    const optionRow = makeNode('INSTANCE', 292, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 514 },
        symbolOverrides: [],
      },
    });
    const outerMaster = makeNode('SYMBOL', 532, {}, [optionRow]);
    const outerInstance = makeNode('INSTANCE', 279, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 532 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 292 }] },
            visible: true,
            componentPropAssignments: [
              { defID: { sessionID: 23, localID: 11 }, value: { boolValue: false } },
            ],
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([innerMaster, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);

    // Outer's _renderChildren = [option-row]. Inside option-row's own
    // _renderChildren we should find the inner icon with visible:false
    // because the outer's path-keyed prop assignment hid it.
    const renderChildren = out._renderChildren as Array<{
      type: string;
      _renderChildren?: Array<{ type: string; visible?: boolean }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    const optionRowOut = renderChildren[0];
    expect(optionRowOut.type).toBe('INSTANCE');
    const innerIconOut = optionRowOut._renderChildren?.[0];
    expect(innerIconOut?.type).toBe('VECTOR');
    expect(innerIconOut?.visible).toBe(false);
  });

  it('does not affect siblings of the path-targeted node — outer-override prop assigns are scoped', () => {
    // Two option-rows under outer master. Outer override targets only one;
    // the other should still render its icon (no leakage of prop assigns).
    const iconA = makeNode('VECTOR', 200, {
      visible: true,
      componentPropRefs: [
        { defID: { sessionID: 23, localID: 11 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const iconB = makeNode('VECTOR', 201, {
      visible: true,
      componentPropRefs: [
        { defID: { sessionID: 23, localID: 11 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const innerA = makeNode('SYMBOL', 514, {}, [iconA]);
    const innerB = makeNode('SYMBOL', 515, {}, [iconB]);
    const rowA = makeNode('INSTANCE', 292, { symbolData: { symbolID: { sessionID: 0, localID: 514 }, symbolOverrides: [] } });
    const rowB = makeNode('INSTANCE', 293, { symbolData: { symbolID: { sessionID: 0, localID: 515 }, symbolOverrides: [] } });
    const outerMaster = makeNode('SYMBOL', 532, {}, [rowA, rowB]);
    const outerInstance = makeNode('INSTANCE', 279, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 532 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 292 }] },
            componentPropAssignments: [
              { defID: { sessionID: 23, localID: 11 }, value: { boolValue: false } },
            ],
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([innerA, innerB, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      _renderChildren?: Array<{ visible?: boolean }>;
    }>;
    const rowAIcon = renderChildren[0]._renderChildren?.[0];
    const rowBIcon = renderChildren[1]._renderChildren?.[0];
    // Row A's icon hidden by outer override; Row B's icon untouched.
    expect(rowAIcon?.visible).toBe(false);
    expect(rowBIcon?.visible).not.toBe(false);
  });
});

describe('toClientNode INSTANCE — applyInstanceReflow integration (round 14 §5 T-9)', () => {
  it('alert-button-style INSTANCE — TEXT child centers in shrunk bbox via toClientNode', () => {
    // Master: HORIZONTAL CENTER, 88×32, with TEXT "Button" + icon INSTANCE.
    // Outer INSTANCE: size 48×32, prop assignment hides the icon, text override "삭제".
    // Expected: resolved TEXT transform centers in 48×32 (not at master x=36).
    const textMaster = makeNode('TEXT', 45, {
      textData: { characters: 'Button' },
      size: { x: 40, y: 13 },
      transform: { m00: 1, m01: 0, m02: 36, m10: 0, m11: 1, m12: 9.5 },
    });
    const iconMaster = makeNode('VECTOR', 208, {
      size: { x: 20, y: 20 },
      transform: { m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 6 },
      visible: true,
      componentPropRefs: [
        { defID: { sessionID: 7, localID: 34 }, componentPropNodeField: 'VISIBLE' },
      ],
    });
    const buttonMaster = makeNode(
      'SYMBOL',
      44,
      {
        size: { x: 88, y: 32 },
        stackMode: 'HORIZONTAL',
        stackPrimaryAlignItems: 'CENTER',
        stackCounterAlignItems: 'CENTER',
        stackSpacing: 4,
      },
      [textMaster, iconMaster],
    );

    const instance = makeNode('INSTANCE', 340, {
      size: { x: 48, y: 32 },
      symbolData: {
        symbolID: { sessionID: 0, localID: 44 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 45 }] },
            textData: { characters: '삭제' },
          },
        ],
      },
      componentPropAssignments: [
        { defID: { sessionID: 7, localID: 34 }, value: { boolValue: false } },
      ],
    });

    const symbolIndex = buildSymbolIndex([buttonMaster, instance]);
    const out = toClientNode(instance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      type: string;
      visible?: boolean;
      transform?: { m02: number; m12: number };
    }>;
    expect(renderChildren).toHaveLength(2);
    const textChild = renderChildren.find((c) => c.type === 'TEXT')!;
    const iconChild = renderChildren.find((c) => c.type === 'VECTOR')!;
    // Icon hidden by prop binding (round-12 §3.4).
    expect(iconChild.visible).toBe(false);
    // Visible TEXT centered in 48×32: tx = (48-40)/2 = 4, ty = (32-13)/2 = 9.5
    expect(textChild.transform!.m02).toBeCloseTo(4);
    expect(textChild.transform!.m12).toBeCloseTo(9.5);
  });
});

describe('collectSwapTargetsAtPathFromInstance (spec web-instance-variant-swap §3.1)', () => {
  it('returns an empty map when symbolOverrides is undefined or empty', () => {
    expect(collectSwapTargetsAtPathFromInstance(undefined).size).toBe(0);
    expect(collectSwapTargetsAtPathFromInstance([]).size).toBe(0);
  });

  it('extracts overriddenSymbolID keyed by guidPath', () => {
    const m = collectSwapTargetsAtPathFromInstance([
      {
        guidPath: { guids: [{ sessionID: 15, localID: 300 }] },
        overriddenSymbolID: { sessionID: 15, localID: 287 },
        componentPropAssignments: [],
      },
    ]);
    expect(m.size).toBe(1);
    expect(m.get('15:300')).toBe('15:287');
  });

  it('skips entries without overriddenSymbolID (text-only / vis-only / unrelated)', () => {
    const m = collectSwapTargetsAtPathFromInstance([
      { guidPath: { guids: [{ sessionID: 0, localID: 1 }] }, textData: { characters: 'x' } },
      { guidPath: { guids: [{ sessionID: 0, localID: 2 }] }, visible: true },
    ]);
    expect(m.size).toBe(0);
  });

  it('skips entries with corrupt overriddenSymbolID (missing sessionID/localID)', () => {
    const m = collectSwapTargetsAtPathFromInstance([
      { guidPath: { guids: [{ sessionID: 0, localID: 1 }] }, overriddenSymbolID: {} },
      { guidPath: { guids: [{ sessionID: 0, localID: 2 }] }, overriddenSymbolID: { sessionID: 5 } },
    ]);
    expect(m.size).toBe(0);
  });

  it('handles multi-step guidPath', () => {
    const m = collectSwapTargetsAtPathFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 5 }, { sessionID: 0, localID: 9 }] },
        overriddenSymbolID: { sessionID: 0, localID: 100 },
      },
    ]);
    expect(m.get('0:5/0:9')).toBe('0:100');
  });

  it('lets a later entry win on duplicate path (spec §3.1 I-C3)', () => {
    const m = collectSwapTargetsAtPathFromInstance([
      { guidPath: { guids: [{ sessionID: 0, localID: 1 }] }, overriddenSymbolID: { sessionID: 0, localID: 100 } },
      { guidPath: { guids: [{ sessionID: 0, localID: 1 }] }, overriddenSymbolID: { sessionID: 0, localID: 200 } },
    ]);
    expect(m.get('0:1')).toBe('0:200');
  });
});

describe('toClientChildForRender — variant swap (spec web-instance-variant-swap §3.2)', () => {
  it('uses the swap target master when outer override carries overriddenSymbolID for a path', () => {
    // Default master (514) → swap to (287). Both are SYMBOLs with one
    // distinct TEXT child (5 vs 8). Expected: resolved subtree contains
    // the swap-target's TEXT (8), not the default master's (5).
    const defaultText = makeNode('TEXT', 5, { textData: { characters: 'default' } });
    const defaultMaster = makeNode('SYMBOL', 514, {}, [defaultText]);
    const swapText = makeNode('TEXT', 8, { textData: { characters: 'swap-default' } });
    const swapMaster = makeNode('SYMBOL', 287, {}, [swapText]);
    const innerInstance = makeNode('INSTANCE', 300, {
      symbolData: { symbolID: { sessionID: 0, localID: 514 }, symbolOverrides: [] },
    });
    const outerMaster = makeNode('SYMBOL', 532, {}, [innerInstance]);
    const outerInstance = makeNode('INSTANCE', 279, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 532 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 300 }] },
            overriddenSymbolID: { sessionID: 0, localID: 287 },
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([defaultMaster, swapMaster, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      type: string;
      _renderChildren?: Array<{ type: string; textData?: { characters?: string } }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    const innerOut = renderChildren[0];
    // Swap target's children render — we should see the swap target's TEXT.
    const innerChildren = innerOut._renderChildren ?? [];
    expect(innerChildren).toHaveLength(1);
    expect(innerChildren[0].type).toBe('TEXT');
    expect(innerChildren[0].textData?.characters).toBe('swap-default');
  });

  it('outer text override targets swap-target child by GUID — resolves through swap', () => {
    // Same setup but outer also has a text override at multi-step path
    // [innerInstance, swapTargetTextChild]. Should set _renderTextOverride.
    const swapText = makeNode('TEXT', 288, { textData: { characters: 'placeholder' } });
    const swapMaster = makeNode('SYMBOL', 287, {}, [swapText]);
    const defaultMaster = makeNode('SYMBOL', 514, {}, []);
    const innerInstance = makeNode('INSTANCE', 300, {
      symbolData: { symbolID: { sessionID: 0, localID: 514 }, symbolOverrides: [] },
    });
    const outerMaster = makeNode('SYMBOL', 532, {}, [innerInstance]);
    const outerInstance = makeNode('INSTANCE', 279, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 532 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 300 }] },
            overriddenSymbolID: { sessionID: 0, localID: 287 },
          },
          {
            guidPath: { guids: [{ sessionID: 0, localID: 300 }, { sessionID: 0, localID: 288 }] },
            textData: { characters: '직접 선택' },
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([defaultMaster, swapMaster, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);
    const inner = (out._renderChildren as Array<{
      _renderChildren?: Array<{ type: string; _renderTextOverride?: string }>;
    }>)[0];
    const innerText = inner._renderChildren?.[0];
    expect(innerText?.type).toBe('TEXT');
    expect(innerText?._renderTextOverride).toBe('직접 선택');
  });

  it('implicit visible:true when swap is applied to an INSTANCE whose master had visible:false', () => {
    // INSTANCE has no own visible field, but master 514 has visible:false
    // (data spread sets out.visible = false). Without swap, this stays
    // false. With swap and no explicit visibility override, swap implies
    // visible:true (spec §3.3 I-V1).
    const defaultMaster = makeNode('SYMBOL', 514, { visible: false }, []);
    const swapMaster = makeNode('SYMBOL', 287, { visible: true }, []);
    const innerInstance = makeNode('INSTANCE', 300, {
      visible: false, // mirrors metarich 15:300 explicitly hidden by default
      symbolData: { symbolID: { sessionID: 0, localID: 514 }, symbolOverrides: [] },
    });
    const outerMaster = makeNode('SYMBOL', 532, {}, [innerInstance]);
    const outerInstance = makeNode('INSTANCE', 279, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 532 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 300 }] },
            overriddenSymbolID: { sessionID: 0, localID: 287 },
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([defaultMaster, swapMaster, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);
    const inner = (out._renderChildren as Array<{ visible?: boolean }>)[0];
    expect(inner.visible).not.toBe(false);
  });

  it('explicit Symbol Visibility Override wins over implicit-visible-on-swap (spec §3.3 I-V1)', () => {
    // Same setup as above but outer override ALSO specifies visible:false
    // for the same path. Symbol Visibility Override should win — render
    // node ends up visible:false despite swap being applied.
    const defaultMaster = makeNode('SYMBOL', 514, { visible: false }, []);
    const swapMaster = makeNode('SYMBOL', 287, { visible: true }, []);
    const innerInstance = makeNode('INSTANCE', 300, {
      visible: false,
      symbolData: { symbolID: { sessionID: 0, localID: 514 }, symbolOverrides: [] },
    });
    const outerMaster = makeNode('SYMBOL', 532, {}, [innerInstance]);
    const outerInstance = makeNode('INSTANCE', 279, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 532 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 300 }] },
            overriddenSymbolID: { sessionID: 0, localID: 287 },
            visible: false, // explicit override hides
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([defaultMaster, swapMaster, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);
    const inner = (out._renderChildren as Array<{ visible?: boolean }>)[0];
    expect(inner.visible).toBe(false);
  });

  it('falls back to default master when swap target is not in symbolIndex (corrupt data, spec §4 I-E1)', () => {
    const defaultText = makeNode('TEXT', 5, { textData: { characters: 'default' } });
    const defaultMaster = makeNode('SYMBOL', 514, {}, [defaultText]);
    // swap target 287 is NOT in the index.
    const innerInstance = makeNode('INSTANCE', 300, {
      symbolData: { symbolID: { sessionID: 0, localID: 514 }, symbolOverrides: [] },
    });
    const outerMaster = makeNode('SYMBOL', 532, {}, [innerInstance]);
    const outerInstance = makeNode('INSTANCE', 279, {
      symbolData: {
        symbolID: { sessionID: 0, localID: 532 },
        symbolOverrides: [
          {
            guidPath: { guids: [{ sessionID: 0, localID: 300 }] },
            overriddenSymbolID: { sessionID: 0, localID: 287 }, // not in index
          },
        ],
      },
    });

    const symbolIndex = buildSymbolIndex([defaultMaster, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);
    const inner = (out._renderChildren as Array<{
      _renderChildren?: Array<{ type: string; textData?: { characters?: string } }>;
    }>)[0];
    expect(inner._renderChildren?.[0].textData?.characters).toBe('default');
  });
});

describe('collectDerivedSizesFromInstance (spec web-instance-autolayout-reflow §3.9, round 22)', () => {
  it('T-deriv-1: picks up entry.size keyed by slash-joined guidPath', () => {
    const m = collectDerivedSizesFromInstance({
      derivedSymbolData: [
        {
          guidPath: { guids: [{ sessionID: 0, localID: 7 }, { sessionID: 0, localID: 9 }] },
          size: { x: 103, y: 24 },
        },
      ],
    });
    expect(m.size).toBe(1);
    expect(m.get('0:7/0:9')).toEqual({ x: 103, y: 24 });
  });

  it('T-deriv-2: falls back to derivedTextData.layoutSize when no entry.size (TEXT-only delta)', () => {
    const m = collectDerivedSizesFromInstance({
      derivedSymbolData: [
        {
          guidPath: { guids: [{ sessionID: 0, localID: 45 }] },
          derivedTextData: { layoutSize: { x: 86, y: 19 } },
        },
      ],
    });
    expect(m.size).toBe(1);
    expect(m.get('0:45')).toEqual({ x: 86, y: 19 });
  });

  it('T-deriv-3: entry.size wins over derivedTextData.layoutSize when both present', () => {
    const m = collectDerivedSizesFromInstance({
      derivedSymbolData: [
        {
          guidPath: { guids: [{ sessionID: 0, localID: 5 }] },
          size: { x: 100, y: 20 },
          derivedTextData: { layoutSize: { x: 200, y: 40 } },
        },
      ],
    });
    expect(m.get('0:5')).toEqual({ x: 100, y: 20 });
  });

  it('skips entries with corrupt guidPath, missing size, or non-numeric values', () => {
    const m = collectDerivedSizesFromInstance({
      derivedSymbolData: [
        { guidPath: { guids: [{ sessionID: 0, localID: 1 }] }, size: { x: 'oops' as unknown as number, y: 10 } },
        { guidPath: {}, size: { x: 10, y: 10 } },
        { size: { x: 10, y: 10 } },
        { guidPath: { guids: [{ sessionID: 0, localID: 2 }] } }, // no size, no derivedTextData
        { guidPath: { guids: [{ sessionID: 0, localID: 3 }] }, derivedTextData: {} }, // empty derivedTextData
      ],
    });
    expect(m.size).toBe(0);
  });

  it('returns empty map when derivedSymbolData is undefined or non-array', () => {
    expect(collectDerivedSizesFromInstance(undefined).size).toBe(0);
    expect(collectDerivedSizesFromInstance({}).size).toBe(0);
    expect(collectDerivedSizesFromInstance({ derivedSymbolData: 'nope' }).size).toBe(0);
  });
});

describe('toClientChildForRender — derivedSymbolData size baking (spec §3.9 I-DS2, round 22)', () => {
  it('T-deriv-4: descendant size is replaced by derivedSizesByPath entry matching its currentKey', () => {
    // Master: SYMBOL with one TEXT child (size 200×20). Outer instance's
    // derivedSymbolData says the TEXT (path = "0:55") shrinks to 80×16.
    // toClientChildForRender called with derivedSizesByPath should emit
    // out.size = { x: 80, y: 16 } for the TEXT, not the master's 200×20.
    const text = makeNode('TEXT', 55, {
      textData: { characters: 'Option 1' },
      size: { x: 200, y: 20 },
    });

    const derivedSizes = new Map<string, { x: number; y: number }>([
      ['0:55', { x: 80, y: 16 }],
    ]);
    const out = toClientChildForRender(
      text, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), derivedSizes,
    );
    expect(out.size).toEqual({ x: 80, y: 16 });
  });

  it('T-deriv-4b: descendant without matching derived entry keeps master size', () => {
    const text = makeNode('TEXT', 56, {
      textData: { characters: 'Option 2' },
      size: { x: 200, y: 20 },
    });
    const derivedSizes = new Map<string, { x: number; y: number }>([
      ['0:55', { x: 80, y: 16 }], // different key
    ]);
    const out = toClientChildForRender(
      text, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), derivedSizes,
    );
    // Master size preserved (data-spread copies it through).
    expect(out.size).toEqual({ x: 200, y: 20 });
  });
});

describe('toClientNode INSTANCE — derivedSymbolData integration (spec §3.9 I-DS5, round 22)', () => {
  it('T-deriv-5: outer INSTANCE applies derivedSymbolData size to descendants → CENTER reflow uses new sizes for spacing', () => {
    // Master: HORIZONTAL CENTER 200×32 with one TEXT child at master width 100.
    // Outer INSTANCE size 200×32 (unchanged primary), but derivedSymbolData
    // says TEXT shrank to 60. CENTER reflow with new TEXT size = 60 →
    // tx = (200 - 60) / 2 = 70 (not the master's 50).
    const textMaster = makeNode('TEXT', 71, {
      textData: { characters: 'hello' },
      size: { x: 100, y: 13 },
      transform: { m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 9.5 },
    });
    const symMaster = makeNode(
      'SYMBOL', 70,
      {
        size: { x: 200, y: 32 },
        stackMode: 'HORIZONTAL',
        stackPrimaryAlignItems: 'CENTER',
        stackCounterAlignItems: 'CENTER',
        stackSpacing: 0,
      },
      [textMaster],
    );
    // Instance: shrinks primary to 160 (so reflow fires per §3.7.5
    // narrowing — instance < master). derivedSymbolData says TEXT child
    // shrinks to 60. Expected center: (160 - 60) / 2 = 50.
    const instance = makeNode('INSTANCE', 80, {
      size: { x: 160, y: 32 },
      symbolData: { symbolID: { sessionID: 0, localID: 70 } },
      derivedSymbolData: [
        {
          guidPath: { guids: [{ sessionID: 0, localID: 71 }] },
          size: { x: 60, y: 13 },
        },
      ],
    });

    const symbolIndex = buildSymbolIndex([symMaster, instance]);
    const out = toClientNode(instance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      type: string;
      size?: { x: number; y: number };
      transform?: { m02: number; m12: number };
    }>;
    expect(renderChildren).toHaveLength(1);
    const t = renderChildren[0];
    // Derived size applied to TEXT child.
    expect(t.size).toEqual({ x: 60, y: 13 });
    // CENTER reflow used the derived size: tx = (160-60)/2 = 50.
    expect(t.transform!.m02).toBeCloseTo(50);
    expect(t.transform!.m12).toBeCloseTo(9.5); // (32-13)/2
  });
});

// =====================================================================
// Round 24 — derivedSymbolData transform baking
// (spec web-instance-autolayout-reflow.spec.md §3.10, planned)
//
// Round 22 baked entry.size + entry.derivedTextData.layoutSize from each
// outer INSTANCE's `derivedSymbolData[]` and applied it to the master's
// expanded subtree. §3.9 I-DS6 punted entry.transform — Figma also stamps
// a *post-layout 2D-affine transform* per descendant (sessionID/localID
// path), authoritative for placement when present (1570 INSTANCEs in the
// metarich audit corpus carry at least one such entry).
//
// v1 design call (encoded by these tests):
//   I-DT1  collectDerivedTransformsFromInstance(instData) reads
//          entry.transform (full 6-field affine) keyed by slash-joined
//          guidPath; malformed entries silently skipped.
//   I-DT2  toClientChildForRender accepts derivedTransformsByPath as a
//          new positional param (mirroring derivedSizesByPath plumbing).
//          When currentKey matches, out.transform is replaced wholesale.
//   I-DT3  Nested INSTANCE prefix-merge mirrors round-22 size: an inner
//          instance's own derivedSymbolData transforms are prefixed with
//          the outer currentPath and merged into the outer transforms map
//          before inner-expansion. Outer-stamped paths reach grand-
//          descendants without help from the inner instance.
//   I-DT4  applyInstanceReflow runs unchanged. When reflow fires on a
//          shrunk INSTANCE, it overwrites m02/m12 of direct children
//          (this is a documented v1 limitation — the rare conflict case;
//          most of the 1570 INSTANCE corpus does not trigger reflow). For
//          deeper descendants, derivedTransform always wins because
//          reflow only touches the outer INSTANCE's direct children.
// =====================================================================

type Transform2D = {
  m00: number; m01: number; m02: number;
  m10: number; m11: number; m12: number;
};

describe('collectDerivedTransformsFromInstance (spec web-instance-autolayout-reflow §3.10, round 24)', () => {
  it('T-deriv-6a: picks up entry.transform keyed by slash-joined guidPath', () => {
    const m = collectDerivedTransformsFromInstance({
      derivedSymbolData: [
        {
          guidPath: { guids: [{ sessionID: 0, localID: 7 }, { sessionID: 0, localID: 9 }] },
          transform: { m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 4 },
        },
      ],
    });
    expect(m.size).toBe(1);
    expect(m.get('0:7/0:9')).toEqual({ m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 4 });
  });

  it('T-deriv-6b: skips entries without a transform field (size-only / TEXT-only entries)', () => {
    const m = collectDerivedTransformsFromInstance({
      derivedSymbolData: [
        // size-only — round-22 collector territory, ignored here.
        { guidPath: { guids: [{ sessionID: 0, localID: 5 }] }, size: { x: 100, y: 20 } },
        // derivedTextData-only.
        {
          guidPath: { guids: [{ sessionID: 0, localID: 6 }] },
          derivedTextData: { layoutSize: { x: 80, y: 16 } },
        },
        // empty entry.
        { guidPath: { guids: [{ sessionID: 0, localID: 7 }] } },
      ],
    });
    expect(m.size).toBe(0);
  });

  it('T-deriv-6c: skips transforms with non-numeric / missing affine fields', () => {
    const m = collectDerivedTransformsFromInstance({
      derivedSymbolData: [
        // missing m11.
        {
          guidPath: { guids: [{ sessionID: 0, localID: 1 }] },
          transform: { m00: 1, m01: 0, m02: 0, m10: 0, m12: 0 } as unknown as Transform2D,
        },
        // m00 not a number.
        {
          guidPath: { guids: [{ sessionID: 0, localID: 2 }] },
          transform: { m00: 'oops' as unknown as number, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        },
      ],
    });
    expect(m.size).toBe(0);
  });

  it('T-deriv-6d: skips entries with corrupt guidPath (mirrors size collector I-C3)', () => {
    const m = collectDerivedTransformsFromInstance({
      derivedSymbolData: [
        { guidPath: {}, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } },
        { transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } },
        {
          guidPath: { guids: [{ sessionID: 0 } as unknown as { sessionID: number; localID: number }] },
          transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        },
      ],
    });
    expect(m.size).toBe(0);
  });

  it('T-deriv-6e: same path can populate both size (round-22) and transform (round-24) maps independently', () => {
    const inst = {
      derivedSymbolData: [
        {
          guidPath: { guids: [{ sessionID: 0, localID: 5 }] },
          size: { x: 100, y: 20 },
          transform: { m00: 1, m01: 0, m02: 30, m10: 0, m11: 1, m12: 7 },
        },
      ],
    };
    expect(collectDerivedSizesFromInstance(inst).get('0:5')).toEqual({ x: 100, y: 20 });
    expect(collectDerivedTransformsFromInstance(inst).get('0:5')).toEqual({
      m00: 1, m01: 0, m02: 30, m10: 0, m11: 1, m12: 7,
    });
  });

  it('returns an empty map for undefined / non-array input', () => {
    expect(collectDerivedTransformsFromInstance(undefined).size).toBe(0);
    expect(collectDerivedTransformsFromInstance({}).size).toBe(0);
    expect(collectDerivedTransformsFromInstance({ derivedSymbolData: 'nope' }).size).toBe(0);
  });
});

describe('toClientChildForRender — derivedSymbolData transform baking (spec §3.10 I-DT2, round 24)', () => {
  it('T-deriv-7a: descendant transform is replaced by derivedTransformsByPath entry matching its currentKey', () => {
    // Master TEXT at master coord (m02=0). Outer INSTANCE's derived
    // transform says: this descendant lives at m02=12, m12=4. The walk
    // must replace out.transform wholesale, not just merge m02/m12.
    const text = makeNode('TEXT', 55, {
      textData: { characters: 'hi' },
      size: { x: 100, y: 20 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    });
    const derivedTransforms = new Map<string, Transform2D>([
      ['0:55', { m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 4 }],
    ]);
    const out = toClientChildForRender(
      text, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), new Map(), derivedTransforms,
    );
    expect(out.transform).toEqual({ m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 4 });
  });

  it('T-deriv-7b: descendant without a matching derivedTransform entry keeps its master transform', () => {
    const text = makeNode('TEXT', 56, {
      textData: { characters: 'no match' },
      transform: { m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 9 },
    });
    const derivedTransforms = new Map<string, Transform2D>([
      ['0:55', { m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 4 }], // wrong key
    ]);
    const out = toClientChildForRender(
      text, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), new Map(), derivedTransforms,
    );
    expect(out.transform).toEqual({ m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 9 });
  });

  it('T-deriv-7c: derivedTransform fully replaces master transform, including rotation/scale (m00/m01/m10/m11)', () => {
    // Master has rotation; derived bakes a no-rotation transform → out
    // must reflect the full derived affine, not just translate fields.
    const node = makeNode('FRAME', 88, {
      size: { x: 50, y: 50 },
      transform: { m00: 0, m01: -1, m02: 100, m10: 1, m11: 0, m12: 100 }, // 90° rotation
    });
    const derivedTransforms = new Map<string, Transform2D>([
      ['0:88', { m00: 1, m01: 0, m02: 33, m10: 0, m11: 1, m12: 44 }],
    ]);
    const out = toClientChildForRender(
      node, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), new Map(), derivedTransforms,
    );
    expect(out.transform).toEqual({ m00: 1, m01: 0, m02: 33, m10: 0, m11: 1, m12: 44 });
  });
});

describe('toClientNode INSTANCE — derivedSymbolData transform integration (spec §3.10 I-DT3/I-DT4, round 24)', () => {
  it('T-deriv-8: outer INSTANCE applies derivedSymbolData transform to a deep descendant when reflow does not fire', () => {
    // Tree: SYMBOL 70 > FRAME 50 > TEXT 55. Outer INSTANCE has
    // derivedSymbolData with a path = [50, 55] entry placing TEXT at
    // m02=30, m12=8. INSTANCE size == master size → reflow no-op → the
    // derived transform survives as the final transform on the TEXT.
    const textMaster = makeNode('TEXT', 55, {
      textData: { characters: 'hi' },
      size: { x: 80, y: 16 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    });
    const frameMaster = makeNode('FRAME', 50, {
      size: { x: 200, y: 32 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    }, [textMaster]);
    const symMaster = makeNode('SYMBOL', 70, {
      size: { x: 200, y: 32 },
      // No stackMode → applyInstanceReflow is a no-op anyway.
    }, [frameMaster]);
    const instance = makeNode('INSTANCE', 80, {
      size: { x: 200, y: 32 }, // unchanged → no reflow trigger
      symbolData: { symbolID: { sessionID: 0, localID: 70 } },
      derivedSymbolData: [
        // Round-25 v3: FRAME 50 is skipped from the path-key, so the TEXT's
        // path-key is just `[55]` (Figma's wire format).
        {
          guidPath: { guids: [{ sessionID: 0, localID: 55 }] },
          transform: { m00: 1, m01: 0, m02: 30, m10: 0, m11: 1, m12: 8 },
        },
      ],
    });

    const symbolIndex = buildSymbolIndex([symMaster, instance]);
    const out = toClientNode(instance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      type: string;
      children?: Array<{ type: string; transform?: Transform2D }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    const frame = renderChildren[0];
    expect(frame.children).toHaveLength(1);
    const text = frame.children![0];
    expect(text.transform).toEqual({ m00: 1, m01: 0, m02: 30, m10: 0, m11: 1, m12: 8 });
  });

  it('T-deriv-9: nested INSTANCE — outer derivedTransform reaches grand-descendant via prefix-merge', () => {
    // Tree:
    //   master 60 = SYMBOL > TEXT 55  (the inner master)
    //   master 70 = SYMBOL > INSTANCE 71 (refers to master 60)  (the outer master)
    //   outer INSTANCE 80 → master 70
    // Outer's derivedSymbolData has a path = [71, 55] entry placing TEXT
    // at m02=42, m12=6. The path-key scheme matches the *visited chain*
    // (master 60 is a master reference, not a visited node — the walk
    // descends into its children directly from INSTANCE 71). Same rule
    // as round-22 size baking. The walk:
    //   - emits INSTANCE 71's expansion via toClientChildForRender;
    //   - inside that expansion, TEXT's currentKey is "0:71/0:55";
    //   - the outer derivedTransforms map (passed through nested merge)
    //     resolves that key → TEXT.transform = derived.
    const textMaster = makeNode('TEXT', 55, {
      textData: { characters: 'inner' },
      size: { x: 80, y: 16 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    });
    const innerMaster = makeNode('SYMBOL', 60, { size: { x: 80, y: 16 } }, [textMaster]);
    const innerInstance = makeNode('INSTANCE', 71, {
      size: { x: 80, y: 16 },
      symbolData: { symbolID: { sessionID: 0, localID: 60 } },
    });
    const outerMaster = makeNode('SYMBOL', 70, { size: { x: 200, y: 32 } }, [innerInstance]);
    const outerInstance = makeNode('INSTANCE', 80, {
      size: { x: 200, y: 32 },
      symbolData: { symbolID: { sessionID: 0, localID: 70 } },
      derivedSymbolData: [
        {
          guidPath: { guids: [
            { sessionID: 0, localID: 71 },
            { sessionID: 0, localID: 55 },
          ] },
          transform: { m00: 1, m01: 0, m02: 42, m10: 0, m11: 1, m12: 6 },
        },
      ],
    });

    const symbolIndex = buildSymbolIndex([innerMaster, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      type: string;
      _renderChildren?: Array<{ type: string; transform?: Transform2D }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    const inner = renderChildren[0];
    expect(inner.type).toBe('INSTANCE');
    expect(inner._renderChildren).toBeDefined();
    expect(inner._renderChildren).toHaveLength(1);
    const text = inner._renderChildren![0];
    expect(text.transform).toEqual({ m00: 1, m01: 0, m02: 42, m10: 0, m11: 1, m12: 6 });
  });

  it('T-deriv-10: deep descendant keeps derivedTransform even when outer reflow fires for direct children', () => {
    // Tree: SYMBOL 70 (HORIZONTAL CENTER, size 200×32)
    //         > FRAME 50 (size 100×16, transform.m02 = 50 in master)
    //             > TEXT 55 (transform.m02 = 0 within FRAME)
    // INSTANCE size 160×32 → reflow fires for FRAME 50 (direct child),
    // overwriting its m02. But TEXT 55 (deep descendant) still picks up
    // the outer's derivedSymbolData transform — reflow never touched it.
    const textMaster = makeNode('TEXT', 55, {
      textData: { characters: 'leaf' },
      size: { x: 60, y: 13 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    });
    const frameMaster = makeNode('FRAME', 50, {
      size: { x: 100, y: 16 },
      transform: { m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 8 },
    }, [textMaster]);
    const symMaster = makeNode('SYMBOL', 70, {
      size: { x: 200, y: 32 },
      stackMode: 'HORIZONTAL',
      stackPrimaryAlignItems: 'CENTER',
      stackCounterAlignItems: 'CENTER',
      stackSpacing: 0,
    }, [frameMaster]);
    const instance = makeNode('INSTANCE', 80, {
      size: { x: 160, y: 32 }, // shrunk → reflow fires for FRAME 50
      symbolData: { symbolID: { sessionID: 0, localID: 70 } },
      derivedSymbolData: [
        // Deep descendant: derivedTransform should survive (reflow only
        // touches direct children). Round-25 v3: FRAME 50 skipped, key=[55].
        {
          guidPath: { guids: [{ sessionID: 0, localID: 55 }] },
          transform: { m00: 1, m01: 0, m02: 17, m10: 0, m11: 1, m12: 3 },
        },
      ],
    });

    const symbolIndex = buildSymbolIndex([symMaster, instance]);
    const out = toClientNode(instance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      type: string;
      transform?: Transform2D;
      children?: Array<{ type: string; transform?: Transform2D }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    const frame = renderChildren[0];
    // FRAME 50 (direct child) — reflow fired, m02/m12 are reflow's CENTER
    // calculation, not the master 50/8. CENTER reflow: tx = (160-100)/2 = 30.
    expect(frame.transform!.m02).toBeCloseTo(30);
    expect(frame.transform!.m12).toBeCloseTo(8); // (32-16)/2
    // Deep descendant TEXT 55 — derivedTransform survived reflow.
    expect(frame.children).toHaveLength(1);
    const text = frame.children![0];
    expect(text.transform).toEqual({ m00: 1, m01: 0, m02: 17, m10: 0, m11: 1, m12: 3 });
  });

  it('T-deriv-11: direct child with derivedTransform but no reflow trigger keeps the derivedTransform (size unchanged)', () => {
    // Same shape as T-deriv-10 but INSTANCE size == master size → reflow
    // is a no-op. The direct-child FRAME 50's derivedTransform survives
    // — no reflow to overwrite it. This is the common case across the
    // 1570-INSTANCE corpus where Figma extended an instance and stamped
    // post-layout positions but reflow is never triggered.
    const frameMaster = makeNode('FRAME', 50, {
      size: { x: 100, y: 16 },
      transform: { m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 8 },
    });
    const symMaster = makeNode('SYMBOL', 70, {
      size: { x: 200, y: 32 },
      stackMode: 'HORIZONTAL',
      stackPrimaryAlignItems: 'CENTER',
      stackCounterAlignItems: 'CENTER',
      stackSpacing: 0,
    }, [frameMaster]);
    const instance = makeNode('INSTANCE', 80, {
      size: { x: 200, y: 32 }, // unchanged → reflow trigger fails
      symbolData: { symbolID: { sessionID: 0, localID: 70 } },
      derivedSymbolData: [
        {
          guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
          transform: { m00: 1, m01: 0, m02: 70, m10: 0, m11: 1, m12: 11 },
        },
      ],
    });

    const symbolIndex = buildSymbolIndex([symMaster, instance]);
    const out = toClientNode(instance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{ transform?: Transform2D }>;
    expect(renderChildren).toHaveLength(1);
    expect(renderChildren[0].transform).toEqual({
      m00: 1, m01: 0, m02: 70, m10: 0, m11: 1, m12: 11,
    });
  });
});

// =====================================================================
// Round 25 — path-key normalization (FRAME / GROUP ancestor skip)
//
// Closes the latent path-key bug surfaced by round-24's WEB triage on
// the alret-* modal family (commits 89bbaa5..ddad018; see GAPS.md
// "Round 25 candidate"). Figma's wire-format path-keys for symbol-
// Overrides + derivedSymbolData skip non-INSTANCE container ancestors
// (FRAME / GROUP / SECTION); only INSTANCE-typed ancestors plus the
// target node contribute. Pre-round-25 our walk used the full visit
// chain → silent override misses for any target reached through a
// container.
//
// Spec: web-instance-render-overrides.spec.md §3.1 I-C1, §3.2 I-P2
//       (round-25 v3 update). Reflow specs §3.9 I-DS1 + §3.10 I-DT1
//       reference the same scheme.
// =====================================================================

describe('round-25 path-key scheme (FRAME / GROUP ancestor skip)', () => {
  it('T-pk-1: alret regression — FRAME-grandchild visibility override applies under new scheme', () => {
    // Mirrors the metarich INSTANCE 364:2962 (alret modal) shape:
    //   master 64:376 (alret)
    //     └ buttons FRAME 60:348
    //         ├ Button 60:341 "취소" — symbolOverride [60:341] visible:false
    //         └ Button 60:340 "삭제"
    // Pre-round-25: our walk computed key "60:348/60:341" → no match → 취소
    // stays visible. Post-round-25: FRAME 60:348 skipped → key "60:341" →
    // matches Figma's `[60:341]` → 취소 hidden.
    const cancelBtn = makeNode('INSTANCE', 341, {
      size: { x: 31, y: 32 },
      symbolData: { symbolID: { sessionID: 0, localID: 999 } }, // dummy master
    });
    const deleteBtn = makeNode('INSTANCE', 340, {
      size: { x: 48, y: 32 },
      symbolData: { symbolID: { sessionID: 0, localID: 998 } }, // dummy master
    });
    const buttonsFrame = makeNode('FRAME', 348, {
      size: { x: 87, y: 32 },
    }, [cancelBtn, deleteBtn]);

    // Visibility override at path "0:341" — Figma's wire format.
    const visibilityOverrides = new Map<string, boolean>([['0:341', false]]);
    const out = toClientChildForRender(
      buttonsFrame, [], new Map(), new Map(), new Map(), visibilityOverrides, 0,
    );
    const children = out.children as Array<{ id: string; visible?: boolean }>;
    const cancel = children.find((c) => c.id === '0:341')!;
    const del = children.find((c) => c.id === '0:340')!;
    expect(cancel.visible).toBe(false); // hidden by visibility override
    expect(del.visible).not.toBe(false); // not affected
  });

  it('T-pk-2: FRAME contributes to its OWN key (matches Figma when target IS the FRAME)', () => {
    // Edge case: when the override targets the FRAME itself (e.g.
    // round-22 derivedSize for the alret buttons FRAME [60:348] →
    // size 48×32), the FRAME's own path-key includes itself. Only its
    // *children* see the FRAME-skipped pathFromOuter.
    const frameNode = makeNode('FRAME', 50, { size: { x: 100, y: 32 } });
    const fillOverrides = new Map<string, unknown[]>([['0:50', [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }]]]);
    const out = toClientChildForRender(
      frameNode, [], new Map(), new Map(), fillOverrides, new Map(), 0,
    );
    expect(out.fillPaints).toBe(fillOverrides.get('0:50'));
  });

  it('T-pk-3: nested FRAME chain — all FRAMEs skipped, leaf addressed by its localID alone', () => {
    // Pathological master: FRAME → FRAME → VECTOR. Pre-round-25 the
    // VECTOR's key would be "0:1/0:2/0:3"; post-round-25 it's "0:3".
    // Figma's actual wire format would also be `[3]`.
    const leaf = makeNode('VECTOR', 3, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const innerFrame = makeNode('FRAME', 2, {}, [leaf]);
    const outerFrame = makeNode('FRAME', 1, {}, [innerFrame]);
    const overrideFills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }];
    const out = toClientChildForRender(
      outerFrame, [], new Map(), new Map(),
      new Map([['0:3', overrideFills]]), // both FRAMEs skipped
      new Map(), 0,
    );
    const inner = (out.children as Array<{ children?: unknown[] }>)[0];
    const leafOut = (inner.children as Array<{ fillPaints?: unknown }>)[0];
    expect(leafOut.fillPaints).toBe(overrideFills);
  });

  it('T-pk-4: INSTANCE in chain DOES contribute — outer-instance / FRAME / inner-instance / TEXT', () => {
    // Master has INSTANCE A (master_inner). master_inner has FRAME → TEXT.
    // Outer outer-INSTANCE has a path override targeting that TEXT.
    // Path-key chain: outer-instance not in path (it IS the toClientNode
    // root, expansion starts there at pathFromOuter=[]); inner-instance
    // A's id IS in path; FRAME skipped; TEXT id terminal.
    //   → key = "<A.id>/<TEXT.id>"
    const innerText = makeNode('TEXT', 5, {
      textData: { characters: 'master-default' },
      size: { x: 60, y: 16 },
    });
    const innerFrame = makeNode('FRAME', 4, {}, [innerText]);
    const innerMaster = makeNode('SYMBOL', 200, {}, [innerFrame]);
    const innerInstance = makeNode('INSTANCE', 71, {
      size: { x: 100, y: 32 },
      symbolData: { symbolID: { sessionID: 0, localID: 200 } },
    });
    const outerMaster = makeNode('SYMBOL', 70, { size: { x: 200, y: 64 } }, [innerInstance]);
    const outerInstance = makeNode('INSTANCE', 80, {
      size: { x: 200, y: 64 },
      symbolData: {
        symbolID: { sessionID: 0, localID: 70 },
        symbolOverrides: [
          {
            // Path skips inner FRAME 4 → key = [71, 5]
            guidPath: { guids: [{ sessionID: 0, localID: 71 }, { sessionID: 0, localID: 5 }] },
            textData: { characters: 'override-text' },
          },
        ],
      },
    });
    const symbolIndex = buildSymbolIndex([innerMaster, outerMaster, outerInstance]);
    const out = toClientNode(outerInstance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      _renderChildren?: Array<{ children?: Array<{ _renderTextOverride?: string }> }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    const inner = renderChildren[0];
    // inner._renderChildren[0] is the FRAME → its children[0] is TEXT.
    const innerFrame_out = inner._renderChildren![0];
    const text_out = innerFrame_out.children![0];
    expect(text_out._renderTextOverride).toBe('override-text');
  });

  it('T-pk-5: GROUP ancestor also skipped (same rule as FRAME)', () => {
    // GROUP behaves identically to FRAME for path-key purposes — only
    // the type label differs. Verify the new childPathFromOuter rule
    // treats both as transparent.
    const leaf = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const group = makeNode('GROUP', 100, {}, [leaf]);
    const overrideFills = [{ type: 'SOLID', color: { r: 0, g: 1, b: 1, a: 1 } }];
    const out = toClientChildForRender(
      group, [], new Map(), new Map(),
      new Map([['0:50', overrideFills]]), // GROUP 100 skipped
      new Map(), 0,
    );
    const child = (out.children as Array<{ fillPaints?: unknown }>)[0];
    expect(child.fillPaints).toBe(overrideFills);
  });
});

// =====================================================================
// Round 26 — TEXT styling override
// (spec web-instance-render-overrides.spec.md §3.5)
//
// Round-4 added text override for `textData.characters` (the actual
// glyphs). Round-26 picks up the *non-character* styling fields that
// Figma stamps per INSTANCE on the same path-keyed mechanism: fontSize,
// fontName, lineHeight, letterSpacing, etc. Distribution in the metarich
// audit corpus shows ~1,400 INSTANCEs override fontSize/fontName/...,
// and pre-round-26 the renderer fell back to the master's defaults for
// all of them, producing visible font-family / size / line-height
// mismatches against figma.png.
//
// Spec §3.5 I-S1..I-S7. Whitelist (I-S2): fontSize / fontName /
// fontVersion / lineHeight / letterSpacing / textTracking /
// styleIdForText / fontVariations / textAutoResize /
// fontVariantCommonLigatures / fontVariantContextualLigatures /
// textDecorationSkipInk / textAlignHorizontal / textAlignVertical.
// =====================================================================

describe('collectTextStyleOverridesFromInstance (spec §3.5, round 26)', () => {
  it('T-ts-1: picks up whitelisted style fields keyed by slash-joined guidPath', () => {
    const m = collectTextStyleOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
        fontSize: 14,
        fontName: { family: 'Pretendard', style: 'Medium', postscript: 'Pretendard-Medium' },
        lineHeight: { value: 1.5, units: 'RAW' },
      },
    ]);
    expect(m.size).toBe(1);
    const o = m.get('0:50')!;
    expect(o.fontSize).toBe(14);
    expect(o.fontName).toEqual({ family: 'Pretendard', style: 'Medium', postscript: 'Pretendard-Medium' });
    expect(o.lineHeight).toEqual({ value: 1.5, units: 'RAW' });
  });

  it('T-ts-2: ignores non-whitelisted fields (textData / fillPaints / size etc. are other collectors\' jobs)', () => {
    const m = collectTextStyleOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
        textData: { characters: 'override-text' },           // round-4 territory
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }], // round-12
        size: { x: 100, y: 20 },                              // round-22 territory (different field)
        // Single style field present so the entry isn't fully skipped:
        fontSize: 16,
      },
    ]);
    const o = m.get('0:50')!;
    expect(o.fontSize).toBe(16);
    // None of the non-whitelisted fields should leak into the style record.
    expect((o as Record<string, unknown>).textData).toBeUndefined();
    expect((o as Record<string, unknown>).fillPaints).toBeUndefined();
    expect((o as Record<string, unknown>).size).toBeUndefined();
  });

  it('T-ts-3: skips entries with NO whitelisted style fields (avoids empty-record lookups, I-S3)', () => {
    const m = collectTextStyleOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
        textData: { characters: 'foo' },        // no style fields at all
        fillPaints: [{ type: 'SOLID' }],
      },
      {
        guidPath: { guids: [{ sessionID: 0, localID: 51 }] },
        // empty entry except guidPath
      },
    ]);
    expect(m.size).toBe(0);
  });

  it('T-ts-4: skips entries with corrupt guidPath', () => {
    const m = collectTextStyleOverridesFromInstance([
      { guidPath: {}, fontSize: 14 },
      { fontSize: 14 },                                                          // no guidPath
      { guidPath: { guids: [{ sessionID: 0 } as unknown as { sessionID: number; localID: number }] }, fontSize: 14 },
    ]);
    expect(m.size).toBe(0);
  });

  it('returns empty map when overrides is undefined or empty', () => {
    expect(collectTextStyleOverridesFromInstance(undefined).size).toBe(0);
    expect(collectTextStyleOverridesFromInstance([]).size).toBe(0);
  });
});

describe('toClientChildForRender — TEXT styling override (spec §3.5 I-S4/I-S5, round 26)', () => {
  it('T-ts-5: applies override fields to TEXT node at matching path; partial override preserves master fields', () => {
    // Master TEXT has fontSize 18, fontName SemiBold. Override changes
    // only fontName (no fontSize). Expected: out.fontSize stays 18,
    // out.fontName becomes the override value.
    const text = makeNode('TEXT', 50, {
      textData: { characters: 'hi' },
      fontSize: 18,
      fontName: { family: 'Pretendard', style: 'SemiBold', postscript: 'Pretendard-SemiBold' },
      lineHeight: { value: 1.44, units: 'RAW' },
    });

    const styleOverrides = new Map<string, Record<string, unknown>>([
      ['0:50', {
        fontName: { family: 'Pretendard', style: 'Medium', postscript: 'Pretendard-Medium' },
      }],
    ]);
    const out = toClientChildForRender(
      text, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), new Map(), new Map(), styleOverrides,
    );
    expect(out.fontSize).toBe(18); // master preserved
    expect(out.fontName).toEqual({ family: 'Pretendard', style: 'Medium', postscript: 'Pretendard-Medium' });
    expect(out.lineHeight).toEqual({ value: 1.44, units: 'RAW' }); // master preserved
  });

  it('T-ts-6: TEXT-type guard — override does NOT apply to non-TEXT nodes at the same path (I-S4)', () => {
    // VECTOR with the same guid as a hypothetical TEXT shouldn't get the
    // style. Override map keyed at "0:50" but n.type === 'VECTOR'.
    const vec = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const styleOverrides = new Map<string, Record<string, unknown>>([
      ['0:50', { fontSize: 14 }],
    ]);
    const out = toClientChildForRender(
      vec, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), new Map(), new Map(), styleOverrides,
    );
    // VECTOR shouldn't carry fontSize.
    expect((out as Record<string, unknown>).fontSize).toBeUndefined();
  });

  it('T-ts-7: integration via toClientNode — outer INSTANCE applies fontName to a TEXT descendant under FRAME', () => {
    // Mirrors metarich Dropdown 11:529 / 11:506 case:
    //   master 70 (SYMBOL)
    //     └ FRAME 60                    ← skipped from path-key (round-25)
    //         └ TEXT 50 "default"      ← path-key = "0:50"
    // Outer INSTANCE override on path [50] changes fontName to Medium.
    // Expected: TEXT renders with override fontName, master fontSize.
    const textMaster = makeNode('TEXT', 50, {
      textData: { characters: 'default' },
      fontSize: 14,
      fontName: { family: 'Pretendard', style: 'Regular', postscript: 'Pretendard-Regular' },
      lineHeight: { value: 1, units: 'RAW' },
      letterSpacing: { value: -0.5, units: 'PERCENT' },
    });
    const frame = makeNode('FRAME', 60, { size: { x: 200, y: 32 } }, [textMaster]);
    const symMaster = makeNode('SYMBOL', 70, { size: { x: 200, y: 32 } }, [frame]);
    const instance = makeNode('INSTANCE', 80, {
      size: { x: 200, y: 32 },
      symbolData: {
        symbolID: { sessionID: 0, localID: 70 },
        symbolOverrides: [
          {
            // FRAME 60 skipped under round-25 path-key (only INSTANCE
            // ancestors + target contribute), so the path is just [50].
            guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
            fontName: { family: 'Pretendard', style: 'Medium', postscript: 'Pretendard-Medium' },
          },
        ],
      },
    });
    const symbolIndex = buildSymbolIndex([symMaster, instance]);
    const out = toClientNode(instance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      type: string;
      children?: Array<{ type: string; fontSize?: number; fontName?: unknown; lineHeight?: unknown }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    const frameOut = renderChildren[0];
    expect(frameOut.children).toHaveLength(1);
    const textOut = frameOut.children![0];
    expect(textOut.fontSize).toBe(14); // master preserved (partial override)
    expect(textOut.fontName).toEqual({ family: 'Pretendard', style: 'Medium', postscript: 'Pretendard-Medium' });
    expect(textOut.lineHeight).toEqual({ value: 1, units: 'RAW' }); // master preserved
  });
});

// =====================================================================
// Round 27 — Visual style override (stroke / cornerRadius / opacity)
// (spec web-instance-render-overrides.spec.md §3.6)
//
// Round-12 path-keyed override pipeline currently handles `fillPaints`
// only. Round-27 extends to the rest of the *visual* style fields that
// metarich INSTANCEs stamp per-variant: strokePaints, opacity, and the
// cornerRadius family (cornerRadius + 4 per-corner fields). 7-field
// whitelist (I-V2). Same path-key + apply layer + nested-prefix-merge
// + master-immutability rules as round-12 / round-26.
//
// Distribution measurement (test-results/round24-triage/inspect-stroke-
// effects.mjs):
//   strokePaints: 122 / opacity: 11 /
//   cornerRadius + rectangleTop/Bottom/Left/Right per-corner: ~45 each.
// =====================================================================

describe('collectVisualStyleOverridesFromInstance (spec §3.6, round 27)', () => {
  it('T-vs-1: picks up whitelisted visual style fields keyed by slash-joined guidPath', () => {
    const m = collectVisualStyleOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
        strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1, a: 1 } }],
        opacity: 0.5,
        cornerRadius: 8,
      },
    ]);
    expect(m.size).toBe(1);
    const o = m.get('0:50')!;
    expect(o.strokePaints).toEqual([{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1, a: 1 } }]);
    expect(o.opacity).toBe(0.5);
    expect(o.cornerRadius).toBe(8);
  });

  it('T-vs-2: ignores non-whitelisted fields (fillPaints / textData / size etc. are other collectors\' jobs)', () => {
    const m = collectVisualStyleOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
        fillPaints: [{ type: 'SOLID' }],            // round-12 territory
        textData: { characters: 'foo' },             // round-4
        size: { x: 100, y: 20 },                     // round-22 territory
        fontSize: 14,                                 // round-26 TEXT styling
        // Single visual field present so the entry isn't fully skipped:
        opacity: 0.7,
      },
    ]);
    const o = m.get('0:50')!;
    expect(o.opacity).toBe(0.7);
    expect((o as Record<string, unknown>).fillPaints).toBeUndefined();
    expect((o as Record<string, unknown>).textData).toBeUndefined();
    expect((o as Record<string, unknown>).size).toBeUndefined();
    expect((o as Record<string, unknown>).fontSize).toBeUndefined();
  });

  it('T-vs-3: per-corner fields are independently extracted', () => {
    const m = collectVisualStyleOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
        rectangleTopLeftCornerRadius: 12,
        rectangleTopRightCornerRadius: 12,
        rectangleBottomLeftCornerRadius: 0,
        rectangleBottomRightCornerRadius: 0,
      },
    ]);
    const o = m.get('0:50')!;
    expect(o.rectangleTopLeftCornerRadius).toBe(12);
    expect(o.rectangleTopRightCornerRadius).toBe(12);
    expect(o.rectangleBottomLeftCornerRadius).toBe(0);
    expect(o.rectangleBottomRightCornerRadius).toBe(0);
  });

  it('T-vs-4: skips entries with no whitelisted visual fields (I-V3)', () => {
    const m = collectVisualStyleOverridesFromInstance([
      {
        guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
        textData: { characters: 'foo' },
        fillPaints: [{ type: 'SOLID' }],
      },
      {
        guidPath: { guids: [{ sessionID: 0, localID: 51 }] },
        // empty entry except guidPath
      },
    ]);
    expect(m.size).toBe(0);
  });

  it('T-vs-5: skips entries with corrupt guidPath', () => {
    const m = collectVisualStyleOverridesFromInstance([
      { guidPath: {}, opacity: 0.5 },
      { opacity: 0.5 },
      { guidPath: { guids: [{ sessionID: 0 } as unknown as { sessionID: number; localID: number }] }, opacity: 0.5 },
    ]);
    expect(m.size).toBe(0);
  });

  it('returns empty map when overrides is undefined or empty', () => {
    expect(collectVisualStyleOverridesFromInstance(undefined).size).toBe(0);
    expect(collectVisualStyleOverridesFromInstance([]).size).toBe(0);
  });
});

describe('toClientChildForRender — visual style override (spec §3.6 I-V4/I-V5, round 27)', () => {
  it('T-vs-6: applies stroke / opacity / cornerRadius to a non-TEXT node at matching path', () => {
    // RECTANGLE master with master cornerRadius=4, opacity=1, no stroke.
    // Override at path "0:50" patches all three. Expected: out.* = override.
    const rect = makeNode('RECTANGLE', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      cornerRadius: 4,
      opacity: 1,
    });
    const visualOverrides = new Map<string, Record<string, unknown>>([
      ['0:50', {
        strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1, a: 1 } }],
        opacity: 0.5,
        cornerRadius: 12,
      }],
    ]);
    const out = toClientChildForRender(
      rect, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), visualOverrides,
    );
    expect(out.strokePaints).toEqual([{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1, a: 1 } }]);
    expect(out.opacity).toBe(0.5);
    expect(out.cornerRadius).toBe(12);
    // master's fillPaints unaffected (different override category — round-12).
    expect(out.fillPaints).toEqual([{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }]);
  });

  it('T-vs-7: NO TEXT-type guard — visual style override applies to all node types (I-V4)', () => {
    // VECTOR with stroke override should pick it up (same as RECTANGLE).
    // This contrasts with round-26 which guards on TEXT-only.
    const vec = makeNode('VECTOR', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    const visualOverrides = new Map<string, Record<string, unknown>>([
      ['0:50', { strokePaints: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }] }],
    ]);
    const out = toClientChildForRender(
      vec, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), visualOverrides,
    );
    expect(out.strokePaints).toEqual([{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }]);
  });

  it('T-vs-8: partial-override merge preserves master fields the override does not mention (I-V5)', () => {
    const rect = makeNode('RECTANGLE', 50, {
      cornerRadius: 8,
      opacity: 1,
      strokePaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    });
    // Override only changes opacity. cornerRadius + strokePaints stay master.
    const visualOverrides = new Map<string, Record<string, unknown>>([
      ['0:50', { opacity: 0.5 }],
    ]);
    const out = toClientChildForRender(
      rect, [], new Map(), new Map(), new Map(), new Map(), 0,
      [], new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), visualOverrides,
    );
    expect(out.opacity).toBe(0.5);                                         // overridden
    expect(out.cornerRadius).toBe(8);                                      // master preserved
    expect(out.strokePaints).toEqual([{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }]); // master preserved
  });

  it('T-vs-9: integration via toClientNode — outer INSTANCE applies stroke override to a RECTANGLE descendant under FRAME', () => {
    // master 70 (SYMBOL) → FRAME 60 (skipped from path-key) → RECT 50.
    // Outer INSTANCE override on path [50] changes strokePaints.
    const rectMaster = makeNode('RECTANGLE', 50, {
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      cornerRadius: 4,
    });
    const frame = makeNode('FRAME', 60, { size: { x: 100, y: 40 } }, [rectMaster]);
    const symMaster = makeNode('SYMBOL', 70, { size: { x: 100, y: 40 } }, [frame]);
    const instance = makeNode('INSTANCE', 80, {
      size: { x: 100, y: 40 },
      symbolData: {
        symbolID: { sessionID: 0, localID: 70 },
        symbolOverrides: [
          {
            // FRAME 60 skipped under round-25 path-key → path = [50]
            guidPath: { guids: [{ sessionID: 0, localID: 50 }] },
            strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1, a: 1 } }],
            cornerRadius: 12,
          },
        ],
      },
    });
    const symbolIndex = buildSymbolIndex([symMaster, instance]);
    const out = toClientNode(instance, [], symbolIndex);
    const renderChildren = out._renderChildren as Array<{
      type: string;
      children?: Array<{ type: string; strokePaints?: unknown; cornerRadius?: number }>;
    }>;
    expect(renderChildren).toHaveLength(1);
    const frameOut = renderChildren[0];
    expect(frameOut.children).toHaveLength(1);
    const rectOut = frameOut.children![0];
    expect(rectOut.strokePaints).toEqual([{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1, a: 1 } }]);
    expect(rectOut.cornerRadius).toBe(12);
  });
});


