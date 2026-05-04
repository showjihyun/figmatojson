/**
 * Instance Override collectors — read an INSTANCE's `symbolOverrides[]`
 * (and the INSTANCE's own `componentPropAssignments`) into typed
 * Map<pathKey, value> structures the walk side can apply against
 * resolved descendant nodes.
 *
 * The collectors are pure data-shape parsers — no DocumentNode / no
 * Konva / no rendering decisions. The walk that consumes them lives
 * in each pipeline:
 *   - web/core/domain/clientNode.ts:toClientChildForRender (round 12+)
 *   - src/pen-export.ts:applySymbolOverrides + convertNode (CLI; uses
 *     a different style but reads the same source data)
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.1 / §3.2 / §3.4
 *       docs/specs/web-instance-variant-swap.spec.md §3.1
 *       docs/specs/expansion-context.spec.md (cluster A migration)
 * Placement: docs/adr/0004-shared-modules-live-in-src.md
 */

/**
 * Convert a guidPath { guids: [...] } into a slash-joined pathKey, e.g.
 *   [{sess:11, local:524}, {sess:11, local:506}] → "11:524/11:506"
 *
 * Returns null if any guid is malformed. Single-step paths come out as a
 * plain "sess:local" string (no slash) so they remain compatible with
 * single-step lookups in the same Map.
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.1 I-C1.
 */
export function pathKeyFromGuids(
  guids: Array<{ sessionID?: number; localID?: number }> | undefined,
): string | null {
  if (!Array.isArray(guids) || guids.length === 0) return null;
  const parts: string[] = [];
  for (const g of guids) {
    if (typeof g?.sessionID !== 'number' || typeof g?.localID !== 'number') return null;
    parts.push(`${g.sessionID}:${g.localID}`);
  }
  return parts.join('/');
}

/**
 * Pull text overrides out of an INSTANCE's symbolOverrides[]. Returns a
 * Map<pathKey, string> where pathKey is the slash-joined full guidPath
 * (e.g. "11:524/11:506"). Multi-step paths are required for files like
 * `메타리치 화면 UI Design.fig` where one master is instantiated multiple
 * times under a parent and each instance overrides the same descendant
 * TEXT to a different value — single-step keys would collide on the
 * shared last guid.
 */
export function collectTextOverridesFromInstance(
  overrides: Array<Record<string, unknown>> | undefined,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!Array.isArray(overrides)) return m;
  for (const o of overrides) {
    const td = o.textData as { characters?: string } | undefined;
    if (typeof td?.characters !== 'string') continue;
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    const key = pathKeyFromGuids(guids);
    if (key === null) continue;
    m.set(key, td.characters);
  }
  return m;
}

/**
 * Pull fillPaints overrides out of an INSTANCE's symbolOverrides[]. Same
 * pathKey scheme as text overrides — see `collectTextOverridesFromInstance`
 * for the rationale on multi-step keys.
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.1
 */
export function collectFillOverridesFromInstance(
  overrides: Array<Record<string, unknown>> | undefined,
): Map<string, unknown[]> {
  const m = new Map<string, unknown[]>();
  if (!Array.isArray(overrides)) return m;
  for (const o of overrides) {
    const fps = o.fillPaints;
    if (!Array.isArray(fps)) continue;
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    const key = pathKeyFromGuids(guids);
    if (key === null) continue;
    m.set(key, fps);
  }
  return m;
}

/**
 * Pull per-instance visibility overrides out of symbolOverrides[]. Each
 * matching entry sets `visible: boolean` on the descendant identified
 * by guidPath. Same path-keyed model as text / fill overrides.
 *
 * Common Figma pattern: an instance hides a child layer (e.g., a chevron
 * icon inside a Button "확인" variant) without affecting other instances
 * of the same master.
 */
export function collectVisibilityOverridesFromInstance(
  overrides: Array<Record<string, unknown>> | undefined,
): Map<string, boolean> {
  const m = new Map<string, boolean>();
  if (!Array.isArray(overrides)) return m;
  for (const o of overrides) {
    if (typeof o.visible !== 'boolean') continue;
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    const key = pathKeyFromGuids(guids);
    if (key === null) continue;
    m.set(key, o.visible);
  }
  return m;
}

