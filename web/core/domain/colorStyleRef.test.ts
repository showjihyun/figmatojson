import { describe, expect, it } from 'vitest';
import { colorVarName, textStyleName } from './colorStyleRef.js';

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
