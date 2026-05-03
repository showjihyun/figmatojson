import { describe, expect, it } from 'vitest';
import { computeImageCrop } from './imageScale';

describe('computeImageCrop', () => {
  it('falls back to STRETCH-equivalent when image dims are missing', () => {
    expect(computeImageCrop('FILL', 0, 0, 100, 50)).toEqual({
      dstX: 0, dstY: 0, dstW: 100, dstH: 50, tile: false,
    });
  });

  it('falls back to STRETCH-equivalent when box dims are 0', () => {
    expect(computeImageCrop('FILL', 200, 100, 0, 0)).toEqual({
      dstX: 0, dstY: 0, dstW: 0, dstH: 0, tile: false,
    });
  });

  it('STRETCH (default) returns full box dst with no crop', () => {
    expect(computeImageCrop('STRETCH', 200, 100, 50, 50)).toEqual({
      dstX: 0, dstY: 0, dstW: 50, dstH: 50, tile: false,
    });
    expect(computeImageCrop(undefined, 200, 100, 50, 50)).toEqual({
      dstX: 0, dstY: 0, dstW: 50, dstH: 50, tile: false,
    });
  });

  it('TILE returns the tile marker for caller-side fallback', () => {
    const out = computeImageCrop('TILE', 100, 100, 200, 200);
    expect(out.tile).toBe(true);
  });

  describe('FILL (object-fit: cover)', () => {
    it('image wider than box → crops sides, fills full box', () => {
      // 400×100 image into 100×100 box → keep full height, crop width.
      const out = computeImageCrop('FILL', 400, 100, 100, 100);
      // imgAspect 4 > boxAspect 1 → crop sides.
      // cropW = imgH * boxAspect = 100 * 1 = 100. cropX = (400 - 100)/2 = 150.
      expect(out.crop).toEqual({ x: 150, y: 0, width: 100, height: 100 });
      expect(out.dstX).toBe(0);
      expect(out.dstY).toBe(0);
      expect(out.dstW).toBe(100);
      expect(out.dstH).toBe(100);
    });

    it('image taller than box → crops top/bottom', () => {
      // 100×400 image into 100×100 box.
      const out = computeImageCrop('FILL', 100, 400, 100, 100);
      // imgAspect 0.25 < boxAspect 1 → crop top/bottom.
      // cropH = imgW / boxAspect = 100 / 1 = 100. cropY = (400 - 100)/2 = 150.
      expect(out.crop).toEqual({ x: 0, y: 150, width: 100, height: 100 });
    });

    it('image and box have matching aspect → crop is full image', () => {
      const out = computeImageCrop('FILL', 200, 100, 80, 40);
      // Both 2:1 — cropping should match the image since they're proportional.
      expect(out.crop?.width).toBeCloseTo(200);
      expect(out.crop?.height).toBeCloseTo(100);
    });
  });

  describe('FIT (object-fit: contain)', () => {
    it('image wider than box → height shrinks, vertical letterbox', () => {
      const out = computeImageCrop('FIT', 400, 100, 100, 100);
      // crop = full image. dstH = boxW / imgAspect = 100 / 4 = 25. dstY = (100 - 25)/2 = 37.5.
      expect(out.crop).toEqual({ x: 0, y: 0, width: 400, height: 100 });
      expect(out.dstW).toBe(100);
      expect(out.dstH).toBe(25);
      expect(out.dstX).toBe(0);
      expect(out.dstY).toBe(37.5);
    });

    it('image taller than box → width shrinks, horizontal letterbox', () => {
      const out = computeImageCrop('FIT', 100, 400, 100, 100);
      // dstW = boxH * imgAspect = 100 * 0.25 = 25. dstX = (100 - 25)/2 = 37.5.
      expect(out.dstW).toBe(25);
      expect(out.dstH).toBe(100);
      expect(out.dstX).toBe(37.5);
      expect(out.dstY).toBe(0);
    });
  });

  describe('CROP (1:1 scale, centered)', () => {
    it('image larger than box → centered crop, dst = crop dims', () => {
      const out = computeImageCrop('CROP', 200, 200, 80, 80);
      // crop is centered 80×80 area of the image.
      expect(out.crop).toEqual({ x: 60, y: 60, width: 80, height: 80 });
      // dst is centered in box (no letterbox since image bigger).
      expect(out.dstX).toBe(0);
      expect(out.dstY).toBe(0);
      expect(out.dstW).toBe(80);
      expect(out.dstH).toBe(80);
    });

    it('image smaller than box → letterbox dst, crop = full image', () => {
      const out = computeImageCrop('CROP', 50, 50, 100, 100);
      expect(out.crop).toEqual({ x: 0, y: 0, width: 50, height: 50 });
      expect(out.dstX).toBe(25);
      expect(out.dstY).toBe(25);
      expect(out.dstW).toBe(50);
      expect(out.dstH).toBe(50);
    });
  });
});
