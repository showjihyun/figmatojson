import { describe, expect, it } from 'vitest';
import { solidFillCss, solidStrokeCss, strokeFromPaints } from './color';

describe('solidFillCss — topmost-paint precedence', () => {
  it('returns transparent for missing or non-array fillPaints', () => {
    expect(solidFillCss({})).toBe('transparent');
    expect(solidFillCss({ fillPaints: null as unknown })).toBe('transparent');
  });

  it('picks the TOPMOST visible SOLID (not the bottom)', () => {
    const bottom = { type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 } };
    const top = { type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 1, a: 1 } };
    expect(solidFillCss({ fillPaints: [bottom, top] })).toBe('rgba(0,0,255,1.000)');
  });

  it('applies paint.opacity on top of color.a', () => {
    expect(
      solidFillCss({
        fillPaints: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.5 }],
      }),
    ).toBe('rgba(0,0,0,0.500)');
  });

  it('skips hidden / non-SOLID paints on top and falls through to next', () => {
    const out = solidFillCss({
      fillPaints: [
        { type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 } },
        { type: 'SOLID', visible: false, color: { r: 0, g: 1, b: 0, a: 1 } },
        { type: 'IMAGE', visible: true },
      ],
    });
    // Top (IMAGE) skipped, middle (hidden) skipped → bottom SOLID wins.
    expect(out).toBe('rgba(255,0,0,1.000)');
  });

  it('returns transparent when no SOLID paint exists', () => {
    expect(
      solidFillCss({
        fillPaints: [{ type: 'GRADIENT_LINEAR', visible: true, stops: [] }],
      }),
    ).toBe('transparent');
  });
});

describe('solidStrokeCss — topmost-paint precedence', () => {
  it('picks the TOPMOST visible SOLID stroke', () => {
    const bottom = { type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 } };
    const top = { type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 1, a: 1 } };
    expect(
      solidStrokeCss({ strokeWeight: 2, strokePaints: [bottom, top] }),
    ).toEqual({ color: 'rgba(0,0,255,1.000)', width: 2 });
  });

  it('applies paint.opacity', () => {
    expect(
      solidStrokeCss({
        strokeWeight: 1,
        strokePaints: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.25 }],
      }),
    ).toEqual({ color: 'rgba(0,0,0,0.250)', width: 1 });
  });
});

describe('strokeFromPaints', () => {
  it('returns null when strokeWeight is missing or 0', () => {
    expect(strokeFromPaints({ strokePaints: [{ type: 'SOLID' }] })).toBeNull();
    expect(strokeFromPaints({ strokeWeight: 0, strokePaints: [{ type: 'SOLID' }] })).toBeNull();
  });

  it('returns null when strokePaints is missing or empty', () => {
    expect(strokeFromPaints({ strokeWeight: 1 })).toBeNull();
    expect(strokeFromPaints({ strokeWeight: 1, strokePaints: [] })).toBeNull();
  });

  it('SOLID paint resolves with paint.opacity baked in', () => {
    const out = strokeFromPaints({
      strokeWeight: 2,
      strokePaints: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5 }],
    });
    expect(out).toEqual({ color: 'rgba(255,0,0,0.500)', width: 2 });
  });

  it('skips hidden paints when scanning', () => {
    const out = strokeFromPaints({
      strokeWeight: 1,
      strokePaints: [
        { type: 'SOLID', visible: false, color: { r: 1, g: 0, b: 0, a: 1 } },
        { type: 'SOLID', visible: true, color: { r: 0, g: 1, b: 0, a: 1 } },
      ],
    });
    expect(out?.color).toBe('rgba(0,255,0,1.000)');
  });

  it('GRADIENT_LINEAR falls back to first-stop color (round 8 §3 I-SG1)', () => {
    const out = strokeFromPaints({
      strokeWeight: 2,
      strokePaints: [
        {
          type: 'GRADIENT_LINEAR',
          visible: true,
          stops: [
            { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
            { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
          ],
        },
      ],
    });
    expect(out).toEqual({ color: 'rgba(255,0,0,1.000)', width: 2 });
  });

  it('GRADIENT_RADIAL / ANGULAR / DIAMOND all fall back to first-stop', () => {
    for (const type of ['GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']) {
      const out = strokeFromPaints({
        strokeWeight: 1,
        strokePaints: [
          { type, visible: true, stops: [{ color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, position: 0 }] },
        ],
      });
      expect(out?.color).toBe('rgba(128,128,128,1.000)');
    }
  });

  it('IMAGE stroke is not yet supported — returns null', () => {
    const out = strokeFromPaints({
      strokeWeight: 1,
      strokePaints: [{ type: 'IMAGE', visible: true }],
    });
    expect(out).toBeNull();
  });

  it('walks past unsupported paints to find a usable one', () => {
    const out = strokeFromPaints({
      strokeWeight: 1,
      strokePaints: [
        { type: 'IMAGE', visible: true },
        { type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    });
    expect(out?.color).toBe('rgba(0,0,0,1.000)');
  });

  it('picks the TOPMOST visible paint (not bottom) — multi-stroke layering', () => {
    const out = strokeFromPaints({
      strokeWeight: 1,
      strokePaints: [
        { type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 } }, // bottom
        { type: 'SOLID', visible: true, color: { r: 0, g: 1, b: 0, a: 1 } }, // top
      ],
    });
    expect(out?.color).toBe('rgba(0,255,0,1.000)');
  });
});
