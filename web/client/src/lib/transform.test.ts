import { describe, expect, it } from 'vitest';
import { decomposeTransform, isPureRotation, rotationDegrees } from './transform';

describe('rotationDegrees', () => {
  it('returns undefined when transform is missing', () => {
    expect(rotationDegrees(undefined)).toBeUndefined();
  });

  it('returns undefined for identity matrix', () => {
    expect(rotationDegrees({ m00: 1, m01: 0, m10: 0, m11: 1 })).toBeUndefined();
    // Implicit identity (all linear fields missing).
    expect(rotationDegrees({ m02: 100, m12: 200 })).toBeUndefined();
  });

  it('extracts 90° rotation from canonical matrix', () => {
    // 90° CCW in screen coords: m00 = cos(90) = 0, m10 = sin(90) = 1.
    // (Rotation by 90° in Y-down = m00=0, m01=-1, m10=1, m11=0.)
    expect(rotationDegrees({ m00: 0, m01: -1, m10: 1, m11: 0 })).toBeCloseTo(90);
  });

  it('extracts 45° rotation', () => {
    const c = Math.cos(Math.PI / 4);
    const s = Math.sin(Math.PI / 4);
    expect(rotationDegrees({ m00: c, m01: -s, m10: s, m11: c })).toBeCloseTo(45);
  });

  it('extracts negative rotation', () => {
    // -30°
    const c = Math.cos(-Math.PI / 6);
    const s = Math.sin(-Math.PI / 6);
    expect(rotationDegrees({ m00: c, m01: -s, m10: s, m11: c })).toBeCloseTo(-30);
  });

  it('returns undefined when there is skew (non-pure rotation)', () => {
    // Skew: m01 ≠ -m10.
    expect(rotationDegrees({ m00: 1, m01: 0.5, m10: 0, m11: 1 })).toBeUndefined();
  });

  it('returns undefined when there is non-uniform scale', () => {
    expect(rotationDegrees({ m00: 2, m01: 0, m10: 0, m11: 1 })).toBeUndefined();
  });

  it('clamps near-zero rotation to undefined (floating-point noise)', () => {
    // Sub-0.01° rotation should be treated as identity.
    const tinyRad = 0.00001;
    expect(
      rotationDegrees({
        m00: Math.cos(tinyRad),
        m01: -Math.sin(tinyRad),
        m10: Math.sin(tinyRad),
        m11: Math.cos(tinyRad),
      }),
    ).toBeUndefined();
  });
});

describe('isPureRotation', () => {
  it('treats missing transform as identity (pure)', () => {
    expect(isPureRotation(undefined)).toBe(true);
  });

  it('accepts identity', () => {
    expect(isPureRotation({ m00: 1, m01: 0, m10: 0, m11: 1 })).toBe(true);
  });

  it('accepts pure rotation matrices', () => {
    const c = Math.cos(0.7);
    const s = Math.sin(0.7);
    expect(isPureRotation({ m00: c, m01: -s, m10: s, m11: c })).toBe(true);
  });

  it('rejects skew', () => {
    expect(isPureRotation({ m00: 1, m01: 0.3, m10: 0, m11: 1 })).toBe(false);
    expect(isPureRotation({ m00: 1, m01: 0, m10: 0.3, m11: 1 })).toBe(false);
  });

  it('rejects non-uniform scale', () => {
    expect(isPureRotation({ m00: 2, m01: 0, m10: 0, m11: 1 })).toBe(false);
  });

  it('accepts uniform scale + rotation (m00=m11, m01=-m10)', () => {
    // 2x scale + 30° rotation
    const θ = Math.PI / 6;
    const c = 2 * Math.cos(θ);
    const s = 2 * Math.sin(θ);
    expect(isPureRotation({ m00: c, m01: -s, m10: s, m11: c })).toBe(true);
  });
});

// Round 34 — full rotation + axis-aligned scale decomposition. The
// failing fixture: Material 3 hour-line variant for Hour 7 stores
// `R(120°) ∘ scale(1, -1)` (det = -1, mirror over the X axis). The old
// `rotationDegrees` rejected it as non-pure-rotation and returned
// undefined, leaving the line un-rotated and pointing at 3 o'clock
// instead of 7. `decomposeTransform` now surfaces both fields so the
// renderer can pass them through to Konva.
describe('decomposeTransform', () => {
  it('returns all-undefined for missing / identity input', () => {
    expect(decomposeTransform(undefined)).toEqual({
      rotation: undefined, scaleX: undefined, scaleY: undefined,
    });
    expect(decomposeTransform({ m00: 1, m01: 0, m10: 0, m11: 1 })).toEqual({
      rotation: undefined, scaleX: undefined, scaleY: undefined,
    });
  });

  it('extracts pure rotation (90°) with no scale fields set', () => {
    const out = decomposeTransform({ m00: 0, m01: -1, m10: 1, m11: 0 });
    expect(out.rotation).toBeCloseTo(90);
    expect(out.scaleX).toBeUndefined();
    expect(out.scaleY).toBeUndefined();
  });

  it('extracts R(120°) ∘ scale(1, -1) — the Material 3 hour-line case', () => {
    // m00 = -0.5,  m01 = +0.866
    // m10 = +0.866, m11 = +0.5
    // det = -1 → mirror; cos(θ)=−0.5, sin(θ)=0.866 → θ = 120°
    const m00 = -0.5;
    const m01 = Math.sin(2 * Math.PI / 3);  // +sin(120°) = +0.866
    const m10 = Math.sin(2 * Math.PI / 3);  // +sin(120°) = +0.866
    const m11 = 0.5;
    const out = decomposeTransform({ m00, m01, m10, m11 });
    expect(out.rotation).toBeCloseTo(120);
    expect(out.scaleX).toBeUndefined();         // sx = 1 → undefined
    expect(out.scaleY).toBeCloseTo(-1);
  });

  it('extracts uniform 2x scale + 45° rotation', () => {
    const θ = Math.PI / 4;
    const out = decomposeTransform({
      m00: 2 * Math.cos(θ),
      m01: -2 * Math.sin(θ),
      m10: 2 * Math.sin(θ),
      m11: 2 * Math.cos(θ),
    });
    expect(out.rotation).toBeCloseTo(45);
    expect(out.scaleX).toBeCloseTo(2);
    expect(out.scaleY).toBeCloseTo(2);
  });

  it('returns undefined fields when matrix has skew (non-axis-aligned scale)', () => {
    // Real skew: m01 + m10 != 0 with m00 != m11.
    const out = decomposeTransform({ m00: 1, m01: 0.5, m10: 0.5, m11: 1 });
    expect(out.rotation).toBeUndefined();
    expect(out.scaleX).toBeUndefined();
    expect(out.scaleY).toBeUndefined();
  });

  it('rotationDegrees stays backward-compatible — only returns the rotation field', () => {
    // 60° + Y-flip: rotationDegrees should now return 60 (not undefined),
    // since decomposeTransform recognizes it.
    const out = rotationDegrees({
      m00: Math.cos(Math.PI / 3),
      m01: Math.sin(Math.PI / 3),   // +sin (mirror sign)
      m10: Math.sin(Math.PI / 3),
      m11: -Math.cos(Math.PI / 3),  // -cos (flipped)
    });
    expect(out).toBeCloseTo(60);
  });
});
