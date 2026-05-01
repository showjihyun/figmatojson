// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { memo } from 'react';
import {
  SelectionContext,
  SelectionStore,
  useIsSelected,
} from './canvas-selection';

/**
 * The canvas perf invariant we care about:
 *   when only one guid's membership flips, only consumers for THAT guid
 *   should re-render. Others are subscribed but their getSnapshot returns
 *   the same boolean → useSyncExternalStore short-circuits.
 *
 * This test mounts three memoized consumers, swaps the selection a few
 * times, and asserts the per-consumer render counts.
 */

describe('SelectionStore + useIsSelected', () => {
  it('SelectionStore.has reflects the latest .set() call', () => {
    const s = new SelectionStore();
    expect(s.has('0:1')).toBe(false);
    s.set(new Set(['0:1', '0:2']));
    expect(s.has('0:1')).toBe(true);
    expect(s.has('0:2')).toBe(true);
    expect(s.has('0:3')).toBe(false);
    s.set(new Set(['0:3']));
    expect(s.has('0:1')).toBe(false);
    expect(s.has('0:3')).toBe(true);
  });

  it('subscribe returns an unsubscribe; listeners stop firing after it runs', () => {
    const s = new SelectionStore();
    const cb = vi.fn();
    const unsub = s.subscribe(cb);
    s.set(new Set(['a']));
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    s.set(new Set(['b']));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('only consumers whose guid membership flipped re-render on selection change', () => {
    const renderCounts = { a: 0, b: 0, c: 0 };

    const Consumer = memo(function Consumer({ guid }: { guid: string }) {
      const isSel = useIsSelected(guid);
      renderCounts[guid as 'a' | 'b' | 'c']++;
      return <span data-testid={guid}>{isSel ? 'sel' : 'unsel'}</span>;
    });

    const store = new SelectionStore();
    const { getByTestId } = render(
      <SelectionContext.Provider value={store}>
        <Consumer guid="a" />
        <Consumer guid="b" />
        <Consumer guid="c" />
      </SelectionContext.Provider>,
    );

    // Mount renders count as 1 each; useSyncExternalStore fires getSnapshot
    // during render so this count is what we baseline against.
    expect(renderCounts).toEqual({ a: 1, b: 1, c: 1 });
    expect(getByTestId('a').textContent).toBe('unsel');

    // Select 'a' — 'a' flips false→true, the others stay false.
    act(() => { store.set(new Set(['a'])); });
    expect(renderCounts.a).toBe(2);
    expect(renderCounts.b).toBe(1);
    expect(renderCounts.c).toBe(1);
    expect(getByTestId('a').textContent).toBe('sel');

    // Switch to 'b' — both 'a' and 'b' flip; 'c' stays false.
    act(() => { store.set(new Set(['b'])); });
    expect(renderCounts.a).toBe(3); // true → false
    expect(renderCounts.b).toBe(2); // false → true
    expect(renderCounts.c).toBe(1); // unchanged
    expect(getByTestId('a').textContent).toBe('unsel');
    expect(getByTestId('b').textContent).toBe('sel');

    // No-op set (same membership, different Set identity) — no consumer
    // re-renders because every getSnapshot returns its previous boolean.
    act(() => { store.set(new Set(['b'])); });
    expect(renderCounts).toEqual({ a: 3, b: 2, c: 1 });
  });

  it('returns false for null guid (used for nodes without a guid)', () => {
    const renders = { count: 0 };
    function Probe() {
      const isSel = useIsSelected(null);
      renders.count++;
      return <span>{String(isSel)}</span>;
    }
    const store = new SelectionStore();
    const { container } = render(
      <SelectionContext.Provider value={store}>
        <Probe />
      </SelectionContext.Provider>,
    );
    expect(container.textContent).toBe('false');
    // A selection change must not flip a null-guid consumer.
    act(() => { store.set(new Set(['anything'])); });
    expect(container.textContent).toBe('false');
  });
});
