/**
 * Pure tree helpers for the Document graph.
 *
 * No IO, no framework. Moved here from server/index.ts and Canvas.tsx as
 * part of Phase 2 domain extraction — both server and client now use the
 * same single source of truth for "find a node by GUID" and friends.
 */

import type { DocumentNode, Guid } from './entities/Document';

/** Stringify a Figma GUID (`{sessionID, localID}`) to "<sessionID>:<localID>". */
export function guidStr(g: unknown): string | null {
  if (!g || typeof g !== 'object') return null;
  const guid = g as Partial<Guid>;
  if (typeof guid.sessionID !== 'number' || typeof guid.localID !== 'number') return null;
  return `${guid.sessionID}:${guid.localID}`;
}

/**
 * Depth-first search for a node by its `id` (the stringified GUID).
 * Used by the PATCH endpoint, the resize / instance-override endpoints,
 * the chat tool dispatcher, and the Inspector's `findByGuid`.
 */
export function findById(node: unknown, id: string): DocumentNode | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as DocumentNode;
  if (n.id === id) return n;
  if (Array.isArray(n.children)) {
    for (const c of n.children) {
      const found = findById(c, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Depth-first walk of the tree, calling `visit` for every node (root first).
 * `visit` may return false to short-circuit the traversal.
 */
export function walk(
  node: unknown,
  visit: (n: DocumentNode) => boolean | void,
): void {
  function rec(n: unknown): boolean {
    if (!n || typeof n !== 'object') return true;
    const cur = n as DocumentNode;
    if (visit(cur) === false) return false;
    if (Array.isArray(cur.children)) {
      for (const c of cur.children) {
        if (!rec(c)) return false;
      }
    }
    return true;
  }
  rec(node);
}
