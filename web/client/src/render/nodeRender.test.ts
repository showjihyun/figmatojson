import { describe, expect, it } from 'vitest';
import { nodeRender, type RenderContext } from './nodeRender.js';

const noopMeasure: RenderContext['measureText'] = () => 0;

function emptyCtx(): RenderContext {
  return { isolation: null, measureText: noopMeasure };
}

describe('nodeRender', () => {
  describe('hidden', () => {
    it('returns visible-false when node.visible is explicitly false', () => {
      const plan = nodeRender({ id: '1:1', visible: false, type: 'VECTOR' }, emptyCtx());
      expect(plan).toEqual({ kind: 'hidden', reason: 'visible-false' });
    });

    it('returns isolation-hide when ctx.isolation.hide contains this id', () => {
      const ctx: RenderContext = {
        isolation: { hide: new Set(['1:2']), ancestors: new Set() },
        measureText: noopMeasure,
      };
      const plan = nodeRender({ id: '1:2', type: 'VECTOR' }, ctx);
      expect(plan).toEqual({ kind: 'hidden', reason: 'isolation-hide' });
    });

    it('hide takes precedence over visible-false (order is incidental, both yield hidden)', () => {
      const ctx: RenderContext = {
        isolation: { hide: new Set(['1:3']), ancestors: new Set() },
        measureText: noopMeasure,
      };
      const plan = nodeRender({ id: '1:3', visible: false, type: 'VECTOR' }, ctx);
      expect(plan.kind).toBe('hidden');
    });
  });

  describe('vector', () => {
    const baseVector = {
      id: '1:10',
      type: 'VECTOR',
      _path: 'M0 0 L10 10',
      transform: { m02: 30, m12: 50 },
      size: { x: 100, y: 80 },
    };

    it('emits a vector plan for VECTOR_TYPES with a non-empty _path', () => {
      const plan = nodeRender(baseVector, emptyCtx());
      expect(plan.kind).toBe('vector');
    });

    it('falls through when _path is missing or empty', () => {
      const noPath = nodeRender({ ...baseVector, _path: '' }, emptyCtx());
      expect(noPath.kind).toBe('fallthrough');
      const undef = nodeRender({ ...baseVector, _path: undefined }, emptyCtx());
      expect(undef.kind).toBe('fallthrough');
    });

    it('falls through for non-vector types', () => {
      const plan = nodeRender({ ...baseVector, type: 'FRAME' }, emptyCtx());
      expect(plan.kind).toBe('fallthrough');
    });

    it('reads outer bbox from transform.m02/m12 + size', () => {
      const plan = nodeRender(baseVector, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.outer.bbox).toEqual({ x: 30, y: 50, w: 100, h: 80 });
    });

    it('defaults pathOffset/pathScale to {0,0} / {1,1}', () => {
      const plan = nodeRender(baseVector, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.pathOffset).toEqual({ x: 0, y: 0 });
      expect(plan.pathScale).toEqual({ x: 1, y: 1 });
    });

    it('reads pathOffset/pathScale when present', () => {
      const plan = nodeRender({
        ...baseVector,
        _pathOffset: { x: 5, y: -3 },
        _pathScale: { x: 2, y: 0.5 },
      }, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.pathOffset).toEqual({ x: 5, y: -3 });
      expect(plan.pathScale).toEqual({ x: 2, y: 0.5 });
    });

    it('resolves SOLID fillPaints to rgba and leaves stroke null when none', () => {
      const plan = nodeRender({
        ...baseVector,
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
      }, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.fill).toBe('rgba(255,0,0,1.000)');
      expect(plan.stroke).toBeNull();
    });

    it('returns fill="transparent" when there are no fillPaints', () => {
      const plan = nodeRender(baseVector, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.fill).toBe('transparent');
    });

    it('INSIDE strokeAlign with a visible fill doubles strokeWidth and sets fillAfterStrokeEnabled', () => {
      const plan = nodeRender({
        ...baseVector,
        fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        strokeWeight: 2,
        strokePaints: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }],
        strokeAlign: 'INSIDE',
      }, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.stroke).toEqual({
        color: 'rgba(0,255,0,1.000)',
        width: 4,
        fillAfterStrokeEnabled: true,
      });
    });

    it('INSIDE strokeAlign with NO fill skips emulation (would just look thicker)', () => {
      const plan = nodeRender({
        ...baseVector,
        // no fillPaints → fill === 'transparent'
        strokeWeight: 2,
        strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        strokeAlign: 'INSIDE',
      }, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.stroke).toEqual({
        color: 'rgba(0,0,0,1.000)',
        width: 2,
        fillAfterStrokeEnabled: false,
      });
    });

    it('CENTER strokeAlign passes strokeWidth through unchanged', () => {
      const plan = nodeRender({
        ...baseVector,
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
        strokeWeight: 3,
        strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        strokeAlign: 'CENTER',
      }, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.stroke?.width).toBe(3);
      expect(plan.stroke?.fillAfterStrokeEnabled).toBe(false);
    });

    it('passes through dashPattern when non-empty, undefined otherwise', () => {
      const dashed = nodeRender({
        ...baseVector,
        dashPattern: [4, 2],
      }, emptyCtx());
      if (dashed.kind !== 'vector') throw new Error('expected vector');
      expect(dashed.dashPattern).toEqual([4, 2]);

      const empty = nodeRender({ ...baseVector, dashPattern: [] }, emptyCtx());
      if (empty.kind !== 'vector') throw new Error('expected vector');
      expect(empty.dashPattern).toBeUndefined();
    });

    it('resolves shadowFromEffects for vector nodes', () => {
      const plan = nodeRender({
        ...baseVector,
        effects: [{
          type: 'DROP_SHADOW',
          offset: { x: 1, y: 2 },
          radius: 3,
          color: { r: 0, g: 0, b: 0, a: 0.5 },
        }],
      }, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.shadow).not.toBeNull();
      expect(plan.shadow?.shadowOffsetX).toBe(1);
      expect(plan.shadow?.shadowOffsetY).toBe(2);
      expect(plan.shadow?.shadowBlur).toBe(3);
      expect(plan.shadow?.shadowOpacity).toBe(0.5);
    });
  });

  describe('fallthrough', () => {
    it('returns fallthrough for FRAME / RECTANGLE / TEXT (slice 1A scope)', () => {
      for (const type of ['FRAME', 'RECTANGLE', 'TEXT', 'INSTANCE', 'SYMBOL']) {
        const plan = nodeRender(
          { id: 'x', type, transform: { m02: 0, m12: 0 }, size: { x: 1, y: 1 } },
          emptyCtx(),
        );
        expect(plan.kind).toBe('fallthrough');
      }
    });
  });
});
