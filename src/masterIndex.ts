/**
 * GUID → Master lookup. The canonical implementation, shared between
 * the CLI's `pen-export.ts` and the web's `clientNode.ts` so both
 * pipelines agree on what a "Master" is.
 *
 * Spec: docs/specs/expansion-context.spec.md §3.4
 * Placement: docs/adr/0004-shared-modules-live-in-src.md
 */
import type { TreeNode } from './types.js';

/**
 * Build a `Map<GUID, Master>` over the given nodes. Only nodes whose
 * `type ∈ {SYMBOL, COMPONENT, COMPONENT_SET}` are indexed — i.e. the
 * Figma node types that an INSTANCE can reference as its master via
 * `symbolData.symbolID`. Other Tree Node types are deliberately
 * excluded so an INSTANCE→master lookup can't accidentally resolve
 * to a non-master node sharing a GUID with one.
 *
 * Accepts either a Map of nodes (CLI's prevailing shape from
 * `buildTree`) or any Iterable of TreeNodes (web's load path that
 * walks the document tree).
 */
export function buildMasterIndex(
  source: Iterable<TreeNode> | Map<string, TreeNode>,
): Map<string, TreeNode> {
  const out = new Map<string, TreeNode>();
  const iter: Iterable<TreeNode> =
    source instanceof Map ? source.values() : source;
  for (const n of iter) {
    if (n.type === 'SYMBOL' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
      out.set(n.guidStr, n);
    }
  }
  return out;
}
