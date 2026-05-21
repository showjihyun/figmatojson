import { describe, expect, it } from 'vitest';
import { resolveDrillSelection } from './drillSelection';

describe('resolveDrillSelection', () => {
  const ABC = ['A', 'B', 'C'] as const;

  // T-1
  it('single click lands on chain[0] from scratch or from an unrelated selection', () => {
    expect(resolveDrillSelection(ABC, null, 'click')).toBe('A');
    expect(resolveDrillSelection(ABC, 'unrelated', 'click')).toBe('A');
  });

  // T-1b (v2)
  it('single click preserves an in-chain selection so multi-step drill is sticky', () => {
    expect(resolveDrillSelection(ABC, 'A', 'click')).toBe('A');
    expect(resolveDrillSelection(ABC, 'B', 'click')).toBe('B');
    expect(resolveDrillSelection(ABC, 'C', 'click')).toBe('C');
  });

  // T-2
  it('double-click with no current selection drills to chain[1]', () => {
    expect(resolveDrillSelection(ABC, null, 'dblclick')).toBe('B');
  });

  it('double-click on a single-element chain with no current selection stays at the root', () => {
    expect(resolveDrillSelection(['A'], null, 'dblclick')).toBe('A');
  });

  // T-3
  it('double-click drills one level deeper from the current selection', () => {
    expect(resolveDrillSelection(ABC, 'A', 'dblclick')).toBe('B');
    expect(resolveDrillSelection(ABC, 'B', 'dblclick')).toBe('C');
  });

  it('double-click at the deepest hit is a no-op (stays on current)', () => {
    expect(resolveDrillSelection(ABC, 'C', 'dblclick')).toBe('C');
  });

  // T-4
  it('double-click on a single-element chain whose only entry is current is a no-op', () => {
    expect(resolveDrillSelection(['A'], 'A', 'dblclick')).toBe('A');
  });

  // T-5 (v2)
  it("double-click with current not on this chain drills one step from the outermost", () => {
    // Previously returned chain[0] — that meant a rapid double-click across
    // frames didn't drill. v2 treats out-of-chain like null so the user
    // gets chain[1] either way (matches Figma).
    expect(resolveDrillSelection(ABC, 'Z', 'dblclick')).toBe('B');
    // Still safe on a single-element chain (no drill target available).
    expect(resolveDrillSelection(['A'], 'Z', 'dblclick')).toBe('A');
  });

  // T-6
  it('empty chain returns null for both single and double click', () => {
    expect(resolveDrillSelection([], null, 'click')).toBeNull();
    expect(resolveDrillSelection([], 'A', 'click')).toBeNull();
    expect(resolveDrillSelection([], null, 'dblclick')).toBeNull();
    expect(resolveDrillSelection([], 'A', 'dblclick')).toBeNull();
  });

  it('preserves identity (returns the same string reference from the chain, not a copy)', () => {
    const a = 'A';
    const b = 'B';
    const chain = [a, b];
    expect(resolveDrillSelection(chain, a, 'dblclick')).toBe(b);
    expect(resolveDrillSelection(chain, null, 'click')).toBe(a);
  });
});
