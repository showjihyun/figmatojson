/**
 * Canvas drill-in selection model — pure logic.
 *
 * Single-click on a deep canvas hit lands on the topmost root-level
 * container (the page's direct child); each subsequent double-click drills
 * one level deeper along the hit's ancestor chain.
 *
 * Spec: docs/specs/web-canvas-drill-selection.spec.md §3.
 *
 * No React / Konva / DOM. The Canvas builds the chain via the existing
 * `buildAncestorIndex` and passes it here together with the current
 * selection. Tests cover every branch in `drillSelection.test.ts`.
 */

export type ClickKind = 'click' | 'dblclick';

/**
 * Resolve the next selected guid for a canvas click.
 *
 * @param chain Ancestor path from the page's direct child down to the hit
 *              node, hit-last. `chain[0]` is the root-level container.
 *              Master subtree descendants (`_renderChildren`) ARE included
 *              in v2 — see spec §3. Empty array = defensive no-selection.
 * @param current The currently-selected single guid, or null.
 * @param kind  `'click'` for a single click, `'dblclick'` for the drill gesture.
 * @returns The guid to select, or `null` to clear.
 */
export function resolveDrillSelection(
  chain: readonly string[],
  current: string | null,
  kind: ClickKind,
): string | null {
  if (chain.length === 0) return null;
  const last = chain.length - 1;
  if (kind === 'click') {
    // Preserve the current selection when it's already part of this chain
    // (the user is mid-drill — single click should not reset drill state).
    // A click outside the current chain still resets to the outermost
    // container (chain[0]); see web-canvas-drill-selection v2 §3.
    if (current !== null && chain.indexOf(current) >= 0) return current;
    return chain[0]!;
  }
  // dblclick: drill one level deeper from the current selection.
  if (current === null) {
    // No prior selection — drill = single-click target + one deeper.
    return chain[Math.min(1, last)]!;
  }
  const idx = chain.indexOf(current);
  if (idx === -1) {
    // Current isn't on this chain (different subtree) — treat as a fresh
    // drill: start from the outermost and step in one level. Matches
    // Figma's UX when a rapid double-click crosses into a different frame.
    return chain[Math.min(1, last)]!;
  }
  if (idx >= last) return current;             // already at the deepest hit
  return chain[idx + 1]!;
}
