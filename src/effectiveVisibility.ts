/**
 * Effective Visibility composition primitives, shared between the CLI's
 * `pen-export.ts` and the web's `clientNode.ts` so both pipelines agree
 * on what hides a Figma node.
 *
 * Scope (round 18 step 2): only the **Property Visibility Toggle**
 * mechanism (componentPropRefs[VISIBLE] resolved against an outer
 * INSTANCE's componentPropAssignments map). Direct Visibility and
 * Symbol Visibility Override remain woven into each pipeline's walk —
 * their composition shape differs (CLI patches data via
 * applySymbolOverrides; web carries a path-keyed map). A future round
 * may unify those if the surface stabilises.
 *
 * Spec: docs/specs/expansion-context.spec.md §3.3
 *       docs/specs/web-instance-render-overrides.spec.md §3.4 (Property Visibility Toggle)
 *       CONTEXT.md → "Effective Visibility"
 * Placement: docs/adr/0004-shared-modules-live-in-src.md
 */

/**
 * True iff any of the node's `componentPropRefs[VISIBLE]` entries
 * resolves to a `false` value in the supplied `propAssignments` map
 * (keyed by defID `${sessionID}:${localID}`). Returns false otherwise
 * — including the common case of no VISIBLE refs at all.
 *
 * The "value === false hides; everything else is no-opinion" rule
 * matches Figma's boolean-property-binding semantics: an unbound
 * VISIBLE ref keeps the master's default visibility; a bound true
 * keeps it visible; a bound false hides this descendant in this
 * instance only.
 */
export function isHiddenByPropBinding(
  data: Record<string, unknown>,
  propAssignments: Map<string, boolean>,
): boolean {
  if (propAssignments.size === 0) return false;
  const refs = data.componentPropRefs as
    | Array<{ defID?: { sessionID?: number; localID?: number }; componentPropNodeField?: string }>
    | undefined;
  if (!Array.isArray(refs)) return false;
  for (const r of refs) {
    if (r.componentPropNodeField !== 'VISIBLE') continue;
    const d = r.defID;
    if (!d || typeof d.sessionID !== 'number' || typeof d.localID !== 'number') continue;
    const v = propAssignments.get(`${d.sessionID}:${d.localID}`);
    if (v === false) return true;
  }
  return false;
}
