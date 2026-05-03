import { describe, expect, it } from 'vitest';
import { innerShadowFromEffects, shadowFromEffects } from './shadow';

describe('shadowFromEffects', () => {
  it('returns null for missing / empty / non-array effects', () => {
    expect(shadowFromEffects(undefined)).toBeNull();
    expect(shadowFromEffects([])).toBeNull();
    expect(shadowFromEffects(null as never)).toBeNull();
  });

  it('returns null when no entry is a visible DROP_SHADOW', () => {
    expect(shadowFromEffects([{ type: 'INNER_SHADOW', visible: true }])).toBeNull();
    expect(shadowFromEffects([{ type: 'LAYER_BLUR', visible: true }])).toBeNull();
    expect(shadowFromEffects([{ type: 'DROP_SHADOW', visible: false }])).toBeNull();
  });

  it('maps a single DROP_SHADOW to Konva props (memarich-style spec example)', () => {
    const out = shadowFromEffects([
      {
        type: 'DROP_SHADOW',
        visible: true,
        offset: { x: 0, y: 4 },
        radius: 4,
        spread: 0,
        color: { r: 0.898, g: 0.941, b: 1, a: 1 },
        blendMode: 'NORMAL',
      },
    ]);
    expect(out).not.toBeNull();
    expect(out!.shadowOffsetX).toBe(0);
    expect(out!.shadowOffsetY).toBe(4);
    expect(out!.shadowBlur).toBe(4);
    // r/g/b multiplied by 255 and rounded.
    expect(out!.shadowColor).toBe('rgb(229, 240, 255)');
    expect(out!.shadowOpacity).toBe(1);
  });

  it('uses the FIRST visible DROP_SHADOW when several are listed', () => {
    const out = shadowFromEffects([
      { type: 'DROP_SHADOW', visible: false, offset: { x: 99, y: 99 }, radius: 99, color: { r: 1, g: 0, b: 0, a: 1 } },
      { type: 'DROP_SHADOW', visible: true, offset: { x: 1, y: 1 }, radius: 2, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      { type: 'DROP_SHADOW', visible: true, offset: { x: 50, y: 50 }, radius: 50, color: { r: 0, g: 1, b: 0, a: 1 } },
    ]);
    expect(out!.shadowOffsetX).toBe(1);
    expect(out!.shadowOffsetY).toBe(1);
    expect(out!.shadowBlur).toBe(2);
    expect(out!.shadowOpacity).toBe(0.5);
  });

  it('skips DROP_SHADOW with non-NORMAL blendMode (spec I-DS4)', () => {
    expect(
      shadowFromEffects([
        {
          type: 'DROP_SHADOW',
          visible: true,
          offset: { x: 1, y: 1 },
          radius: 2,
          color: { r: 0, g: 0, b: 0, a: 1 },
          blendMode: 'MULTIPLY',
        },
      ]),
    ).toBeNull();
  });

  it('treats undefined offset / radius / alpha as 0 / 0 / 1', () => {
    const out = shadowFromEffects([
      { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0 } },
    ]);
    expect(out).toEqual({
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      shadowBlur: 0,
      shadowColor: 'rgb(0, 0, 0)',
      shadowOpacity: 1,
    });
  });

  it('skips non-DROP_SHADOW entries on its way to a later DROP_SHADOW', () => {
    const out = shadowFromEffects([
      { type: 'INNER_SHADOW', visible: true },
      { type: 'LAYER_BLUR', visible: true, radius: 8 },
      {
        type: 'DROP_SHADOW',
        visible: true,
        offset: { x: 2, y: 2 },
        radius: 4,
        color: { r: 1, g: 1, b: 1, a: 0.25 },
      },
    ]);
    expect(out!.shadowOffsetX).toBe(2);
    expect(out!.shadowOpacity).toBe(0.25);
  });
});

describe('innerShadowFromEffects', () => {
  it('returns null when no INNER_SHADOW is present', () => {
    expect(innerShadowFromEffects(undefined)).toBeNull();
    expect(innerShadowFromEffects([])).toBeNull();
    expect(innerShadowFromEffects([{ type: 'DROP_SHADOW', visible: true }])).toBeNull();
  });

  it('maps the first visible INNER_SHADOW to canvas-ready shadow params', () => {
    const out = innerShadowFromEffects([
      {
        type: 'INNER_SHADOW',
        visible: true,
        offset: { x: 2, y: 3 },
        radius: 4,
        color: { r: 0, g: 0, b: 0, a: 0.5 },
        blendMode: 'NORMAL',
      },
    ]);
    expect(out).toEqual({
      offsetX: 2,
      offsetY: 3,
      blur: 4,
      // Inner shadow uses the raw rgba string — alpha baked in (no
      // shadowOpacity slot in the canvas API path).
      color: 'rgba(0,0,0,0.500)',
    });
  });

  it('skips INNER_SHADOW with non-NORMAL blendMode', () => {
    expect(
      innerShadowFromEffects([
        {
          type: 'INNER_SHADOW',
          visible: true,
          offset: { x: 1, y: 1 },
          radius: 2,
          color: { r: 1, g: 0, b: 0, a: 1 },
          blendMode: 'MULTIPLY',
        },
      ]),
    ).toBeNull();
  });

  it('skips hidden INNER_SHADOWs and walks past DROP_SHADOWs to find one', () => {
    const out = innerShadowFromEffects([
      { type: 'DROP_SHADOW', visible: true, offset: { x: 99, y: 99 }, radius: 99 },
      { type: 'INNER_SHADOW', visible: false, offset: { x: 1, y: 1 }, radius: 1 },
      { type: 'INNER_SHADOW', visible: true, offset: { x: 5, y: 5 }, radius: 5, color: { r: 1, g: 1, b: 1, a: 1 } },
    ]);
    expect(out!.offsetX).toBe(5);
  });
});
