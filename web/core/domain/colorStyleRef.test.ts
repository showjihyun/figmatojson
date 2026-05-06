import { describe, expect, it } from 'vitest';
import { colorVarName, textStyleName, effectiveTextStyle, resolveVariableChain, colorVarTrail } from './colorStyleRef.js';

/**
 * Spec: docs/specs/web-render-fidelity-round15.spec.md
 *
 * `paint.colorVar.value.alias.guid` and `node.styleIdForText.guid` carry
 * Figma color/text-style library references. The helpers return the
 * referenced asset's `name` (e.g. "Button/Primary/Default") for the
 * Inspector to display next to the raw color.
 */

function root(children: any[]) {
  return { id: '0:0', type: 'DOCUMENT', children };
}

const VAR_BUTTON_PRIMARY = {
  id: '11:434',
  type: 'VARIABLE',
  name: 'Button/Primary/Default',
  children: [],
};
const VAR_TEXT_WHITE = {
  id: '3:98',
  type: 'VARIABLE',
  name: 'Text/White',
  children: [],
};
const TEXT_STYLE = {
  id: '4:184',
  type: 'TEXT',
  name: 'Lable/L_sb',
  styleType: 'TEXT',
  children: [],
};

describe('colorVarName', () => {
  it('returns the VARIABLE node name when paint carries a colorVar alias', () => {
    const r = root([VAR_BUTTON_PRIMARY]);
    const paint = {
      type: 'SOLID',
      color: { r: 0.1, g: 0.4, b: 0.95, a: 1 },
      colorVar: {
        value: { alias: { guid: { sessionID: 11, localID: 434 } } },
        dataType: 'ALIAS',
        resolvedDataType: 'COLOR',
      },
    };
    expect(colorVarName(paint, r)).toBe('Button/Primary/Default');
  });

  it('returns null when paint has no colorVar', () => {
    const r = root([VAR_BUTTON_PRIMARY]);
    const paint = { type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } };
    expect(colorVarName(paint, r)).toBeNull();
  });

  it('returns null when colorVar.alias.guid is incomplete', () => {
    const r = root([VAR_BUTTON_PRIMARY]);
    const paint = {
      type: 'SOLID',
      colorVar: { value: { alias: { guid: { sessionID: 11 } } } }, // missing localID
    };
    expect(colorVarName(paint, r)).toBeNull();
  });

  it('returns null when guid does not resolve to any node', () => {
    const r = root([VAR_BUTTON_PRIMARY]);
    const paint = {
      colorVar: { value: { alias: { guid: { sessionID: 99, localID: 99 } } } },
    };
    expect(colorVarName(paint, r)).toBeNull();
  });

  it('returns null when guid resolves to a non-VARIABLE node', () => {
    const r = root([{ id: '5:5', type: 'FRAME', name: 'Just a frame', children: [] }]);
    const paint = {
      colorVar: { value: { alias: { guid: { sessionID: 5, localID: 5 } } } },
    };
    expect(colorVarName(paint, r)).toBeNull();
  });

  it('returns null when paint or root is missing', () => {
    expect(colorVarName(null, root([]))).toBeNull();
    expect(colorVarName({}, null)).toBeNull();
  });

  it('finds VARIABLE nested deep in the tree', () => {
    const r = root([{
      id: '0:2', type: 'CANVAS', name: 'Internal Only Canvas',
      children: [VAR_BUTTON_PRIMARY, VAR_TEXT_WHITE],
    }]);
    const paint1 = { colorVar: { value: { alias: { guid: { sessionID: 11, localID: 434 } } } } };
    const paint2 = { colorVar: { value: { alias: { guid: { sessionID: 3, localID: 98 } } } } };
    expect(colorVarName(paint1, r)).toBe('Button/Primary/Default');
    expect(colorVarName(paint2, r)).toBe('Text/White');
  });
});

