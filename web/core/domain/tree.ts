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
 * Walk `root.children` once and build a "guidStr → [ancestor1, ancestor2, ...]"
 * map (root-most first). Used by the LayerTree's auto-reveal effect (which
 * walks `.children` only — INSTANCE master subtrees stay collapsed under a
 * single row).
 *
 * Walks `.children` only — INSTANCE master subtree expansions
 * (`_renderChildren`) are *intentionally skipped* in this overload because
 * they carry master-page guids that the LayerTree treats as the outer
 * INSTANCE's collapsed surface. Canvas drill uses
 * `buildAncestorIndexDeep` to reach into those expansions instead (spec
 * web-canvas-drill-selection §I-C4 v2).
 *
 * The returned map does NOT include `root` itself in any chain and uses
 * each node's stringified guid (`<sessionID>:<localID>`) as both key and
 * value. Nodes without a usable guid are skipped silently.
 */
export function buildAncestorIndex(root: unknown): Map<string, string[]> {
  return buildAncestorIndexInternal(root, false);
}

/**
 * Same as `buildAncestorIndex` but ALSO walks every node's `_renderChildren`
 * (INSTANCE master subtree expansion) so a master-page guid resolved to its
 * ancestor chain reaches all the way back to the page-resident outer
 * INSTANCE that owns the expansion. Canvas drill consumes this to drill
 * INTO instances at the cursor (spec web-canvas-drill-selection v2 §3).
 */
export function buildAncestorIndexDeep(root: unknown): Map<string, string[]> {
  return buildAncestorIndexInternal(root, true);
}

function buildAncestorIndexInternal(
  root: unknown,
  includeRender: boolean,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!root || typeof root !== 'object') return out;
  const r = root as { children?: unknown[]; _renderChildren?: unknown[] };
  function nodeGuidStr(n: unknown): string {
    if (!n || typeof n !== 'object') return '';
    const g = (n as { guid?: { sessionID?: number; localID?: number } }).guid;
    if (!g || g.sessionID == null || g.localID == null) return '';
    return `${g.sessionID}:${g.localID}`;
  }
  function walkRec(node: unknown, ancestors: string[]): void {
    if (!node || typeof node !== 'object') return;
    const g = nodeGuidStr(node);
    // First-presence wins so twin INSTANCEs of the same master (which share
    // descendant guids) don't clobber each other based on walk order. The
    // walker still recurses past the duplicate so DIFFERENT-guid descendants
    // inside the twin's copy (per-instance overrides) still get a chain.
    if (g && !out.has(g)) out.set(g, ancestors);
    const nx = node as { children?: unknown[]; _renderChildren?: unknown[] };
    const nextAncestors = g ? [...ancestors, g] : ancestors;
    if (Array.isArray(nx.children) && nx.children.length > 0) {
      for (const c of nx.children) walkRec(c, nextAncestors);
    }
    if (
      includeRender &&
      Array.isArray(nx._renderChildren) &&
      nx._renderChildren.length > 0
    ) {
      for (const c of nx._renderChildren) walkRec(c, nextAncestors);
    }
  }
  const kids = Array.isArray(r.children) ? r.children : [];
  for (const c of kids) walkRec(c, []);
  // Page root itself doesn't have _renderChildren (it's a CANVAS), so no
  // need to consider includeRender at the top level.
  return out;
}

/**
 * Same as `findById` but ALSO walks `_renderChildren` (INSTANCE master
 * subtree expansions) so Inspector / selection-bounds lookups can find a
 * master-page guid that lives inside an instance expansion on the current
 * page. Returns the instance-specific copy when one exists (since
 * `_renderChildren` entries are produced by `toClientChildForRender` with
 * per-instance overrides applied), which is what the user expects from a
 * canvas selection on a drilled-in master child.
 *
 * Spec: docs/specs/web-canvas-drill-selection.spec.md v2 §5.
 */
export function findByIdDeep(node: unknown, id: string): DocumentNode | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as DocumentNode & { _renderChildren?: unknown[] };
  if (n.id === id) return n;
  if (Array.isArray(n.children)) {
    for (const c of n.children) {
      const found = findByIdDeep(c, id);
      if (found) return found;
    }
  }
  if (Array.isArray(n._renderChildren)) {
    for (const c of n._renderChildren) {
      const found = findByIdDeep(c, id);
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
