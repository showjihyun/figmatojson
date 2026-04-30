/**
 * spec: docs/specs/parent-index-position.spec.md
 */
import { describe, expect, it } from 'vitest';
import { between, compare, regenerate } from '../src/fractional-index.js';

describe('between', () => {
  it('I-1: a < between(a, b) < b', () => {
    const r = between('a', 'c');
    expect(r > 'a').toBe(true);
    expect(r < 'c').toBe(true);
  });

  it('null,null returns a stable middle char', () => {
    const r = between(null, null);
    expect(r.length).toBeGreaterThan(0);
  });

  it('null,b returns < b', () => {
    expect(between(null, 'm') < 'm').toBe(true);
  });

  it('a,null returns > a', () => {
    expect(between('m', null) > 'm').toBe(true);
  });

  it('I-2: deterministic (same input → same output)', () => {
    expect(between('a', 'c')).toBe(between('a', 'c'));
  });

  it('throws on a >= b', () => {
    expect(() => between('b', 'a')).toThrow(/must be </);
  });

  it('I-1: monotonic over many inserts', () => {
    let positions: string[] = ['a', 'z'];
    for (let i = 0; i < 50; i++) {
      const mid = between(positions[0]!, positions[1]!);
      positions.splice(1, 0, mid);
    }
    for (let i = 0; i + 1 < positions.length; i++) {
      expect(positions[i]! < positions[i + 1]!).toBe(true);
    }
  });

  it('handles adjacent chars (close positions)', () => {
    const r = between('a', 'b');
    expect(r > 'a').toBe(true);
    expect(r < 'b').toBe(true);
  });
});

describe('regenerate', () => {
  it('returns increasing sequence', () => {
    const r = regenerate(10);
    expect(r.length).toBe(10);
    for (let i = 0; i + 1 < r.length; i++) {
      expect(r[i]! < r[i + 1]!).toBe(true);
    }
  });

  it('handles n=0,1', () => {
    expect(regenerate(0)).toEqual([]);
    expect(regenerate(1).length).toBe(1);
  });
});

describe('compare', () => {
  it('returns -1, 0, 1', () => {
    expect(compare('a', 'b')).toBe(-1);
    expect(compare('b', 'a')).toBe(1);
    expect(compare('a', 'a')).toBe(0);
  });
});