describe('textStyleName', () => {
  it('returns the text style asset name when node carries styleIdForText', () => {
    const r = root([TEXT_STYLE]);
    const node = {
      type: 'TEXT',
      styleIdForText: { guid: { sessionID: 4, localID: 184 } },
    };
    expect(textStyleName(node, r)).toBe('Lable/L_sb');
  });

  it('returns null when node has no styleIdForText', () => {
    const r = root([TEXT_STYLE]);
    expect(textStyleName({ type: 'TEXT' }, r)).toBeNull();
  });

  it('returns null when guid resolves to a non-style TEXT node', () => {
    // a regular TEXT body node — has type=TEXT but no styleType
    const r = root([{ id: '5:5', type: 'TEXT', name: 'hello', children: [] }]);
    const node = { styleIdForText: { guid: { sessionID: 5, localID: 5 } } };
    expect(textStyleName(node, r)).toBeNull();
  });

  it('returns null when guid resolves to a non-TEXT node', () => {
    const r = root([{ id: '7:7', type: 'FRAME', name: 'oops', children: [] }]);
    const node = { styleIdForText: { guid: { sessionID: 7, localID: 7 } } };
    expect(textStyleName(node, r)).toBeNull();
  });

  it('returns null when node or root is missing', () => {
    expect(textStyleName(null, root([]))).toBeNull();
    expect(textStyleName({}, null)).toBeNull();
  });
});

/**
 * Spec round 16 — `effectiveTextStyle` resolves the active typography
 * by overlaying the style asset (when styleIdForText resolves) onto
 * the node's raw fields. Field-by-field fallback: any field missing on
 * the asset falls back to the node's raw value.
 */
describe('effectiveTextStyle (round 16)', () => {
  // Real metarich reproduction: 53:303 + 53:349 both reference 16:727
  // "Body/L_sb" (Pretendard SemiBold 16). Their raw fontName/fontSize
  // are stale (Inter 12 / Pretendard SemiBold 18) — Figma renders both
  // as Pretendard SemiBold 16.
  const BODY_L_SB = {
    id: '16:727',
    type: 'TEXT',
    styleType: 'TEXT',
    name: 'Body/L_sb',
    fontName: { family: 'Pretendard', style: 'SemiBold', postscript: 'Pretendard-SemiBold' },
    fontSize: 16,
    children: [],
  };

  it('node with styleIdForText → asset fields win', () => {
    const r = root([BODY_L_SB]);
    const node = {
      type: 'TEXT',
      fontName: { family: 'Inter', style: 'Regular', postscript: '' },
      fontSize: 12,
      styleIdForText: { guid: { sessionID: 16, localID: 727 } },
    };
    const eff = effectiveTextStyle(node, r);
    expect(eff.fontName).toEqual(BODY_L_SB.fontName);
    expect(eff.fontSize).toBe(16);
  });

  it('asset missing a field → that field falls back to node raw', () => {
    const r = root([{
      id: '16:728',
      type: 'TEXT',
      styleType: 'TEXT',
      name: 'PartialStyle',
      fontSize: 24,
      children: [],
    }]);
    const node = {
      type: 'TEXT',
      fontName: { family: 'Roboto', style: 'Bold' },
      fontSize: 10,
      lineHeight: { value: 120, units: 'PERCENT' },
      styleIdForText: { guid: { sessionID: 16, localID: 728 } },
    };
    const eff = effectiveTextStyle(node, r);
    expect(eff.fontSize).toBe(24);
    expect(eff.fontName).toEqual({ family: 'Roboto', style: 'Bold' });
    expect(eff.lineHeight).toEqual({ value: 120, units: 'PERCENT' });
  });

  it('no styleIdForText → all fields are node raw', () => {
    const r = root([BODY_L_SB]);
    const node = {
      type: 'TEXT',
      fontName: { family: 'Inter', style: 'Regular' },
      fontSize: 12,
      lineHeight: { value: 18, units: 'PIXELS' },
      letterSpacing: { value: -2, units: 'PERCENT' },
      textCase: 'UPPER',
      textDecoration: 'UNDERLINE',
    };
    const eff = effectiveTextStyle(node, r);
    expect(eff.fontName).toEqual({ family: 'Inter', style: 'Regular' });
    expect(eff.fontSize).toBe(12);
    expect(eff.lineHeight).toEqual({ value: 18, units: 'PIXELS' });
    expect(eff.letterSpacing).toEqual({ value: -2, units: 'PERCENT' });
    expect(eff.textCase).toBe('UPPER');
    expect(eff.textDecoration).toBe('UNDERLINE');
  });

  it('styleIdForText pointing at non-style TEXT node → falls back to raw', () => {
    const r = root([{ id: '5:5', type: 'TEXT', name: 'body', children: [] }]);
    const node = {
      fontName: { family: 'A', style: 'B' },
      fontSize: 10,
      styleIdForText: { guid: { sessionID: 5, localID: 5 } },
    };
    const eff = effectiveTextStyle(node, r);
    expect(eff.fontSize).toBe(10);
    expect(eff.fontName).toEqual({ family: 'A', style: 'B' });
  });

  it('root null → falls back to raw', () => {
    const node = { fontName: { family: 'A' }, fontSize: 9 };
    const eff = effectiveTextStyle(node, null);
    expect(eff.fontSize).toBe(9);
    expect(eff.fontName).toEqual({ family: 'A' });
  });

  it('node null → empty effective', () => {
    expect(effectiveTextStyle(null, root([]))).toEqual({});
  });

  it('preserves textCase/textDecoration/paragraph fields from asset', () => {
    const r = root([{
      id: '20:1',
      type: 'TEXT',
      styleType: 'TEXT',
      name: 'Heading',
      fontName: { family: 'X', style: 'Bold' },
      fontSize: 32,
      lineHeight: { value: 40, units: 'PIXELS' },
      letterSpacing: { value: -1, units: 'PERCENT' },
      textCase: 'TITLE',
      textDecoration: 'NONE',
      paragraphSpacing: 8,
      paragraphIndent: 0,
      children: [],
    }]);
    const node = {
      fontName: { family: 'Y' },
      fontSize: 12,
      styleIdForText: { guid: { sessionID: 20, localID: 1 } },
    };
    const eff = effectiveTextStyle(node, r);
    expect(eff.fontSize).toBe(32);
    expect(eff.lineHeight).toEqual({ value: 40, units: 'PIXELS' });
    expect(eff.letterSpacing).toEqual({ value: -1, units: 'PERCENT' });
    expect(eff.textCase).toBe('TITLE');
    expect(eff.paragraphSpacing).toBe(8);
  });

  it('metarich 53:303 reproduction (alias to 16:727)', () => {
    const r = root([BODY_L_SB]);
    const node = {
      type: 'TEXT',
      fontName: { family: 'Inter', style: 'Regular', postscript: '' },
      fontSize: 12,
      styleIdForText: { guid: { sessionID: 16, localID: 727 } },
    };
    const eff = effectiveTextStyle(node, r);
    expect(eff.fontName).toEqual({ family: 'Pretendard', style: 'SemiBold', postscript: 'Pretendard-SemiBold' });
    expect(eff.fontSize).toBe(16);
  });

  it('metarich 53:349 reproduction (same alias, different raw → same effective)', () => {
    const r = root([BODY_L_SB]);
    const node = {
      type: 'TEXT',
      fontName: { family: 'Pretendard', style: 'SemiBold', postscript: 'Pretendard-SemiBold' },
      fontSize: 18,
      styleIdForText: { guid: { sessionID: 16, localID: 727 } },
    };
    const eff = effectiveTextStyle(node, r);
    expect(eff.fontSize).toBe(16);
  });
});

