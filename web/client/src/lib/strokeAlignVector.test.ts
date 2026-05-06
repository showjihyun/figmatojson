import { describe, expect, it } from 'vitest';
import { applyStrokeAlignToVectorPath } from './strokeAlign.js';

/**
 * Spec: docs/specs/web-render-fidelity-round13.spec.md
 *
 * Konva.Path lacks a native stroke-alignment, so we emulate via two
 * orthogonal plumbings:
 *   INSIDE  → Group `clipFunc(path)` wrap + strokeWidth*2
 *             (clip cuts off outer half, only inner half visible)
 *   OUTSIDE → `fillAfterStrokeEnabled=true` + strokeWidth*2
 *             (fill paints over inner half, only outer half visible)
 *   CENTER / undefined → pass-through (Konva default)
 *
 * Either emulation requires a visible fill — without one, INSIDE/OUTSIDE
 * are visually identical to CENTER and we skip the doubling.
 */

describe('applyStrokeAlignToVectorPath (round 13)', () => {
  it('INSIDE + visible fill: strokeWidth*2 + clipToPath, no fillAfterStroke', () => {
    expect(applyStrokeAlignToVectorPath(5, 'INSIDE', true)).toEqual({
      strokeWidth: 10,
      fillAfterStrokeEnabled: false,
      clipToPath: true,
    });
  });

  it('OUTSIDE + visible fill: strokeWidth*2 + fillAfterStroke, no clip', () => {
    expect(applyStrokeAlignToVectorPath(5, 'OUTSIDE', true)).toEqual({
      strokeWidth: 10,
      fillAfterStrokeEnabled: true,
      clipToPath: false,
    });
  });

  it('INSIDE + no visible fill: passes through (no doubling, no clip)', () => {
    // 700:319 is a stroke-only icon — no SOLID visible fill. INSIDE
    // emulation must not double its stroke; without fill there's nothing
    // to clip against either, so pass-through CENTER is identical.
    expect(applyStrokeAlignToVectorPath(2, 'INSIDE', false)).toEqual({
      strokeWidth: 2,
      fillAfterStrokeEnabled: false,
      clipToPath: false,
    });
  });

  it('OUTSIDE + no visible fill: passes through', () => {
    expect(applyStrokeAlignToVectorPath(2, 'OUTSIDE', false)).toEqual({
      strokeWidth: 2,
      fillAfterStrokeEnabled: false,
      clipToPath: false,
    });
  });

  it('CENTER: pass-through (Konva default)', () => {
    expect(applyStrokeAlignToVectorPath(3, 'CENTER', true)).toEqual({
      strokeWidth: 3,
      fillAfterStrokeEnabled: false,
      clipToPath: false,
    });
  });

  it('undefined strokeAlign: pass-through', () => {
    expect(applyStrokeAlignToVectorPath(3, undefined, true)).toEqual({
      strokeWidth: 3,
      fillAfterStrokeEnabled: false,
      clipToPath: false,
    });
  });

  it('strokeWeight 0: pass-through with 0', () => {
    expect(applyStrokeAlignToVectorPath(0, 'INSIDE', true)).toEqual({
      strokeWidth: 0,
      fillAfterStrokeEnabled: false,
      clipToPath: false,
    });
  });

  it('strokeWeight undefined: pass-through with 0 (caller decides whether to render stroke)', () => {
    expect(applyStrokeAlignToVectorPath(undefined, 'INSIDE', true)).toEqual({
      strokeWidth: 0,
      fillAfterStrokeEnabled: false,
      clipToPath: false,
    });
  });

  // Real HPAI 2625:1343 reproduction
  it('HPAI 2625:1343 (size=80, strokeWeight=5, INSIDE, white fill, red stroke)', () => {
    const out = applyStrokeAlignToVectorPath(5, 'INSIDE', true);
    expect(out).toEqual({
      strokeWidth: 10,
      fillAfterStrokeEnabled: false,
      clipToPath: true,
    });
  });
});
