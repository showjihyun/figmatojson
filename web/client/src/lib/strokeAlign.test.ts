import { describe, expect, it } from 'vitest';
import { applyStrokeAlign, type RectDims } from './strokeAlign';

const D: RectDims = { x: 0, y: 0, w: 100, h: 60, cornerRadius: 8 };

describe('applyStrokeAlign', () => {
  it('returns input unchanged when strokeWeight is missing or 0', () => {
    expect(applyStrokeAlign(D, undefined, 'INSIDE')).toEqual(D);
    expect(applyStrokeAlign(D, 0, 'OUTSIDE')).toEqual(D);
  });

  it('returns input unchanged when strokeAlign is CENTER or undefined', () => {
    expect(applyStrokeAlign(D, 2, undefined)).toEqual(D);
    expect(applyStrokeAlign(D, 2, 'CENTER')).toEqual(D);
  });

  it('INSIDE: shrinks by strokeWeight on each axis, offsets by half (spec I-SA1)', () => {
    expect(applyStrokeAlign(D, 2, 'INSIDE')).toEqual({
      x: 1,
      y: 1,
      w: 98,
      h: 58,
      cornerRadius: 7, // 8 - 1
    });
  });

  it('INSIDE: thicker stroke (4px) — quarter inset, cornerR shrinks accordingly', () => {
    expect(applyStrokeAlign(D, 4, 'INSIDE')).toEqual({
      x: 2,
      y: 2,
      w: 96,
      h: 56,
      cornerRadius: 6,
    });
  });

  it('INSIDE: cornerRadius clamped to 0 (no negative radii)', () => {
    const tightCorner: RectDims = { x: 0, y: 0, w: 100, h: 100, cornerRadius: 1 };
    expect(applyStrokeAlign(tightCorner, 4, 'INSIDE').cornerRadius).toBe(0); // 1 - 2 → clamped
  });

  it('INSIDE: degenerate dims fall back to CENTER (spec I-SA2)', () => {
    const tiny: RectDims = { x: 0, y: 0, w: 2, h: 2, cornerRadius: 0 };
    // strokeWeight 4 would shrink width to -2; we keep input untouched.
    expect(applyStrokeAlign(tiny, 4, 'INSIDE')).toEqual(tiny);
  });

  it('OUTSIDE: expands by strokeWeight on each axis, offsets negative by half (spec I-SA3)', () => {
    expect(applyStrokeAlign(D, 2, 'OUTSIDE')).toEqual({
      x: -1,
      y: -1,
      w: 102,
      h: 62,
      cornerRadius: 9, // 8 + 1
    });
  });

  it('OUTSIDE: cornerRadius grows by half stroke (spec I-SA7)', () => {
    expect(applyStrokeAlign(D, 4, 'OUTSIDE').cornerRadius).toBe(10); // 8 + 2
  });

  // Round 5: cornerRadius can also be a [tl, tr, br, bl] tuple (asymmetric).
  it('INSIDE: per-corner array shrinks every corner by half stroke', () => {
    const asym: RectDims = { x: 0, y: 0, w: 100, h: 60, cornerRadius: [12, 0, 12, 0] };
    expect(applyStrokeAlign(asym, 4, 'INSIDE').cornerRadius).toEqual([10, 0, 10, 0]);
  });

  it('OUTSIDE: per-corner array grows every corner by half stroke', () => {
    const asym: RectDims = { x: 0, y: 0, w: 100, h: 60, cornerRadius: [12, 0, 12, 0] };
    expect(applyStrokeAlign(asym, 4, 'OUTSIDE').cornerRadius).toEqual([14, 2, 14, 2]);
  });

  it('INSIDE: per-corner array clamps any negative result to 0', () => {
    const asym: RectDims = { x: 0, y: 0, w: 100, h: 60, cornerRadius: [4, 0, 0, 1] };
    expect(applyStrokeAlign(asym, 8, 'INSIDE').cornerRadius).toEqual([0, 0, 0, 0]);
  });
});