/**
 * Spec round 18-A — `resolveVariableChain` walks `variableDataValues.entries[0]`
 * alias chain with cycle / dead-end / depth-cap detection. Used by the
 * Inspector (round 15+) to expose the full alias trail and by future
 * audit scripts to classify chain end-states.
 */
describe('resolveVariableChain (round 18-A)', () => {
  function aliasEntry(sessionID: number, localID: number) {
    return {
      modeID: { sessionID: 0, localID: 0 },
      variableData: {
        value: { alias: { guid: { sessionID, localID } } },
        dataType: 'ALIAS',
        resolvedDataType: 'COLOR',
      },
    };
  }
  function rawColorEntry() {
    return {
      modeID: { sessionID: 0, localID: 0 },
      variableData: {
        value: { color: { r: 0.1, g: 0.4, b: 0.95, a: 1 } },
        dataType: 'COLOR',
        resolvedDataType: 'COLOR',
      },
    };
  }
  function variable(id: string, entry?: unknown) {
    const [s, l] = id.split(':').map(Number);
    return {
      id,
      guid: { sessionID: s, localID: l },
      type: 'VARIABLE',
      name: id,
      children: [],
      ...(entry !== undefined ? { variableDataValues: { entries: [entry] } } : {}),
    };
  }

  it('T-1: returns null for null node', () => {
    expect(resolveVariableChain(null, root([]))).toBeNull();
  });

  it('T-2: returns null for non-VARIABLE node', () => {
    const r = root([{ id: '5:5', type: 'FRAME', children: [] }]);
    expect(resolveVariableChain({ type: 'FRAME', id: '5:5' }, r)).toBeNull();
  });

  it('T-3: VARIABLE with raw COLOR entry → leaf, chain=[id]', () => {
    const node = variable('11:1', rawColorEntry());
    const r = root([node]);
    const result = resolveVariableChain(node, r)!;
    expect(result.end).toEqual({ kind: 'leaf' });
    expect(result.chain).toEqual(['11:1']);
    expect(result.leaf).toBe(node);
  });

  it('T-4: 2-hop chain (A → B raw) → leaf=B', () => {
    const B = variable('2:69', rawColorEntry());
    const A = variable('11:434', aliasEntry(2, 69));
    const r = root([A, B]);
    const result = resolveVariableChain(A, r)!;
    expect(result.end).toEqual({ kind: 'leaf' });
    expect(result.chain).toEqual(['11:434', '2:69']);
    expect(result.leaf).toBe(B);
  });

  it('T-5: 3-hop chain (A → B → C raw)', () => {
    const C = variable('3:3', rawColorEntry());
    const B = variable('2:2', aliasEntry(3, 3));
    const A = variable('1:1', aliasEntry(2, 2));
    const r = root([A, B, C]);
    const result = resolveVariableChain(A, r)!;
    expect(result.end).toEqual({ kind: 'leaf' });
    expect(result.chain).toEqual(['1:1', '2:2', '3:3']);
    expect(result.leaf).toBe(C);
  });

  it('T-6: dead-end → leaf=last seen, end=dead-end', () => {
    const A = variable('1:1', aliasEntry(99, 99)); // 99:99 missing
    const r = root([A]);
    const result = resolveVariableChain(A, r)!;
    expect(result.end).toEqual({ kind: 'dead-end' });
    expect(result.chain).toEqual(['1:1']);
    expect(result.leaf).toBe(A);
  });

  it('T-7: cycle (A → B → A) → end=cycle, cycledAt=A.id', () => {
    const A = variable('1:1', aliasEntry(2, 2));
    const B = variable('2:2', aliasEntry(1, 1));
    const r = root([A, B]);
    const result = resolveVariableChain(A, r)!;
    expect(result.end).toEqual({ kind: 'cycle', cycledAt: '1:1' });
    expect(result.chain).toEqual(['1:1', '2:2']);
    expect(result.leaf).toBe(B);
  });

  it('T-8: depth-cap (10-hop, maxDepth=3) → end=depth-cap', () => {
    const nodes = [];
    for (let i = 1; i <= 10; i++) {
      const next = i < 10 ? aliasEntry(0, i + 1) : rawColorEntry();
      nodes.push(variable(`0:${i}`, next));
    }
    const r = root(nodes);
    const result = resolveVariableChain(nodes[0], r, { maxDepth: 3 })!;
    expect(result.end).toEqual({ kind: 'depth-cap', cap: 3 });
    expect(result.chain.length).toBe(3);
  });

  it('T-9: non-VARIABLE leaf → leaf=that node, end=non-variable', () => {
    const f = { id: '7:7', type: 'FRAME', name: 'oops', children: [] };
    const A = variable('1:1', aliasEntry(7, 7));
    const r = root([A, f]);
    const result = resolveVariableChain(A, r)!;
    expect(result.end).toEqual({ kind: 'non-variable' });
    expect(result.chain).toEqual(['1:1', '7:7']);
    expect(result.leaf).toBe(f);
  });

  it('T-10: VARIABLE with no entries → leaf=node, end=leaf', () => {
    const node = variable('1:1');                 // no variableDataValues
    const r = root([node]);
    const result = resolveVariableChain(node, r)!;
    expect(result.end).toEqual({ kind: 'leaf' });
    expect(result.chain).toEqual(['1:1']);
    expect(result.leaf).toBe(node);
  });

  it('default maxDepth=8', () => {
    const nodes = [];
    for (let i = 1; i <= 12; i++) {
      const next = i < 12 ? aliasEntry(0, i + 1) : rawColorEntry();
      nodes.push(variable(`0:${i}`, next));
    }
    const r = root(nodes);
    const result = resolveVariableChain(nodes[0], r)!;
    expect(result.end).toEqual({ kind: 'depth-cap', cap: 8 });
    expect(result.chain.length).toBe(8);
  });
});

