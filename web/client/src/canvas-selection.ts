/**
 * Selection plumbing for Canvas.tsx.
 *
 * Naive prop-drilling of `selectedGuids: Set<string>` re-renders every
 * NodeShape on every selection change — at 35 K nodes that's a multi-
 * hundred-millisecond reconciliation hitch on every click. This module
 * exposes selection through an external store + per-node
 * `useSyncExternalStore` subscription so each NodeShape only re-renders
 * if THIS guid's membership flipped.
 *
 * Lives in a Konva-free file so unit tests can mount it under jsdom
 * without needing the canvas backend.
 */

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

type Listener = () => void;

export class SelectionStore {
  private current = new Set<string>();
  private listeners = new Set<Listener>();
  set(next: Set<string>): void {
    this.current = next;
    for (const cb of this.listeners) cb();
  }
  has = (guid: string): boolean => this.current.has(guid);
  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };
}

export const SelectionContext = createContext<SelectionStore | null>(null);

function noopSubscribe(): () => void { return () => {}; }

export function useIsSelected(guid: string | null): boolean {
  const store = useContext(SelectionContext);
  // getSnapshot must be stable per (guid, store) — closures with new
  // identity every render would defeat useSyncExternalStore's tearing
  // prevention path.
  const getSnapshot = useCallback(
    () => (guid && store ? store.has(guid) : false),
    [guid, store],
  );
  const subscribe = store?.subscribe ?? noopSubscribe;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
