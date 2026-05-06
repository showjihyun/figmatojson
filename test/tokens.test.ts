/**
 * tokens.ts — design token extraction (Phase 1).
 *
 * Spec: docs/specs/tokens.spec.md. Each test references a spec
 * invariant by ID (I-T1..T17, I-C1..C8).
 */
import { describe, expect, it } from 'vitest';
import { extractTokens, formatTokens, type Tokens } from '../src/tokens.js';
import type { DecodedFig } from '../src/decoder.js';

// Minimal `DecodedFig` shape — the rest of the fields aren't read by
// `extractTokens`, so a cast keeps tests focused on the contract.
function makeDecoded(nodeChanges: Array<Record<string, unknown>>): DecodedFig {
  return {
    message: { nodeChanges },
  } as unknown as DecodedFig;
}

function styleNode(over: Record<string, unknown>): Record<string, unknown> {
  return { name: 'Untitled', visible: true, ...over };
}

describe('extractTokens — colors (FILL styles)', () => {
  it('I-T1: opaque SOLID emits #RRGGBB', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Brand/Primary',
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.colors['Brand/Primary']?.value).toBe('#ff0000');
  });

  it('I-T1: alpha < 1 emits #RRGGBBAA', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Overlay',
        fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 0.5 }, opacity: 1, visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.colors['Overlay']?.value).toBe('#00000080');
  });

  it('I-T1: opacity multiplies into alpha channel', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Half',
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0.5, visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.colors['Half']?.value).toBe('#ffffff80');
  });

  it('I-T2: description passes through when present', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Doc',
        description: 'Use for primary CTAs only',
        fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1, a: 1 }, visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.colors['Doc']?.description).toBe('Use for primary CTAs only');
  });

  it('I-T3: gradient FILL is skipped (entry not emitted)', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Sunset',
        fillPaints: [{ type: 'GRADIENT_LINEAR', visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.colors['Sunset']).toBeUndefined();
  });

  it('I-T3: image FILL is skipped', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Photo',
        fillPaints: [{ type: 'IMAGE', visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.colors['Photo']).toBeUndefined();
  });

  it('I-T4: invisible first paint is skipped, first visible SOLID wins', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Layered',
        fillPaints: [
          { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, visible: false },   // hidden red
          { type: 'GRADIENT_LINEAR', visible: true },                              // unsupported gradient
          { type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 }, visible: true },    // visible green
        ],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    // First visible paint is the GRADIENT (unsupported) — not the green SOLID.
    // Spec I-T4 says "first visible" wins; v1 emits nothing when that's
    // a non-SOLID type rather than walking past it.
    expect(t.colors['Layered']).toBeUndefined();
  });
});

describe('extractTokens — typography (TEXT styles)', () => {
  it('I-T5: emits family / style / size from fontName + fontSize', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'TEXT',
        name: 'Heading/XL',
        fontSize: 24,
        fontName: { family: 'Pretendard', style: 'Bold' },
        lineHeight: { value: 1.33, units: 'RAW' },
        letterSpacing: { value: -0.5, units: 'PERCENT' },
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.typography['Heading/XL']).toMatchObject({
      fontFamily: 'Pretendard',
      fontStyle: 'Bold',
      fontSize: 24,
    });
  });

  it('I-T6: PIXELS lineHeight → unit "PX"', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'TEXT',
        name: 'Body',
        fontSize: 16,
        fontName: { family: 'Inter', style: 'Regular' },
        lineHeight: { value: 24, units: 'PIXELS' },
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.typography['Body']?.lineHeight).toEqual({ unit: 'PX', value: 24 });
  });

  it('I-T6: PERCENT lineHeight → unit "PERCENT"', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'TEXT',
        name: 'Body',
        fontSize: 16,
        fontName: { family: 'Inter', style: 'Regular' },
        lineHeight: { value: 150, units: 'PERCENT' },
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.typography['Body']?.lineHeight).toEqual({ unit: 'PERCENT', value: 150 });
  });

  it('I-T6: RAW lineHeight → unit "AUTO" with multiplier value', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'TEXT',
        name: 'Body',
        fontSize: 16,
        fontName: { family: 'Inter', style: 'Regular' },
        lineHeight: { value: 1.4, units: 'RAW' },
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.typography['Body']?.lineHeight).toEqual({ unit: 'AUTO', value: 1.4 });
  });

  it('I-T6: missing lineHeight defaults to AUTO 1', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'TEXT',
        name: 'Body',
        fontSize: 16,
        fontName: { family: 'Inter', style: 'Regular' },
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.typography['Body']?.lineHeight).toEqual({ unit: 'AUTO', value: 1 });
  });

  it('I-T7: PERCENT letterSpacing → unit "PERCENT"', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'TEXT',
        name: 'Body',
        fontSize: 16,
        fontName: { family: 'Inter', style: 'Regular' },
        letterSpacing: { value: -2, units: 'PERCENT' },
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.typography['Body']?.letterSpacing).toEqual({ unit: 'PERCENT', value: -2 });
  });

  it('I-T7: PIXELS / undefined letterSpacing → unit "PX"', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'TEXT',
        name: 'A',
        fontSize: 16,
        fontName: { family: 'Inter', style: 'Regular' },
        letterSpacing: { value: 0.5, units: 'PIXELS' },
      }),
      styleNode({
        styleType: 'TEXT',
        name: 'B',
        fontSize: 16,
        fontName: { family: 'Inter', style: 'Regular' },
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.typography['A']?.letterSpacing).toEqual({ unit: 'PX', value: 0.5 });
    expect(t.typography['B']?.letterSpacing).toEqual({ unit: 'PX', value: 0 });
  });

  it('I-T5: missing fontSize → typography entry not emitted', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'TEXT',
        name: 'NoSize',
        fontName: { family: 'Inter', style: 'Regular' },
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.typography['NoSize']).toBeUndefined();
  });
});