/**
 * Spec round 18-B — `colorVarTrail` formats the chain as Inspector-ready
 * { id, name } entries plus the underlying end-state. Reuses round 18-A's
 * walker; adds round-15-style gating (paint must carry a colorVar alias
 * whose target is a VARIABLE).
 */
describe('colorVarTrail (round 18-B)', () => {
  function rawColorEntry() {
    return {
      modeID: { sessionID: 0, localID: 0 },
      variableData: {
        value: { color: { r: 0.1, g: 0.4, b: 0.95, a: 1 } },
        dataType: 'COLOR',
        resolvedDataType: 'COLOR',
      },
    };
  }
  function aliasEntry(s: number, l: number) {
    return {
      modeID: { sessionID: 0, localID: 0 },
      variableData: {
        value: { alias: { guid: { sessionID: s, localID: l } } },
        dataType: 'ALIAS',
        resolvedDataType: 'COLOR',
      },
    };
  }
  function variable(id: string, name: string | null, entry?: unknown) {
    const [s, l] = id.split(':').map(Number);
    return {
      id,
      guid: { sessionID: s, localID: l },
      type: 'VARIABLE',
      name,
      children: [],
      ...(entry !== undefined ? { variableDataValues: { entries: [entry] } } : {}),
    };
  }
  function paintAliasing(s: number, l: number) {
    return {
      type: 'SOLID',
      colorVar: { value: { alias: { guid: { sessionID: s, localID: l } } } },
    };
  }

  it('TR-1: returns null when paint has no colorVar', () => {
    expect(colorVarTrail({ type: 'SOLID' }, root([]))).toBeNull();
  });

  it('TR-2: returns null when alias guid does not resolve', () => {
    expect(colorVarTrail(paintAliasing(99, 99), root([]))).toBeNull();
  });

  it('TR-3: 1-hop (raw VARIABLE) → entries=[A], end=leaf', () => {
    const A = variable('11:434', 'Button/Primary/Default', rawColorEntry());
    const r = root([A]);
    const result = colorVarTrail(paintAliasing(11, 434), r)!;
    expect(result.end).toEqual({ kind: 'leaf' });
    expect(result.entries).toEqual([{ id: '11:434', name: 'Button/Primary/Default' }]);
  });

  it('TR-4: 2-hop chain → entries[A,B], names ordered', () => {
    const B = variable('2:69', 'Color/Blue/600', rawColorEntry());
    const A = variable('11:434', 'Button/Primary/Default', aliasEntry(2, 69));
    const r = root([A, B]);
    const result = colorVarTrail(paintAliasing(11, 434), r)!;
    expect(result.end).toEqual({ kind: 'leaf' });
    expect(result.entries).toEqual([
      { id: '11:434', name: 'Button/Primary/Default' },
      { id: '2:69', name: 'Color/Blue/600' },
    ]);
  });

  it('TR-5: depth-cap is propagated through the trail', () => {
    const C = variable('3:3', 'C', rawColorEntry());
    const B = variable('2:2', 'B', aliasEntry(3, 3));
    const A = variable('1:1', 'A', aliasEntry(2, 2));
    const r = root([A, B, C]);
    // colorVarTrail uses default maxDepth=8; force a smaller cap by
    // building a longer chain than 8.
    const longChain = [];
    for (let i = 1; i <= 12; i++) {
      const next = i < 12 ? aliasEntry(0, i + 1) : rawColorEntry();
      longChain.push(variable(`0:${i}`, `n${i}`, next));
    }
    const r2 = root(longChain);
    const result = colorVarTrail(paintAliasing(0, 1), r2)!;
    expect(result.end).toEqual({ kind: 'depth-cap', cap: 8 });
    expect(result.entries.length).toBe(8);
  });

  it('TR-6: cycle preserves entries + end=cycle', () => {
    const A = variable('1:1', 'A', aliasEntry(2, 2));
    const B = variable('2:2', 'B', aliasEntry(1, 1));
    const r = root([A, B]);
    const result = colorVarTrail(paintAliasing(1, 1), r)!;
    expect(result.end).toEqual({ kind: 'cycle', cycledAt: '1:1' });
    expect(result.entries.map((e) => e.id)).toEqual(['1:1', '2:2']);
  });

  it('TR-7: dead-end (alias to missing guid) → end=dead-end', () => {
    const A = variable('1:1', 'A', aliasEntry(99, 99));
    const r = root([A]);
    const result = colorVarTrail(paintAliasing(1, 1), r)!;
    expect(result.end).toEqual({ kind: 'dead-end' });
    expect(result.entries).toEqual([{ id: '1:1', name: 'A' }]);
  });

  it('TR-8: non-variable target → null (matches round 15 gate)', () => {
    const f = { id: '7:7', type: 'FRAME', name: 'oops', children: [] };
    const r = root([f]);
    expect(colorVarTrail(paintAliasing(7, 7), r)).toBeNull();
  });

  it('TR-9: entry with null name carries through', () => {
    const A = variable('1:1', null, rawColorEntry());
    const r = root([A]);
    const result = colorVarTrail(paintAliasing(1, 1), r)!;
    expect(result.entries).toEqual([{ id: '1:1', name: null }]);
  });
});
