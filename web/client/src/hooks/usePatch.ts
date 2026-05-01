import { useEffect, useRef } from 'react';
import { patchNode as defaultPatchNode } from '../api';

/**
 * Debounced PATCH dispatcher for the Inspector.
 *
 * Calling the returned function enqueues `(field, value)` into a shared map
 * and schedules a single coalesced flush ~220ms later. Multiple edits to the
 * same node within the window become one HTTP round-trip per (field, value)
 * pair (no re-render thrash, no patch storm during slider drags).
 *
 * **Cross-guid safety:** when `guid` (or `sessionId`) changes — the user
 * switched selection, opened a new doc — the cleanup flushes any still-pending
 * entries against the OLD guid before the next render takes effect. Without
 * this guard, the shared `pending` Map and `timer` ref persist across renders
 * and a freshly-scheduled flush would PATCH the previous selection's pending
 * fields onto the new node.
 *
 * `patchFn` is injected so tests can replace it with a recorder; production
 * callers omit it and get the real `patchNode`.
 */
export function usePatch(
  sessionId: string,
  guid: string,
  onChange: () => void,
  patchFn: typeof defaultPatchNode = defaultPatchNode,
) {
  const pending = useRef<Map<string, unknown>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const oldSessionId = sessionId;
    const oldGuid = guid;
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const entries = [...pending.current.entries()];
      pending.current.clear();
      if (entries.length === 0) return;
      // Fire-and-forget against the captured (oldSessionId, oldGuid).
      void (async () => {
        for (const [f, v] of entries) {
          try {
            await patchFn(oldSessionId, oldGuid, f, v);
          } catch (err) {
            console.error('flush-on-guid-change patch failed', f, err);
          }
        }
        onChange();
      })();
    };
    // onChange/patchFn intentionally omitted — capturing the latest values via
    // closure is fine, and including them would re-bind the effect on every
    // parent re-render and flush prematurely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guid, sessionId]);

  return (field: string, value: unknown): void => {
    pending.current.set(field, value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const entries = [...pending.current.entries()];
      pending.current.clear();
      timer.current = null;
      for (const [f, v] of entries) {
        try {
          await patchFn(sessionId, guid, f, v);
        } catch (err) {
          console.error('patch failed', f, err);
        }
      }
      onChange();
    }, 220);
  };
}