describe('extractTokens — effects (EFFECT styles)', () => {
  it('I-T9 + I-T10: DROP_SHADOW emits color + offset + radius + spread', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'EFFECT',
        name: 'shadow1',
        effects: [
          {
            type: 'DROP_SHADOW',
            color: { r: 0, g: 0, b: 0, a: 0.25 },
            offset: { x: 0, y: 4 },
            radius: 12,
            spread: 2,
            visible: true,
          },
        ],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.effects['shadow1']).toEqual({
      type: 'DROP_SHADOW',
      color: '#00000040',
      offset: { x: 0, y: 4 },
      radius: 12,
      spread: 2,
    });
  });

  it('I-T11: LAYER_BLUR maps radius → blur (no shadow fields)', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'EFFECT',
        name: 'mistify',
        effects: [{ type: 'LAYER_BLUR', radius: 8, visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.effects['mistify']).toEqual({ type: 'LAYER_BLUR', blur: 8 });
  });

  it('I-T12: invisible first effect is skipped, second visible wins', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'EFFECT',
        name: 'multi',
        effects: [
          { type: 'DROP_SHADOW', visible: false, color: { r: 1, g: 0, b: 0, a: 1 } },
          { type: 'LAYER_BLUR', radius: 4, visible: true },
        ],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.effects['multi']).toEqual({ type: 'LAYER_BLUR', blur: 4 });
  });
});

describe('extractTokens — node selection rules', () => {
  it('I-T13: nodes without styleType are ignored', () => {
    const decoded = makeDecoded([
      { type: 'FRAME', name: 'Just a frame', size: { x: 100, y: 100 } },
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(Object.keys(t.colors)).toHaveLength(0);
    expect(Object.keys(t.typography)).toHaveLength(0);
    expect(Object.keys(t.effects)).toHaveLength(0);
  });

  it('I-T13: unsupported styleType is ignored', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'GRID',
        name: 'GridStyle',
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(Object.keys(t.colors)).toHaveLength(0);
  });

  it('I-T13: nodes with styleType but no name are skipped', () => {
    const decoded = makeDecoded([
      {
        styleType: 'FILL',
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, visible: true }],
      },
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(Object.keys(t.colors)).toHaveLength(0);
  });

  it('I-T14: name preserved verbatim including "/" namespace', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Global / Neutral / Grey 100',
        fillPaints: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.colors['Global / Neutral / Grey 100']).toBeDefined();
  });

  it('I-T15: duplicate name → last entry wins (deterministic)', () => {
    const decoded = makeDecoded([
      styleNode({
        styleType: 'FILL',
        name: 'Dup',
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }],
      }),
      styleNode({
        styleType: 'FILL',
        name: 'Dup',
        fillPaints: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 }, visible: true }],
      }),
    ]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect(t.colors['Dup']?.value).toBe('#00ff00');
  });

  it('I-T16: spacing field absent from Tokens shape (v1 non-target)', () => {
    const decoded = makeDecoded([]);
    const t = extractTokens(decoded, 'fixture.fig');
    expect((t as Record<string, unknown>).spacing).toBeUndefined();
  });
});