/**
 * Pull boolean component-property assignments off an INSTANCE node's `data`.
 * Returns Map<defIdKey, boolean> keyed by `${sessionID}:${localID}` of the
 * property's defID. Used by the walk to resolve descendants whose
 * `componentPropRefs` carry `componentPropNodeField: "VISIBLE"` — see
 * `src/effectiveVisibility.ts:isHiddenByPropBinding`.
 *
 * Why this exists — Figma's standard way to bind a layer's visibility to a
 * boolean component property. The 메타리치 alert dialog hides its action
 * buttons' arrow icon via this mechanism, NOT via `symbolOverrides[].visible`.
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.4 I-C6/I-C7.
 */
export function collectPropAssignmentsFromInstance(
  instData: Record<string, unknown> | undefined,
): Map<string, boolean> {
  const m = new Map<string, boolean>();
  const cpa = instData?.componentPropAssignments as
    | Array<{
        defID?: { sessionID?: number; localID?: number };
        value?: { boolValue?: boolean };
        varValue?: { value?: { boolValue?: boolean } };
      }>
    | undefined;
  if (!Array.isArray(cpa)) return m;
  for (const a of cpa) {
    const d = a.defID;
    if (!d || typeof d.sessionID !== 'number' || typeof d.localID !== 'number') continue;
    // Direct value first (explicit on this INSTANCE), fall back to varValue
    // (variant default propagated through the property chain). Either may
    // be the source of truth depending on whether the designer overrode
    // the prop on this specific instance.
    const directV = a.value?.boolValue;
    const varV = a.varValue?.value?.boolValue;
    const v = typeof directV === 'boolean' ? directV : (typeof varV === 'boolean' ? varV : undefined);
    if (typeof v !== 'boolean') continue;
    m.set(`${d.sessionID}:${d.localID}`, v);
  }
  return m;
}

/**
 * Pull path-keyed variant-swap targets out of an outer INSTANCE's
 * `symbolOverrides[]`. Each entry that carries `overriddenSymbolID`
 * contributes a `pathKey → swapTargetGuidStr` mapping. Used by the
 * walk to swap the master at expansion time.
 *
 * Why this exists — Figma's "swap component instance" mechanism. The
 * metarich Dropdown rail's "직접 선택" option is implemented this way:
 * the outer Dropdown swaps the 6th option-row's master from the
 * default state to a "selected" variant whose tree carries different
 * descendant GUIDs that other path-keyed overrides know about.
 *
 * Spec: docs/specs/web-instance-variant-swap.spec.md §3.1.
 */
export function collectSwapTargetsAtPathFromInstance(
  overrides: Array<Record<string, unknown>> | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(overrides)) return out;
  for (const o of overrides) {
    const sw = o.overriddenSymbolID as { sessionID?: number; localID?: number } | undefined;
    if (!sw || typeof sw.sessionID !== 'number' || typeof sw.localID !== 'number') continue;
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    const key = pathKeyFromGuids(guids);
    if (key === null) continue;
    out.set(key, `${sw.sessionID}:${sw.localID}`);
  }
  return out;
}

/**
 * Pull path-keyed component-property assignments out of an outer INSTANCE's
 * `symbolOverrides[]`. Each entry whose `componentPropAssignments` is
 * non-empty contributes a Map<defID, boolean> at its `guidPath` key.
 *
 * Why this exists — the metarich Dropdown rail's "금월"/"전월" option rows
 * inherit prop assignments from the OUTER Dropdown's symbolOverride
 * entries, not from their own componentPropAssignments. Without this,
 * the arrow-icon prop-binding fix from round 12 misses these rows
 * (they keep the leaked arrow even though the data has the right
 * assignment to hide it).
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.4 I-P11.
 */
