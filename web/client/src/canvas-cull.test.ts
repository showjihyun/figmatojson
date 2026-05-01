import { describe, expect, it } from 'vitest';

import { makeLargeCanvas } from './__fixtures__/largePage';
import {
  cullChildrenByViewport,
  rectsIntersect,
  viewportInStageCoords,
} from './canvas-cull';

describe('rectsIntersect', () => {
  it('overlapping rects intersect', () => {
    expect(rectsIntersect(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
    )).toBe(true);
  });
  it('touching rects do not intersect (open-interval semantics)', () => {
    // Edge-touch is treated as non-intersect so a node parked exactly at
    // the viewport boundary (zero-area overlap) gets culled, matching the
    // "if you can't see it, don't render it" mindset.
    expect(rectsIntersect(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 100, y: 0, w: 100, h: 100 },
    )).toBe(false);
  });
  it('disjoint rects do not intersect', () => {
    expect(rectsIntersect(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 200, y: 200, w: 100, h: 100 },
    )).toBe(false);
  });
  it('zero-area rects never intersect anything', () => {
    expect(rectsIntersect(
      { x: 0, y: 0, w: 0, h: 100 },
      { x: 0, y: 0, w: 100, h: 100 },
    )).toBe(false);
  });
});

describe('viewportInStageCoords', () => {
  it('identity transform: stage rect equals container rect (minus pad)', () => {
    const r = viewportInStageCoords(
      { width: 1000, height: 800 },
      { x: 0, y: 0 },
      1,
      0,
    );
    expect(r).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
  });
  it('panned: viewport origin shifts by -offset/scale', () => {
    const r = viewportInStageCoords(
      { width: 1000, height: 800 },
      { x: -200, y: -100 },
      1,
      0,
    );
    expect(r).toEqual({ x: 200, y: 100, w: 1000, h: 800 });
  });
  it('zoomed-out (scale 0.25): stage-space viewport is 4× container', () => {
    const r = viewportInStageCoords(
      { width: 1000, height: 800 },
      { x: 0, y: 0 },
      0.25,
      0,
    );
    expect(r).toEqual({ x: 0, y: 0, w: 4000, h: 3200 });
  });
  it('pad expands the rect outward in stage coords', () => {
    const r = viewportInStageCoords(
      { width: 1000, height: 800 },
      { x: 0, y: 0 },
      1,
      50,
    );
    expect(r).toEqual({ x: -50, y: -50, w: 1100, h: 900 });
  });
});

describe('cullChildrenByViewport on a 35K-node fixture', () => {
  // 100 frames × 350 children = 35 000 nodes (frames are top-level only;
  // children are inside their frames, not direct CANVAS children).
  // makeLargeCanvas lays out 100 frames in a 10×10 grid at 460 px stride.
  const page = makeLargeCanvas({ frames: 100, childrenPerFrame: 350 });
  const topLevel = page.children!;

  it('fixture exposes 100 top-level frames', () => {
    expect(topLevel).toHaveLength(100);
    expect(topLevel[0].type).toBe('FRAME');
    expect(topLevel[0].children).toHaveLength(350);
  });

  it('a tight viewport on the first frame keeps that frame and a couple of neighbours', () => {
    // Frame 0 occupies [0..400, 0..400]. Viewport hugging it should keep
    // frame 0 plus any neighbours within `pad`.
    const viewport = { x: 0, y: 0, w: 400, h: 400 };
    const visible = cullChildrenByViewport(topLevel, viewport);
    // At minimum frame 0 stays.
    expect(visible).toContain(topLevel[0]);
    // The 100-frame grid puts no other frame fully within [0..400]; the
    // strict-intersect check (open intervals) keeps just the first one.
    expect(visible).toHaveLength(1);
  });

  it('a viewport entirely off-page culls everything', () => {
    const viewport = { x: 100000, y: 100000, w: 1000, h: 1000 };
    expect(cullChildrenByViewport(topLevel, viewport)).toHaveLength(0);
  });

  it('a viewport covering the whole page keeps every frame', () => {
    const viewport = { x: -1000, y: -1000, w: 100000, h: 100000 };
    expect(cullChildrenByViewport(topLevel, viewport)).toHaveLength(100);
  });

  it('zoomed-out: a 1000×800 container at scale 0.25 covers a 4000×3200 stage rect — keeps ~70 frames', () => {
    // Real perf scenario: user opens a doc, sees a 0.25-zoom overview.
    // Container 1000×800 → stage rect 4000×3200. With 460 px stride and
    // 100 frames in a 10×10 grid (4140 px wide), that should keep ~70.
    const viewport = viewportInStageCoords(
      { width: 1000, height: 800 },
      { x: 0, y: 0 },
      0.25,
      0,
    );
    const visible = cullChildrenByViewport(topLevel, viewport);
    expect(visible.length).toBeGreaterThan(50);
    expect(visible.length).toBeLessThan(100);
  });

  it('zoomed-in scenario (scale 1, pan to bottom-right corner): keeps a 2-3 frame tile', () => {
    // After panning ~2000px right+down at 1:1, only frames near the
    // bottom-right of the visible region remain — a small handful.
    const viewport = viewportInStageCoords(
      { width: 1000, height: 800 },
      { x: -2000, y: -2000 },
      1,
      0,
    );
    const visible = cullChildrenByViewport(topLevel, viewport);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(15);
  });
});
