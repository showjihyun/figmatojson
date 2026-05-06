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

    it('a VECTOR type without _path falls through to paint-stack catch-all', () => {
      // Without a precomputed _path the vector path can't render; the
      // node's bbox + fills still describe a rectangular surface, so
      // paint-stack is the correct fallback.
      const noPath = nodeRender({ ...baseVector, _path: '' }, emptyCtx());
      expect(noPath.kind).toBe('paint-stack');
      const undef = nodeRender({ ...baseVector, _path: undefined }, emptyCtx());
      expect(undef.kind).toBe('paint-stack');
    });

    it('non-VECTOR type with the same data falls into paint-stack', () => {
      const plan = nodeRender({ ...baseVector, type: 'FRAME' }, emptyCtx());
      expect(plan.kind).toBe('paint-stack');
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

    it('INSIDE strokeAlign with a visible fill doubles strokeWidth and sets clipToPath', () => {
      // round 13 §2: INSIDE emulation = clip + width*2 (Canvas wraps the
      // Path in a clipFunc Group so the doubled stroke's outer half is cut off).
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
        fillAfterStrokeEnabled: false,
      });
      expect(plan.clipToPath).toBe(true);
    });

    it('OUTSIDE strokeAlign with a visible fill doubles strokeWidth and sets fillAfterStrokeEnabled', () => {
      // round 13 §2: OUTSIDE emulation = fill-after-stroke + width*2.
      const plan = nodeRender({
        ...baseVector,
        fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        strokeWeight: 2,
        strokePaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
        strokeAlign: 'OUTSIDE',
      }, emptyCtx());
      if (plan.kind !== 'vector') throw new Error('expected vector');
      expect(plan.stroke).toEqual({
        color: 'rgba(255,0,0,1.000)',
        width: 4,
        fillAfterStrokeEnabled: true,
      });
      expect(plan.clipToPath).toBe(false);
    });

    it('INSIDE strokeAlign with NO fill skips emulation (would be visually identical to CENTER)', () => {
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
      expect(plan.clipToPath).toBe(false);
    });

    it('CENTER strokeAlign passes strokeWidth through unchanged with no clip/fillAfter', () => {
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
      expect(plan.clipToPath).toBe(false);
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

  describe('text-simple', () => {
    const baseText = {
      id: '1:20',
      type: 'TEXT',
      transform: { m02: 10, m12: 20 },
      size: { x: 200, y: 30 },
      textData: { characters: 'hello' },
    };

    it('emits a text-simple plan with chars from textData.characters', () => {
      const plan = nodeRender(baseText, emptyCtx());
      if (plan.kind !== 'text-simple') throw new Error(`expected text-simple, got ${plan.kind}`);
      expect(plan.text).toBe('hello');
      expect(plan.fontSize).toBe(12);          // default
      expect(plan.fontFamily).toBe('Inter');   // default
      expect(plan.fill).toBe('#ddd');          // default fallback (no fillPaints)
    });

    it('uses _renderTextOverride when set, ignoring textData.characters', () => {
      const plan = nodeRender(
        { ...baseText, _renderTextOverride: 'OVERRIDDEN' },
        emptyCtx(),
      );
      if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
      expect(plan.text).toBe('OVERRIDDEN');
    });

    it('applies textCase=UPPER after the override resolution', () => {
      const plan = nodeRender(
        { ...baseText, textCase: 'UPPER', _renderTextOverride: 'mixedCase' },
        emptyCtx(),
      );
      if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
      expect(plan.text).toBe('MIXEDCASE');
    });

    it('resolves SOLID fillPaints to rgba()', () => {
      const plan = nodeRender(
        {
          ...baseText,
          fillPaints: [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.6, a: 0.8 } }],
        },
        emptyCtx(),
      );
      if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
      expect(plan.fill).toBe('rgba(51,102,153,0.8)');
    });

    it('passes typography fields through their helpers', () => {
      const plan = nodeRender(
        {
          ...baseText,
          fontSize: 16,
          fontName: { family: 'Roboto', style: 'Bold Italic' },
          letterSpacing: { value: 5, units: 'PIXELS' },
          lineHeight: { value: 24, units: 'PIXELS' },
          textAlignVertical: 'CENTER',
          textAlignHorizontal: 'RIGHT',
          textDecoration: 'UNDERLINE',
        },
        emptyCtx(),
      );
      if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
      expect(plan.fontSize).toBe(16);
      expect(plan.fontFamily).toBe('Roboto');
      expect(plan.fontStyle).toBe('italic bold');
      expect(plan.letterSpacing).toBe(5);
      expect(plan.lineHeight).toBeCloseTo(24 / 16);
      expect(plan.verticalAlign).toBe('middle');
      expect(plan.align).toBe('right');
      expect(plan.textDecoration).toBe('underline');
    });

    describe('auto-resize math', () => {
      it('isFixedWidthMode (NONE) passes size.x as drawWidth', () => {
        const plan = nodeRender(
          { ...baseText, textAutoResize: 'NONE' },
          emptyCtx(),
        );
        if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
        expect(plan.drawX).toBe(10);
        expect(plan.drawWidth).toBe(200);
      });

      it('isFixedWidthMode (TRUNCATE) passes size.x as drawWidth', () => {
        const plan = nodeRender(
          { ...baseText, textAutoResize: 'TRUNCATE' },
          emptyCtx(),
        );
        if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
        expect(plan.drawWidth).toBe(200);
      });

      it('left-aligned non-fixed mode omits drawWidth (Konva default)', () => {
        const plan = nodeRender(
          { ...baseText, textAlignHorizontal: 'LEFT' },
          emptyCtx(),
        );
        if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
        expect(plan.drawX).toBe(10);
        expect(plan.drawWidth).toBeUndefined();
      });

      it('center-aligned overflow shifts drawX symmetrically and uses natural width', () => {
        const ctx: RenderContext = {
          isolation: null,
          measureText: () => 300, // natural > baseW (200)
        };
        const plan = nodeRender(
          { ...baseText, textAlignHorizontal: 'CENTER' },
          ctx,
        );
        if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
        // overflow = 300 - 200 = 100; drawX shifts left by 50.
        expect(plan.drawX).toBe(10 - 50);
        expect(plan.drawWidth).toBe(300);
      });

      it('right-aligned overflow shifts drawX leftward by full overflow', () => {
        const ctx: RenderContext = {
          isolation: null,
          measureText: () => 280, // overflow = 80
        };
        const plan = nodeRender(
          { ...baseText, textAlignHorizontal: 'RIGHT' },
          ctx,
        );
        if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
        expect(plan.drawX).toBe(10 - 80);
        expect(plan.drawWidth).toBe(280);
      });

      it('center-aligned NO overflow keeps drawX at outer.bbox.x and uses baseW', () => {
        const ctx: RenderContext = {
          isolation: null,
          measureText: () => 100, // natural <= baseW
        };
        const plan = nodeRender(
          { ...baseText, textAlignHorizontal: 'CENTER' },
          ctx,
        );
        if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
        expect(plan.drawX).toBe(10);
        expect(plan.drawWidth).toBe(200);
      });

      it('center-aligned with baseW=0 (zero-width master) skips overflow math', () => {
        const ctx: RenderContext = {
          isolation: null,
          measureText: () => 100, // 100 > 0 but baseW=0 short-circuits
        };
        const plan = nodeRender(
          {
            ...baseText,
            size: { x: 0, y: 30 },
            textAlignHorizontal: 'CENTER',
          },
          ctx,
        );
        if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
        expect(plan.drawX).toBe(10);
        expect(plan.drawWidth).toBeUndefined();
      });

      it('passes the right typography args to measureText for center/right overflow detection', () => {
        const calls: Array<unknown[]> = [];
        const ctx: RenderContext = {
          isolation: null,
          measureText: (...args) => {
            calls.push(args);
            return 250;
          },
        };
        nodeRender(
          {
            ...baseText,
            fontSize: 14,
            fontName: { family: 'Roboto', style: 'Italic' },
            letterSpacing: { value: 2, units: 'PIXELS' },
            textAlignHorizontal: 'CENTER',
            _renderTextOverride: 'CHECK',
          },
          ctx,
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual(['CHECK', 14, 'Roboto', 'italic', 2]);
      });
    });

    it('resolves shadowFromEffects', () => {
      const plan = nodeRender(
        {
          ...baseText,
          effects: [{
            type: 'DROP_SHADOW',
            offset: { x: 2, y: 3 },
            radius: 4,
            color: { r: 0, g: 0, b: 0, a: 1 },
          }],
        },
        emptyCtx(),
      );
      if (plan.kind !== 'text-simple') throw new Error('expected text-simple');
      expect(plan.shadow?.shadowOffsetX).toBe(2);
      expect(plan.shadow?.shadowOffsetY).toBe(3);
    });
  });

  describe('text-styled fallthrough', () => {
    it('returns fallthrough with reason=text-styled when characterStyleIDs + styleOverrideTable mark a styled run', () => {
      const plan = nodeRender(
        {
          id: '1:30',
          type: 'TEXT',
          transform: { m02: 0, m12: 0 },
          size: { x: 100, y: 20 },
          textData: {
            characters: 'AB',
            characterStyleIDs: [0, 1],
            styleOverrideTable: [
              { styleID: 1, fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] },
            ],
          },
        },
        emptyCtx(),
      );
      expect(plan).toEqual({ kind: 'fallthrough', reason: 'text-styled' });
    });

    it('renders simple when _renderTextOverride is set, even with style data (override+runs not v1)', () => {
      // Spec web-canvas-text-style-runs.spec.md §3.2 — override + runs is v1
      // 비대상; falls back to single KText with base style.
      const plan = nodeRender(
        {
          id: '1:31',
          type: 'TEXT',
          transform: { m02: 0, m12: 0 },
          size: { x: 100, y: 20 },
          _renderTextOverride: 'OVERRIDE',
          textData: {
            characters: 'AB',
            characterStyleIDs: [0, 1],
            styleOverrideTable: [
              { styleID: 1, fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] },
            ],
          },
        },
        emptyCtx(),
      );
      expect(plan.kind).toBe('text-simple');
    });

    it('renders simple when style table has only the base styleID (no styled runs)', () => {
      const plan = nodeRender(
        {
          id: '1:32',
          type: 'TEXT',
          transform: { m02: 0, m12: 0 },
          size: { x: 100, y: 20 },
          textData: {
            characters: 'AB',
            characterStyleIDs: [0, 0],
            styleOverrideTable: [],
          },
        },
        emptyCtx(),
      );
      expect(plan.kind).toBe('text-simple');
    });
  });

  describe('paint-stack', () => {
    const baseFrame = {
      id: '1:50',
      type: 'FRAME',
      transform: { m02: 5, m12: 7 },
      size: { x: 100, y: 60 },
    };

    it('emits a paint-stack plan for FRAME / RECTANGLE / INSTANCE / SYMBOL', () => {
      for (const type of ['FRAME', 'RECTANGLE', 'INSTANCE', 'SYMBOL', 'SECTION']) {
        const plan = nodeRender({ ...baseFrame, type }, emptyCtx());
        expect(plan.kind).toBe('paint-stack');
      }
    });

    it('reads outer bbox + cornerRadius from node fields', () => {
      const plan = nodeRender({ ...baseFrame, cornerRadius: 8 }, emptyCtx());
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.outer.bbox).toEqual({ x: 5, y: 7, w: 100, h: 60 });
      expect(plan.cornerRadius).toBe(8);
      expect(plan.corners).toEqual({ tl: 8, tr: 8, br: 8, bl: 8 });
    });

    it('per-corner radii produce a 4-tuple cornerRadius and matching capped corners', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          cornerRadius: 0,
          rectangleTopLeftCornerRadius: 10,
          rectangleTopRightCornerRadius: 0,
          rectangleBottomRightCornerRadius: 80,        // > h/2 = 30 → capped
          rectangleBottomLeftCornerRadius: 4,
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.cornerRadius).toEqual([10, 0, 80, 4]);
      expect(plan.corners).toEqual({ tl: 10, tr: 0, br: 30, bl: 4 });
    });

    it('empty fillPaints + no shadow/stroke ⇒ no anchor rect, fillLayers empty', () => {
      const plan = nodeRender(baseFrame, emptyCtx());
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.fillLayers).toEqual([]);
      expect(plan.needsAnchorRect).toBe(false);
      expect(plan.stroke).toBeNull();
      expect(plan.shadow).toBeNull();
    });

    it('empty fillPaints + shadow ⇒ needsAnchorRect=true', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          effects: [{
            type: 'DROP_SHADOW',
            offset: { x: 0, y: 1 },
            radius: 2,
            color: { r: 0, g: 0, b: 0, a: 0.5 },
          }],
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.needsAnchorRect).toBe(true);
      expect(plan.shadow).not.toBeNull();
    });

    it('empty fillPaints + uniform stroke ⇒ needsAnchorRect=true', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          strokeWeight: 2,
          strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.needsAnchorRect).toBe(true);
      expect(plan.stroke?.kind).toBe('uniform');
    });

    it('empty fillPaints + per-side stroke ⇒ needsAnchorRect=false (per-side draws Lines, not anchor)', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          strokeWeight: 2,
          strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
          borderTopWeight: 0,
          borderRightWeight: 0,
          borderBottomWeight: 1,        // only bottom → non-uniform
          borderLeftWeight: 0,
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.stroke?.kind).toBe('per-side');
      expect(plan.needsAnchorRect).toBe(false);
    });

    it('multi-paint stack preserves order with per-paint blendMode + imageScaleMode', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          fillPaints: [
            { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, blendMode: 'NORMAL' },
            { type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 }, blendMode: 'MULTIPLY' },
            { type: 'IMAGE', imageScaleMode: 'FILL', image: { hash: new Uint8Array(20).fill(0xab) } },
          ],
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.fillLayers).toHaveLength(3);
      expect(plan.fillLayers[0].globalCompositeOperation).toBeUndefined(); // NORMAL → undefined
      expect(plan.fillLayers[1].globalCompositeOperation).toBe('multiply');
      expect(plan.fillLayers[2].imageScaleMode).toBe('FILL');
      expect(plan.imageHashHex).toBe('abababababababababababababababababababab');
    });

    it('uniform stroke INSIDE applies applyStrokeAlign to rectDims', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          cornerRadius: 4,
          strokeWeight: 2,
          strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
          strokeAlign: 'INSIDE',
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      if (plan.stroke?.kind !== 'uniform') throw new Error('expected uniform stroke');
      // INSIDE: shrink by stroke/2 on each side.
      expect(plan.stroke.rectDims).toEqual({
        x: 1, y: 1, w: 98, h: 58, cornerRadius: 3,
      });
      expect(plan.stroke.width).toBe(2);
    });

    it('per-side stroke surfaces all four side weights (including 0/undefined)', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          strokeWeight: 2,
          strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
          borderTopWeight: 1,
          borderRightWeight: 0,
          borderBottomWeight: 3,
          borderLeftWeight: undefined,
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      if (plan.stroke?.kind !== 'per-side') throw new Error('expected per-side');
      expect(plan.stroke.sides).toEqual({
        top: 1, right: 0, bottom: 3, left: undefined,
      });
    });

    it('per-side values that are uniform fall back to uniform stroke', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          strokeWeight: 1,
          strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
          borderTopWeight: 1,
          borderRightWeight: 1,
          borderBottomWeight: 1,
          borderLeftWeight: 1,
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.stroke?.kind).toBe('uniform');
    });

    it('per-side values without a base stroke ⇒ stroke null (color comes from baseStroke)', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          // no strokeWeight / strokePaints
          borderBottomWeight: 1,
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.stroke).toBeNull();
    });

    it('isAncestorOfIsolated suppresses fills + clip', () => {
      const ctx: RenderContext = {
        isolation: { hide: new Set(), ancestors: new Set(['1:50']) },
        measureText: noopMeasure,
      };
      const plan = nodeRender(
        {
          ...baseFrame,
          fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
          frameMaskDisabled: false,
        },
        ctx,
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.fillLayers).toEqual([]);
      expect(plan.clipChildren).toBe(false);
    });

    it('frameMaskDisabled=false ⇒ clipChildren=true (round-2 frame clip)', () => {
      const plan = nodeRender({ ...baseFrame, frameMaskDisabled: false }, emptyCtx());
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.clipChildren).toBe(true);
    });

    it('INSTANCE with _renderChildren auto-clips even when frameMaskDisabled is missing', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          type: 'INSTANCE',
          _renderChildren: [{ id: 'c', type: 'TEXT' }],
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.clipChildren).toBe(true);
    });

    it('INSTANCE with explicit frameMaskDisabled=true skips auto-clip', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          type: 'INSTANCE',
          frameMaskDisabled: true,
          _renderChildren: [{ id: 'c', type: 'TEXT' }],
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.clipChildren).toBe(false);
    });

    it('inner shadow + layer blur are surfaced from effects[]', () => {
      const plan = nodeRender(
        {
          ...baseFrame,
          effects: [
            {
              type: 'INNER_SHADOW',
              offset: { x: 1, y: 2 },
              radius: 3,
              color: { r: 0, g: 0, b: 0, a: 0.4 },
            },
            { type: 'LAYER_BLUR', radius: 6 },
          ],
        },
        emptyCtx(),
      );
      if (plan.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(plan.innerShadow?.offsetX).toBe(1);
      expect(plan.innerShadow?.blur).toBe(3);
      expect(plan.layerBlur).toEqual({ radius: 6 });
    });

    it('dashPattern non-empty passes through; empty array → undefined', () => {
      const dashed = nodeRender({ ...baseFrame, dashPattern: [4, 2] }, emptyCtx());
      if (dashed.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(dashed.dashPattern).toEqual([4, 2]);
      const empty = nodeRender({ ...baseFrame, dashPattern: [] }, emptyCtx());
      if (empty.kind !== 'paint-stack') throw new Error('expected paint-stack');
      expect(empty.dashPattern).toBeUndefined();
    });
  });
});
