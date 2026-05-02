import { describe, expect, it } from 'vitest';
import { firstStopRgba, gradientFromPaint } from './gradient';

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };

describe('gradientFromPaint — LINEAR', () => {
  it('returns null for missing / hidden / non-gradient paints', () => {
    expect(gradientFromPaint(undefined, 100, 50)).toBeNull();
    expect(gradientFromPaint({ type: 'GRADIENT_LINEAR', visible: false }, 100, 50)).toBeNull();
    expect(gradientFromPaint({ type: 'SOLID' }, 100, 50)).toBeNull();
  });

  it('horizontal gradient (identity transform): start=(0,h/2), end=(w,h/2)', () => {
    const out = gradientFromPaint(
      {
        type: 'GRADIENT_LINEAR',
        transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        stops: [{ color: RED, position: 0 }, { color: BLUE, position: 1 }],
      },
      100,
      50,
    );
    expect(out).not.toBeNull();
    if (out!.kind !== 'linear') throw new Error('expected linear');
    expect(out.fillLinearGradientStartPoint).toEqual({ x: 0, y: 25 });
    expect(out.fillLinearGradientEndPoint).toEqual({ x: 100, y: 25 });
    // Stops emitted as flat array [pos, css, pos, css].
    expect(out.fillLinearGradientColorStops[0]).toBe(0);
    expect(out.fillLinearGradientColorStops[1]).toBe('rgba(255,0,0,1.000)');
    expect(out.fillLinearGradientColorStops[2]).toBe(1);
    expect(out.fillLinearGradientColorStops[3]).toBe('rgba(0,0,255,1.000)');
  });

  it('vertical gradient (90° rotation transform from metarich)', () => {
    // The exact matrix metarich uses for top→bottom gradients:
    //   m00≈0, m01=1, m10=-1, m11≈0, m02=0, m12=1
    // start = (m01*0.5 + m02, m11*0.5 + m12) = (0.5, 1)
    // end   = (m00 + m01*0.5 + m02, m10 + m11*0.5 + m12) = (0.5, 0)
    // → vertical gradient running BOTTOM-CENTER → TOP-CENTER.
    const out = gradientFromPaint(
      {
        type: 'GRADIENT_LINEAR',
        transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
        stops: [{ color: RED, position: 0 }, { color: BLUE, position: 1 }],
      },
      200,
      100,
    );
    if (out?.kind !== 'linear') throw new Error('expected linear');
    expect(out.fillLinearGradientStartPoint.x).toBeCloseTo(100);
    expect(out.fillLinearGradientStartPoint.y).toBeCloseTo(100);
    expect(out.fillLinearGradientEndPoint.x).toBeCloseTo(100);
    expect(out.fillLinearGradientEndPoint.y).toBeCloseTo(0);
  });

  it('respects paint.opacity by multiplying into stop alpha', () => {
    const out = gradientFromPaint(
      {
        type: 'GRADIENT_LINEAR',
        opacity: 0.5,
        transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }],
      },
      10,
      10,
    );
    if (out?.kind !== 'linear') throw new Error('expected linear');
    // 1 * 0.5 = 0.5 alpha.
    expect(out.fillLinearGradientColorStops[1]).toBe('rgba(255,0,0,0.500)');
  });
});

describe('gradientFromPaint — RADIAL', () => {
  it('center + radius derived from transform', () => {
    // Identity: center maps to (0.5, 0.5) → (w/2, h/2). edge at (1, 0.5) →
    // (w, h/2). dx = (w - w/2) = w/2; dy = 0; radius = w/2.
    const out = gradientFromPaint(
      {
        type: 'GRADIENT_RADIAL',
        transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        stops: [{ color: RED, position: 0 }, { color: BLUE, position: 1 }],
      },
      200,
      100,
    );
    if (out?.kind !== 'radial') throw new Error('expected radial');
    expect(out.fillRadialGradientStartPoint).toEqual({ x: 100, y: 50 });
    expect(out.fillRadialGradientStartRadius).toBe(0);
    expect(out.fillRadialGradientEndRadius).toBeCloseTo(100); // w/2
  });
});

describe('gradientFromPaint — ANGULAR / DIAMOND fallback', () => {
  it('returns null (caller picks first-stop solid)', () => {
    const angular = { type: 'GRADIENT_ANGULAR', stops: [{ color: RED, position: 0 }] };
    const diamond = { type: 'GRADIENT_DIAMOND', stops: [{ color: BLUE, position: 0 }] };
    expect(gradientFromPaint(angular, 10, 10)).toBeNull();
    expect(gradientFromPaint(diamond, 10, 10)).toBeNull();
  });
});

describe('firstStopRgba', () => {
  it('returns the rgba string of stops[0] with paint.opacity applied', () => {
    expect(
      firstStopRgba({
        type: 'GRADIENT_ANGULAR',
        opacity: 0.5,
        stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }],
      }),
    ).toBe('rgba(255,0,0,0.500)');
  });

  it('returns null when paint or stops are missing', () => {
    expect(firstStopRgba(undefined)).toBeNull();
    expect(firstStopRgba({ type: 'GRADIENT_LINEAR' })).toBeNull();
    expect(firstStopRgba({ type: 'GRADIENT_LINEAR', stops: [] })).toBeNull();
  });
});
