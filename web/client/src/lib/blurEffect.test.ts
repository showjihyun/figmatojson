import { describe, expect, it } from 'vitest';
import { layerBlurFromEffects } from './blurEffect';

describe('layerBlurFromEffects', () => {
  it('returns null for missing / empty effects', () => {
    expect(layerBlurFromEffects(undefined)).toBeNull();
    expect(layerBlurFromEffects([])).toBeNull();
  });

  it('returns null when no LAYER_BLUR is present', () => {
    expect(
      layerBlurFromEffects([
        { type: 'DROP_SHADOW', visible: true, radius: 4 },
        { type: 'INNER_SHADOW', visible: true, radius: 2 },
        { type: 'BACKGROUND_BLUR', visible: true, radius: 8 },
      ]),
    ).toBeNull();
  });

  it('returns radius for the first visible LAYER_BLUR', () => {
    expect(
      layerBlurFromEffects([{ type: 'LAYER_BLUR', visible: true, radius: 6 }]),
    ).toEqual({ radius: 6 });
  });

  it('skips invisible LAYER_BLURs', () => {
    expect(
      layerBlurFromEffects([
        { type: 'LAYER_BLUR', visible: false, radius: 8 },
        { type: 'LAYER_BLUR', visible: true, radius: 3 },
      ]),
    ).toEqual({ radius: 3 });
  });

  it('skips zero or negative radii (no-op blur)', () => {
    expect(
      layerBlurFromEffects([{ type: 'LAYER_BLUR', visible: true, radius: 0 }]),
    ).toBeNull();
    expect(
      layerBlurFromEffects([{ type: 'LAYER_BLUR', visible: true, radius: -2 }]),
    ).toBeNull();
  });

  it('skips non-NORMAL blendMode (Konva.Filters.Blur cannot composite)', () => {
    expect(
      layerBlurFromEffects([
        { type: 'LAYER_BLUR', visible: true, radius: 4, blendMode: 'MULTIPLY' },
      ]),
    ).toBeNull();
  });

  it('accepts NORMAL or undefined blendMode', () => {
    expect(
      layerBlurFromEffects([
        { type: 'LAYER_BLUR', visible: true, radius: 5, blendMode: 'NORMAL' },
      ]),
    ).toEqual({ radius: 5 });
    expect(
      layerBlurFromEffects([{ type: 'LAYER_BLUR', visible: true, radius: 7 }]),
    ).toEqual({ radius: 7 });
  });

  it('takes the FIRST eligible LAYER_BLUR (multi-blur not yet supported)', () => {
    expect(
      layerBlurFromEffects([
        { type: 'LAYER_BLUR', visible: true, radius: 2 },
        { type: 'LAYER_BLUR', visible: true, radius: 9 },
      ]),
    ).toEqual({ radius: 2 });
  });
});
