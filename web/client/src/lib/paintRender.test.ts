import { describe, expect, it } from 'vitest';
import { paintLayers, paintToRender } from './paintRender';

describe('paintToRender', () => {
  it('returns null for missing / hidden paints', () => {
    expect(paintToRender(undefined, 100, 50)).toBeNull();
    expect(paintToRender({ type: 'SOLID', visible: false }, 100, 50)).toBeNull();
  });

  it('SOLID → solid render with paint.opacity baked into alpha', () => {
    const out = paintToRender(
      { type: 'SOLID', opacity: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } },
      100,
      50,
    );
    expect(out).toEqual({ kind: 'solid', fill: 'rgba(255,0,0,0.500)' });
  });

  it('SOLID without opacity defaults alpha to color.a', () => {
    const out = paintToRender({ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 0.25 } }, 10, 10);
    expect(out).toEqual({ kind: 'solid', fill: 'rgba(0,0,255,0.250)' });
  });

  it('GRADIENT_LINEAR → gradient render kind=linear', () => {
    const out = paintToRender(
      {
        type: 'GRADIENT_LINEAR',
        transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }],
      },
      100,
      50,
    );
    expect(out?.kind).toBe('linear');
  });

  it('GRADIENT_ANGULAR / DIAMOND → solid fallback to first-stop color', () => {
    const out = paintToRender(
      {
        type: 'GRADIENT_ANGULAR',
        stops: [{ color: { r: 0, g: 1, b: 0, a: 1 }, position: 0 }],
      },
      10,
      10,
    );
    expect(out).toEqual({ kind: 'solid', fill: 'rgba(0,255,0,1.000)' });
  });

  it('IMAGE → kind:image marker (caller renders ImageFill)', () => {
    expect(paintToRender({ type: 'IMAGE', visible: true }, 10, 10)).toEqual({ kind: 'image' });
  });

  it('returns null for unknown paint types', () => {
    expect(paintToRender({ type: 'BIZARRO' }, 10, 10)).toBeNull();
  });
});

describe('paintLayers', () => {
  it('returns empty when fillPaints is missing or empty', () => {
    expect(paintLayers(undefined, 10, 10)).toEqual([]);
    expect(paintLayers([], 10, 10)).toEqual([]);
  });

  it('skips hidden paints, preserves bottom-up stack order', () => {
    const a = { type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 } };
    const hidden = { type: 'SOLID', visible: false, color: { r: 0, g: 1, b: 0, a: 1 } };
    const c = { type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 1, a: 1 } };
    const out = paintLayers([a, hidden, c], 10, 10);
    expect(out).toHaveLength(2);
    expect(out[0].paint).toBe(a);   // bottom paint stays first
    expect(out[1].paint).toBe(c);
  });

  it('mixes solid + gradient + image in original order', () => {
    const solid = { type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } };
    const grad = {
      type: 'GRADIENT_LINEAR',
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      stops: [{ color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 }],
    };
    const image = { type: 'IMAGE' };
    const out = paintLayers([solid, grad, image], 10, 10);
    expect(out.map((l) => l.render.kind)).toEqual(['solid', 'linear', 'image']);
  });
});
