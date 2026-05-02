import { describe, expect, it } from 'vitest';
import { pickTopPaint } from './paint';

describe('pickTopPaint', () => {
  it('returns null for missing / empty arrays', () => {
    expect(pickTopPaint(undefined)).toBeNull();
    expect(pickTopPaint([])).toBeNull();
  });

  it('returns the only paint when there is just one (visible non-IMAGE)', () => {
    const p = { type: 'SOLID', visible: true };
    expect(pickTopPaint([p])).toBe(p);
  });

  it('picks the LAST visible paint — Figma stacks bottom-up so [N-1] is on top', () => {
    const bottom = { type: 'SOLID', visible: true, color: 'white' };
    const top = { type: 'SOLID', visible: true, color: 'blue' };
    expect(pickTopPaint([bottom, top])).toBe(top);
  });

  it('skips hidden paints when scanning from the top', () => {
    const bottom = { type: 'SOLID', visible: true, color: 'red' };
    const middle = { type: 'SOLID', visible: false, color: 'green' };
    const top = { type: 'SOLID', visible: false, color: 'blue' };
    // Both top entries hidden → falls through to bottom.
    expect(pickTopPaint([bottom, middle, top])).toBe(bottom);
  });

  it('skips IMAGE paints (handled separately by ImageFill)', () => {
    const solid = { type: 'SOLID', visible: true };
    const image = { type: 'IMAGE', visible: true };
    expect(pickTopPaint([solid, image])).toBe(solid);
  });

  it('returns null when every visible paint is IMAGE / hidden', () => {
    expect(
      pickTopPaint([
        { type: 'IMAGE', visible: true },
        { type: 'SOLID', visible: false },
      ]),
    ).toBeNull();
  });

  it('returns gradient paints (any non-IMAGE type qualifies)', () => {
    const gradient = { type: 'GRADIENT_LINEAR', visible: true };
    expect(pickTopPaint([gradient])).toBe(gradient);
  });

  it('treats undefined visible as visible (Figma default)', () => {
    const p = { type: 'SOLID' };
    expect(pickTopPaint([p])).toBe(p);
  });
});
