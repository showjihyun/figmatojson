import { describe, expect, it } from 'vitest';
import { variantLabelText, variantLabelTextWidth } from './variantLabel';

describe('variantLabelText', () => {
  it('returns null for empty / nullish input', () => {
    expect(variantLabelText(undefined)).toBeNull();
    expect(variantLabelText(null)).toBeNull();
    expect(variantLabelText('')).toBeNull();
    expect(variantLabelText('   ')).toBeNull();
  });

  it('extracts the value from a single prop=value name', () => {
    expect(variantLabelText('속성 1=기본')).toBe('기본');
    expect(variantLabelText('State=hover')).toBe('hover');
  });

  it('joins values with ", " for multi-prop variant names', () => {
    expect(variantLabelText('size=L, State=hover, Type=primary')).toBe('L, hover, primary');
  });

  it('trims whitespace inside each token', () => {
    expect(variantLabelText('  size = XL ,  Type = Outline ')).toBe('XL, Outline');
  });

  it('returns the input verbatim when no `=` is present', () => {
    expect(variantLabelText('plain name')).toBe('plain name');
    expect(variantLabelText('Button')).toBe('Button');
  });

  it('skips empty values within a multi-prop name', () => {
    expect(variantLabelText('size=, State=hover, Type=')).toBe('hover');
  });

  it('returns null when every value would be empty', () => {
    expect(variantLabelText('size=, Type=')).toBeNull();
  });

  it('keeps non-key=value segments verbatim (defensive)', () => {
    // Defensive — Figma never produces this shape, but make sure we don't crash.
    expect(variantLabelText('size=L, weird, Type=primary')).toBe('L, weird, primary');
  });
});

describe('variantLabelTextWidth', () => {
  it('latin chars are ~6.2px each', () => {
    expect(variantLabelTextWidth('abc')).toBeCloseTo(18.6, 1);
  });

  it('CJK chars count as ~1.5× latin width', () => {
    // 2 hangul chars → 2 * 1.5 * 6.2 = 18.6
    expect(variantLabelTextWidth('기본')).toBeCloseTo(18.6, 1);
  });

  it('mixed string sums correctly', () => {
    // "L, " = 3 latin = 18.6; "기본" = 18.6 → total 37.2
    expect(variantLabelTextWidth('L, 기본')).toBeCloseTo(37.2, 1);
  });
});