describe('extractTokens — top-level shape', () => {
  it('schemaVersion is "1" and source.figName flows through', () => {
    const t = extractTokens(makeDecoded([]), 'design.fig');
    expect(t.schemaVersion).toBe('1');
    expect(t.source.figName).toBe('design.fig');
  });
});

// ─── formatTokens ──────────────────────────────────────────────────

const SAMPLE_TOKENS: Tokens = {
  schemaVersion: '1',
  source: { figName: 'sample.fig' },
  colors: { 'Brand/Primary': { value: '#ff0000' } },
  typography: {
    'Heading/H1': {
      fontFamily: 'Inter',
      fontStyle: 'Bold',
      fontSize: 32,
      lineHeight: { unit: 'PX', value: 40 },
      letterSpacing: { unit: 'PX', value: -0.5 },
    },
  },
  effects: {
    'shadow/sm': {
      type: 'DROP_SHADOW',
      color: '#00000040',
      offset: { x: 0, y: 2 },
      radius: 4,
      spread: 0,
    },
  },
};

describe('formatTokens', () => {
  it('I-C5: json format uses 2-space indent and ends with newline', () => {
    const out = formatTokens(SAMPLE_TOKENS, 'json');
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('  "schemaVersion": "1"');
  });

  it('I-C6: css emits :root block with category-prefixed slugs', () => {
    const out = formatTokens(SAMPLE_TOKENS, 'css');
    expect(out).toContain(':root {');
    expect(out).toContain('--color-brand-primary: #ff0000;');
    expect(out).toContain('--typography-heading-h1-font-family: "Inter";');
    expect(out).toContain('--typography-heading-h1-font-size: 32px;');
    expect(out).toContain('--typography-heading-h1-line-height: 40px;');
    expect(out).toContain('--shadow-shadow-sm: 0px 2px 4px 0px #00000040;');
  });

  it('I-C6: css preserves Hangul in slugs', () => {
    const tokens: Tokens = {
      schemaVersion: '1',
      source: { figName: 'k.fig' },
      colors: { '버튼/기본': { value: '#0066ff' } },
      typography: {},
      effects: {},
    };
    const out = formatTokens(tokens, 'css');
    expect(out).toContain('--color-버튼-기본: #0066ff;');
  });

  it('I-C7: js format emits ESM `export default`', () => {
    const out = formatTokens(SAMPLE_TOKENS, 'js');
    expect(out).toContain('export default {');
    expect(out).toContain('"Brand/Primary"');
  });

  it('I-C8: ts format emits typed const + default export', () => {
    const out = formatTokens(SAMPLE_TOKENS, 'ts');
    expect(out).toContain("import type { Tokens } from 'figma-reverse';");
    expect(out).toContain('export const tokens: Tokens =');
    expect(out).toContain('export default tokens;');
  });

  it('css INNER_SHADOW emits `inset` keyword', () => {
    const tokens: Tokens = {
      schemaVersion: '1',
      source: { figName: 's.fig' },
      colors: {},
      typography: {},
      effects: {
        inset1: {
          type: 'INNER_SHADOW',
          color: '#00000080',
          offset: { x: 0, y: -1 },
          radius: 2,
          spread: 0,
        },
      },
    };
    const out = formatTokens(tokens, 'css');
    expect(out).toContain('--shadow-inset1: inset 0px -1px 2px 0px #00000080;');
  });

  it('css line-height PERCENT emits "%" suffix', () => {
    const tokens: Tokens = {
      schemaVersion: '1',
      source: { figName: 'p.fig' },
      colors: {},
      typography: {
        body: {
          fontFamily: 'Inter',
          fontStyle: 'Regular',
          fontSize: 16,
          lineHeight: { unit: 'PERCENT', value: 150 },
          letterSpacing: { unit: 'PERCENT', value: -2 },
        },
      },
      effects: {},
    };
    const out = formatTokens(tokens, 'css');
    expect(out).toContain('--typography-body-line-height: 150%;');
    // PERCENT letter-spacing converts to em (100% → 1em)
    expect(out).toContain('--typography-body-letter-spacing: -0.02em;');
  });

  it('css line-height AUTO emits unitless multiplier', () => {
    const tokens: Tokens = {
      schemaVersion: '1',
      source: { figName: 'a.fig' },
      colors: {},
      typography: {
        body: {
          fontFamily: 'Inter',
          fontStyle: 'Regular',
          fontSize: 16,
          lineHeight: { unit: 'AUTO', value: 1.4 },
          letterSpacing: { unit: 'PX', value: 0 },
        },
      },
      effects: {},
    };
    const out = formatTokens(tokens, 'css');
    expect(out).toContain('--typography-body-line-height: 1.4;');
  });
});
