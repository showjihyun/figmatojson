import { describe, expect, it } from 'vitest';
import {
  konvaFontStyle,
  konvaLetterSpacing,
  konvaLineHeight,
  konvaTextAlign,
  konvaVerticalAlign,
} from './textStyle';

describe('konvaLetterSpacing', () => {
  it('returns undefined when input is missing or value is 0', () => {
    expect(konvaLetterSpacing(undefined, 14)).toBeUndefined();
    expect(konvaLetterSpacing({ value: 0, units: 'PERCENT' }, 14)).toBeUndefined();
    expect(konvaLetterSpacing({ value: 0, units: 'PIXELS' }, 14)).toBeUndefined();
  });

  it('PIXELS pass-through', () => {
    expect(konvaLetterSpacing({ value: 1.25, units: 'PIXELS' }, 14)).toBe(1.25);
    expect(konvaLetterSpacing({ value: -0.5, units: 'PIXELS' }, 14)).toBe(-0.5);
  });

  it('PERCENT converts using fontSize: -0.5% on 14px → -0.07px (Korean default)', () => {
    expect(konvaLetterSpacing({ value: -0.5, units: 'PERCENT' }, 14)).toBeCloseTo(-0.07);
  });

  it('PERCENT returns undefined when fontSize is 0 or missing', () => {
    expect(konvaLetterSpacing({ value: -0.5, units: 'PERCENT' }, 0)).toBeUndefined();
    expect(konvaLetterSpacing({ value: -0.5, units: 'PERCENT' }, undefined)).toBeUndefined();
  });

  it('unknown units return undefined', () => {
    expect(konvaLetterSpacing({ value: 5, units: 'EM' as never }, 14)).toBeUndefined();
  });
});

describe('konvaLineHeight', () => {
  it('returns undefined when input is missing or value <= 0', () => {
    expect(konvaLineHeight(undefined, 14)).toBeUndefined();
    expect(konvaLineHeight({ value: 0, units: 'RAW' }, 14)).toBeUndefined();
    expect(konvaLineHeight({ value: -1, units: 'RAW' }, 14)).toBeUndefined();
  });

  it('RAW pass-through (multiplier already)', () => {
    expect(konvaLineHeight({ value: 1.42, units: 'RAW' }, 14)).toBe(1.42);
    expect(konvaLineHeight({ value: 1, units: 'RAW' }, 14)).toBe(1);
  });

  it('PERCENT becomes multiplier (140% → 1.4)', () => {
    expect(konvaLineHeight({ value: 140, units: 'PERCENT' }, 14)).toBe(1.4);
  });

  it('PIXELS becomes multiplier via fontSize (24px / 12px → 2.0)', () => {
    expect(konvaLineHeight({ value: 24, units: 'PIXELS' }, 12)).toBe(2);
  });

  it('PIXELS returns undefined without fontSize', () => {
    expect(konvaLineHeight({ value: 20, units: 'PIXELS' }, 0)).toBeUndefined();
    expect(konvaLineHeight({ value: 20, units: 'PIXELS' }, undefined)).toBeUndefined();
  });
});

describe('konvaVerticalAlign', () => {
  it('maps Figma values', () => {
    expect(konvaVerticalAlign('TOP')).toBe('top');
    expect(konvaVerticalAlign('CENTER')).toBe('middle');
    expect(konvaVerticalAlign('BOTTOM')).toBe('bottom');
  });

  it('returns undefined for unknown / missing', () => {
    expect(konvaVerticalAlign(undefined)).toBeUndefined();
    expect(konvaVerticalAlign('BASELINE' as never)).toBeUndefined();
  });
});

describe('konvaTextAlign', () => {
  it('maps Figma horizontal align', () => {
    expect(konvaTextAlign('LEFT')).toBe('left');
    expect(konvaTextAlign('CENTER')).toBe('center');
    expect(konvaTextAlign('RIGHT')).toBe('right');
    expect(konvaTextAlign('JUSTIFIED')).toBe('justify');
  });

  it('returns undefined for missing / unknown', () => {
    expect(konvaTextAlign(undefined)).toBeUndefined();
    expect(konvaTextAlign('START' as never)).toBeUndefined();
  });
});

describe('konvaFontStyle', () => {
  it('returns undefined for default Regular / Medium / SemiBold (Konva normal)', () => {
    expect(konvaFontStyle(undefined)).toBeUndefined();
    expect(konvaFontStyle('Regular')).toBeUndefined();
    expect(konvaFontStyle('Medium')).toBeUndefined();
    expect(konvaFontStyle('SemiBold')).toBeUndefined();
    expect(konvaFontStyle('')).toBeUndefined();
  });

  it('detects "Bold" and its weighty siblings', () => {
    expect(konvaFontStyle('Bold')).toBe('bold');
    expect(konvaFontStyle('Extra Bold')).toBe('bold');
    expect(konvaFontStyle('ExtraBold')).toBe('bold');
    expect(konvaFontStyle('UltraBold')).toBe('bold');
    expect(konvaFontStyle('Heavy')).toBe('bold');
    expect(konvaFontStyle('Black')).toBe('bold');
  });

  it('detects italic / oblique', () => {
    expect(konvaFontStyle('Italic')).toBe('italic');
    expect(konvaFontStyle('Light Italic')).toBe('italic');
    expect(konvaFontStyle('Oblique')).toBe('italic');
  });

  it('combines bold + italic', () => {
    expect(konvaFontStyle('Bold Italic')).toBe('italic bold');
    expect(konvaFontStyle('Italic Bold')).toBe('italic bold');
  });

  it('ignores stray numeric weights — Konva.Text fontStyle accepts only normal/bold/italic anyway', () => {
    expect(konvaFontStyle('700')).toBeUndefined();
    expect(konvaFontStyle('400')).toBeUndefined();
    // Numeric-style weight info isn't lost — when a font family has the
    // weight available, the browser still uses it via fontFamily lookup.
  });
});
