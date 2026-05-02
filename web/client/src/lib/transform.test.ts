import { describe, expect, it } from 'vitest';
import { isPureRotation, rotationDegrees } from './transform';

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
