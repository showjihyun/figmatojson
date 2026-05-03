import { describe, expect, it } from 'vitest';
import { konvaBlendMode } from './blendMode';

describe('konvaBlendMode', () => {
  it('returns undefined for NORMAL / PASS_THROUGH / missing', () => {
    expect(konvaBlendMode('NORMAL')).toBeUndefined();
    expect(konvaBlendMode('PASS_THROUGH')).toBeUndefined();
    expect(konvaBlendMode(undefined)).toBeUndefined();
    expect(konvaBlendMode('')).toBeUndefined();
  });

  it('maps every named Figma blend mode to its CSS / canvas equivalent', () => {
    expect(konvaBlendMode('DARKEN')).toBe('darken');
    expect(konvaBlendMode('MULTIPLY')).toBe('multiply');
    expect(konvaBlendMode('COLOR_BURN')).toBe('color-burn');
    expect(konvaBlendMode('LIGHTEN')).toBe('lighten');
    expect(konvaBlendMode('SCREEN')).toBe('screen');
    expect(konvaBlendMode('COLOR_DODGE')).toBe('color-dodge');
    expect(konvaBlendMode('OVERLAY')).toBe('overlay');
    expect(konvaBlendMode('SOFT_LIGHT')).toBe('soft-light');
    expect(konvaBlendMode('HARD_LIGHT')).toBe('hard-light');
    expect(konvaBlendMode('DIFFERENCE')).toBe('difference');
    expect(konvaBlendMode('EXCLUSION')).toBe('exclusion');
    expect(konvaBlendMode('HUE')).toBe('hue');
    expect(konvaBlendMode('SATURATION')).toBe('saturation');
    expect(konvaBlendMode('COLOR')).toBe('color');
    expect(konvaBlendMode('LUMINOSITY')).toBe('luminosity');
  });

  it('returns undefined for unknown values', () => {
    expect(konvaBlendMode('BIZARRO')).toBeUndefined();
  });
});