export function collectPropAssignmentsAtPathFromInstance(
  overrides: Array<Record<string, unknown>> | undefined,
): Map<string, Map<string, boolean>> {
  const out = new Map<string, Map<string, boolean>>();
  if (!Array.isArray(overrides)) return out;
  for (const o of overrides) {
    const cpa = o.componentPropAssignments as
      | Array<{
          defID?: { sessionID?: number; localID?: number };
          value?: { boolValue?: boolean };
          varValue?: { value?: { boolValue?: boolean } };
        }>
      | undefined;
    if (!Array.isArray(cpa) || cpa.length === 0) continue;
    const guids = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    const key = pathKeyFromGuids(guids);
    if (key === null) continue;
    // Build the per-path assignments map using the same shape as
    // collectPropAssignmentsFromInstance — direct boolValue first, fall
    // back to varValue, skip non-boolean entries.
    const inner = new Map<string, boolean>();
    for (const a of cpa) {
      const d = a.defID;
      if (!d || typeof d.sessionID !== 'number' || typeof d.localID !== 'number') continue;
      const directV = a.value?.boolValue;
      const varV = a.varValue?.value?.boolValue;
      const v = typeof directV === 'boolean' ? directV : (typeof varV === 'boolean' ? varV : undefined);
      if (typeof v !== 'boolean') continue;
      inner.set(`${d.sessionID}:${d.localID}`, v);
    }
    if (inner.size > 0) out.set(key, inner);
  }
  return out;
}

/**
 * Pull pre-computed `derivedSize` per descendant path out of an INSTANCE's
 * `derivedSymbolData[]`. Returns `Map<pathKey, {x, y}>`.
 *
 * Why this exists — Figma pre-computes the rendered size of TEXT
 * descendants (after text/font overrides are applied) and stamps the
 * result into the INSTANCE's `derivedSymbolData`. This is *Figma's*
 * authoritative measurement using the actual font metrics of the override
 * text. Without it, our reflow uses the master TEXT size (e.g. 43px for
 * default "Button") even when the override is much wider (e.g. 85px for
 * "Excel 다운로드"), producing wrong CENTER positions and icon-text
 * overlap.
 *
 * pen-export.ts uses the same source via `buildDerivedMap` +
 * `applyDerivedSymbolData`. v1 here covers `size` only — other derived
 * fields (fillGeometry, transform, fontMetaData) are not applied yet.
 *
 * Spec: docs/specs/web-instance-autolayout-reflow.spec.md §3.8 (round 21).
 */
export function collectDerivedSizesFromInstance(
  instData: Record<string, unknown> | undefined,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const ds = instData?.derivedSymbolData as
    | Array<Record<string, unknown> & { guidPath?: { guids?: Array<{ sessionID?: number; localID?: number }> }; size?: { x?: number; y?: number } }>
    | undefined;
  if (!Array.isArray(ds)) return out;
  for (const entry of ds) {
    const sz = entry.size;
    if (!sz || typeof sz.x !== 'number' || typeof sz.y !== 'number') continue;
    const guids = entry.guidPath?.guids;
    const key = pathKeyFromGuids(guids);
    if (key === null) continue;
    out.set(key, { x: sz.x, y: sz.y });
  }
  return out;
}

/**
 * Merge a nested INSTANCE's own override map into the outer overrides,
 * prefixing each inner key with the outer path so it matches against the
 * deeper visit path. The outer overrides remain in place (their full paths
 * may target descendants of THIS inner instance via I-P5). Returns a new
 * Map; inputs are not mutated.
 *
 * Spec: docs/specs/web-instance-render-overrides.spec.md §3.2 I-P5.
 */
export function mergeOverridesForNested<V>(
  outer: Map<string, V>,
  inner: Map<string, V>,
  pathFromOuter: string[],
): Map<string, V> {
  if (inner.size === 0) return outer;
  const out = new Map(outer);
  const prefix = pathFromOuter.join('/');
  for (const [innerKey, innerVal] of inner) {
    const merged = prefix.length > 0 ? `${prefix}/${innerKey}` : innerKey;
    out.set(merged, innerVal);
  }
  return out;
}
