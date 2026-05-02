import { describe, expect, it } from 'vitest';
import { countVariantChildren } from './variants';

interface N {
  type?: string;
  name?: string;
  children?: N[];
}

describe('countVariantChildren', () => {
  it('returns 0 for null/empty/undefined', () => {
    expect(countVariantChildren(null)).toBe(0);
    expect(countVariantChildren(undefined)).toBe(0);
    expect(countVariantChildren({})).toBe(0);
    expect(countVariantChildren({ type: 'FRAME', children: [] })).toBe(0);
  });

  // ── Newer Figma: COMPONENT_SET with COMPONENT children ──────────────
  describe('newer Figma — COMPONENT_SET', () => {
    it('counts direct COMPONENT children', () => {
      const set: N = {
        type: 'COMPONENT_SET',
        name: 'Input Box',
        children: [
          { type: 'COMPONENT', name: 'Default' },
          { type: 'COMPONENT', name: 'Hover' },
          { type: 'COMPONENT', name: 'Focus' },
        ],
      };
      expect(countVariantChildren(set)).toBe(3);
    });

    it('ignores non-COMPONENT children inside a SET', () => {
      const set: N = {
        type: 'COMPONENT_SET',
        children: [
          { type: 'COMPONENT', name: 'A' },
          { type: 'TEXT', name: 'description' },     // unrelated child
          { type: 'COMPONENT', name: 'B' },
          { type: 'RECTANGLE', name: 'background' }, // unrelated child
        ],
      };
      expect(countVariantChildren(set)).toBe(2);
    });

    it('returns 0 for a COMPONENT_SET with no COMPONENT children', () => {
      const set: N = { type: 'COMPONENT_SET', children: [{ type: 'TEXT', name: 'x' }] };
      expect(countVariantChildren(set)).toBe(0);
    });
  });

  // ── Legacy Figma: FRAME with variant-named SYMBOL children ─────────
  describe('legacy — variant-named SYMBOL children', () => {
    it('counts direct SYMBOLs whose names match the property=value pattern', () => {
      // Mirror of the metarich "Button" FRAME shape.
      const frame: N = {
        type: 'FRAME',
        name: 'Button',
        children: [
          { type: 'SYMBOL', name: 'size=XL, State=default, Type=primary' },
          { type: 'SYMBOL', name: 'size=XL, State=hover, Type=primary' },
          { type: 'SYMBOL', name: 'size=L, State=default, Type=primary' },
        ],
      };
      expect(countVariantChildren(frame)).toBe(3);
    });

    it('also counts COMPONENT children with variant names (mixed legacy)', () => {
      const frame: N = {
        type: 'FRAME',
        children: [
          { type: 'SYMBOL', name: 'state=default' },
          { type: 'COMPONENT', name: 'state=hover' },
        ],
      };
      expect(countVariantChildren(frame)).toBe(2);
    });

    it('requires ≥2 variant-named children — single child does NOT trigger', () => {
      const frame: N = {
        type: 'FRAME',
        name: 'Button',
        children: [
          { type: 'SYMBOL', name: 'state=default' },
          { type: 'TEXT', name: 'description' },
        ],
      };
      expect(countVariantChildren(frame)).toBe(0);
    });

    it('rejects children without the property=value name pattern', () => {
      // SYMBOL kids exist but their names don't match — not a variant
      // container, just two unrelated icons.
      const frame: N = {
        type: 'FRAME',
        children: [
          { type: 'SYMBOL', name: 'u:check' },
          { type: 'SYMBOL', name: 'u:close' },
        ],
      };
      expect(countVariantChildren(frame)).toBe(0);
    });

    it('accepts Korean property keys (Hangul + word chars)', () => {
      // Korean designers sometimes use Hangul property names. The regex
      // includes [가-힣] explicitly to handle this.
      const frame: N = {
        type: 'FRAME',
        children: [
          { type: 'SYMBOL', name: '상태=기본' },
          { type: 'SYMBOL', name: '상태=호버' },
        ],
      };
      expect(countVariantChildren(frame)).toBe(2);
    });

    it('counts only DIRECT children — does not recurse into grandkids', () => {
      const frame: N = {
        type: 'FRAME',
        children: [
          {
            type: 'FRAME',
            children: [
              { type: 'SYMBOL', name: 'state=default' },
              { type: 'SYMBOL', name: 'state=hover' },
            ],
          },
        ],
      };
      // The grandchildren look like variants but the immediate children
      // (just one nested FRAME) don't.
      expect(countVariantChildren(frame)).toBe(0);
    });
  });
});
