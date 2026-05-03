import { describe, expect, it } from 'vitest';
import { cornerRadiusForKonva } from './cornerRadii';

describe('cornerRadiusForKonva', () => {
  it('returns the default radius when no per-corner fields are present', () => {
    expect(cornerRadiusForKonva({}, 8)).toBe(8);
    expect(cornerRadiusForKonva({}, 0)).toBe(0);
  });

  it('returns a number when all four corners are equal (uniform)', () => {
    expect(
      cornerRadiusForKonva({
        rectangleTopLeftCornerRadius: 12,
        rectangleTopRightCornerRadius: 12,
        rectangleBottomRightCornerRadius: 12,
        rectangleBottomLeftCornerRadius: 12,
      }, 0),
    ).toBe(12);
  });

  it('returns the [tl, tr, br, bl] tuple when corners differ', () => {
    expect(
      cornerRadiusForKonva({
        rectangleTopLeftCornerRadius: 12,
        rectangleTopRightCornerRadius: 12,
        rectangleBottomRightCornerRadius: 0,
        rectangleBottomLeftCornerRadius: 0,
      }, 0),
    ).toEqual([12, 12, 0, 0]);
  });

  it('fills missing per-corner fields with the defaultR fallback', () => {
    // Only TL and BR set — TR and BL fall back to defaultR=4.
    expect(
      cornerRadiusForKonva({
        rectangleTopLeftCornerRadius: 8,
        rectangleBottomRightCornerRadius: 16,
      }, 4),
    ).toEqual([8, 4, 16, 4]);
  });

  it('handles a single asymmetric corner among otherwise-default corners', () => {
    expect(
      cornerRadiusForKonva({
        rectangleTopLeftCornerRadius: 24,
      }, 0),
    ).toEqual([24, 0, 0, 0]);
  });
});
