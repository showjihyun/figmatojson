/**
 * Variant-container detection.
 *
 * Spec: docs/specs/web-canvas-hover-tooltip.spec.md §I-T5 / §I-T5.1
 *       docs/specs/web-left-sidebar.spec.md §I-F3.5 / §I-F11.5b
 *
 * Figma's "variants" feature is represented two ways in .fig files:
 *
 *   (a) Newer: a `COMPONENT_SET` whose direct children are `COMPONENT` nodes.
 *       That's the modern format with explicit type metadata.
 *
 *   (b) Legacy: any container (FRAME / SYMBOL) whose direct children are
 *       SYMBOL/COMPONENT nodes named with the `prop=value, prop=value` pattern.
 *       Older Figma exports — the `메타리치 화면 UI Design.fig` sample uses this
 *       form (a plain FRAME named "Button" with 50 SYMBOL children whose
 *       names look like `"size=XL, State=default, Type=primary"`).
 *
 * Both shapes drive the same UX (hover tooltip variant count, layer-tree
 * `(N)` badge, auto-expand on selection), so callers go through this single
 * helper instead of branching.
 *
 * `countVariantChildren` is a pure function over a node's `type` and direct
 * `children` array; it does not recurse and does not look at the tree
 * around the node. Callers can safely memoize per node.
 */

interface Node {
  type?: string;
  name?: string;
  children?: Node[];
}

/** Matches `key=value` at the start of a name — e.g. "size=XL, State=hover". */
const VARIANT_NAME_RE = /^[\w가-힣 ]+=/;

export function countVariantChildren(node: Node | undefined | null): number {
  if (!node || !Array.isArray(node.children) || node.children.length === 0) return 0;

  // (a) Newer Figma: COMPONENT_SET ⇒ count direct COMPONENT children.
  if (node.type === 'COMPONENT_SET') {
    let n = 0;
    for (const c of node.children) if (c?.type === 'COMPONENT') n++;
    return n;
  }

  // (b) Legacy: any container with ≥2 direct SYMBOL/COMPONENT children whose
  // names match the variant property=value pattern.
  let n = 0;
  for (const c of node.children) {
    if (c?.type !== 'SYMBOL' && c?.type !== 'COMPONENT') continue;
    if (typeof c.name !== 'string') continue;
    if (VARIANT_NAME_RE.test(c.name)) n++;
  }
  return n >= 2 ? n : 0;
}
