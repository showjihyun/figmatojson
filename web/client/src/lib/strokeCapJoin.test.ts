import { describe, expect, it } from 'vitest';
import { konvaLineCap, konvaLineJoin } from './strokeCapJoin';

describe('konvaLineCap', () => {
  it('maps Figma values', () => {
    expect(konvaLineCap('NONE')).toBe('butt');
    expect(konvaLineCap('ROUND')).toBe('round');
    expect(konvaLineCap('SQUARE')).toBe('square');
  });

  it('returns undefined for missing / unknown / unsupported (LINE_ARROW etc)', () => {
    expect(konvaLineCap(undefined)).toBeUndefined();
    expect(konvaLineCap('LINE_ARROW')).toBeUndefined();
    expect(konvaLineCap('TRIANGLE_ARROW')).toBeUndefined();
    expect(konvaLineCap('foo' as never)).toBeUndefined();
  });
});

describe('konvaLineJoin', () => {
  it('maps Figma values', () => {
    expect(konvaLineJoin('MITER')).toBe('miter');
    expect(konvaLineJoin('ROUND')).toBe('round');
    expect(konvaLineJoin('BEVEL')).toBe('bevel');
  });

  it('returns undefined for missing / unknown', () => {
    expect(konvaLineJoin(undefined)).toBeUndefined();
    expect(konvaLineJoin('foo' as never)).toBeUndefined();
  });
});
