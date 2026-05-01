// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePatch } from './usePatch';

interface PatchCall {
  sessionId: string;
  guid: string;
  field: string;
  value: unknown;
}

describe('usePatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces same-guid edits in the 220ms window into a single round of PATCH calls', async () => {
    const calls: PatchCall[] = [];
    const onChange = vi.fn();
    const patchFn = vi.fn(async (sessionId: string, guid: string, field: string, value: unknown) => {
      calls.push({ sessionId, guid, field, value });
    });

    const { result } = renderHook(() =>
      usePatch('sid', 'A:1', onChange, patchFn as never),
    );

    act(() => {
      result.current('name', 'X');
      result.current('opacity', 0.5);
    });

    // Before the timer fires, nothing has been sent.
    expect(calls).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(calls).toEqual([
      { sessionId: 'sid', guid: 'A:1', field: 'name', value: 'X' },
      { sessionId: 'sid', guid: 'A:1', field: 'opacity', value: 0.5 },
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // Regression for /review (Claude adversarial subagent), 2026-05-01:
  //
  //   Render 1, guid=A. User edits opacity → pending Map gets {opacity}, a
  //   220ms timer is scheduled with closure_A.
  //   Selection switches → Render 2, guid=B. Refs persist.
  //   User edits B's color before the timer fires → dispatch_B does
  //   `clearTimeout(timer.current)` (cancels A's flush!) and reschedules with
  //   closure_B. Pending Map still contains A's `opacity` entry.
  //   Timer fires → patches BOTH `opacity` and `color` against guid=B.
  //   A's edit is lost; B receives a phantom mutation it never authored.
  //
  // The fix routes through a useEffect cleanup keyed on `[guid, sessionId]`:
  // when the deps change, the cleanup flushes any pending entries against the
  // OLD captured guid before the next render takes effect.
  it('flushes pending edits to the OLD guid when guid changes mid-debounce', async () => {
    const calls: PatchCall[] = [];
    const patchFn = vi.fn(async (sessionId: string, guid: string, field: string, value: unknown) => {
      calls.push({ sessionId, guid, field, value });
    });
    const onChange = vi.fn();

    const { result, rerender } = renderHook(
      ({ guid }: { guid: string }) => usePatch('sid', guid, onChange, patchFn as never),
      { initialProps: { guid: 'A:1' } },
    );

    // 1. Edit something on A. Timer is now scheduled with A in its closure.
    act(() => {
      result.current('name', 'A_NEW_NAME');
    });
    expect(calls).toEqual([]);

    // 2. Switch selection to B. The effect cleanup should flush A's pending
    //    edit BEFORE the new render's effect runs.
    await act(async () => {
      rerender({ guid: 'B:2' });
      // Let the fire-and-forget async flush microtask resolve.
      await Promise.resolve();
      await Promise.resolve();
    });

    // A's pending edit must have already landed on A.
    expect(calls).toContainEqual({
      sessionId: 'sid',
      guid: 'A:1',
      field: 'name',
      value: 'A_NEW_NAME',
    });

    // 3. Edit something on B BEFORE 220ms have elapsed.
    act(() => {
      result.current('opacity', 0.5);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    // B should have received only its own edit; A's `name` must not appear
    // in any call against guid=B.
    const bCalls = calls.filter((c) => c.guid === 'B:2');
    expect(bCalls).toEqual([
      { sessionId: 'sid', guid: 'B:2', field: 'opacity', value: 0.5 },
    ]);
    // A's edit landed on A, not on B.
    const aCalls = calls.filter((c) => c.guid === 'A:1');
    expect(aCalls).toEqual([
      { sessionId: 'sid', guid: 'A:1', field: 'name', value: 'A_NEW_NAME' },
    ]);
  });

  it('flushes pending edits on unmount so a stale timer never fires past the component lifetime', async () => {
    const calls: PatchCall[] = [];
    const patchFn = vi.fn(async (sessionId: string, guid: string, field: string, value: unknown) => {
      calls.push({ sessionId, guid, field, value });
    });
    const onChange = vi.fn();

    const { result, unmount } = renderHook(() =>
      usePatch('sid', 'A:1', onChange, patchFn as never),
    );

    act(() => {
      result.current('name', 'still-pending');
    });
    expect(calls).toEqual([]);

    await act(async () => {
      unmount();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The pending edit should have been flushed to A on unmount.
    expect(calls).toEqual([
      { sessionId: 'sid', guid: 'A:1', field: 'name', value: 'still-pending' },
    ]);

    // Advancing past the original timer should NOT fire a second time.
    const before = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(calls.length).toBe(before);
  });
});
