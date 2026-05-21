# spec/web-canvas-drill-selection

| Field | Value |
|---|---|
| Status | Draft v2 (drills into INSTANCE master subtrees) |
| Implementation | `web/client/src/Canvas.tsx`, `web/client/src/Inspector.tsx`, `web/core/domain/drillSelection.ts`, `web/core/domain/tree.ts` |
| Tests | `web/core/domain/drillSelection.test.ts`, existing `LayerTree.test.tsx` for sidebar parity |
| Siblings | `web-left-sidebar.spec.md` §I-F14 (LayerTree double-click drill — same model, different surface) |

## 1. Goal

Match Figma's canvas selection ergonomics. Today's behaviour selects the **deepest** non-`_isInstanceChild` shape hit by a click (because each `NodeShape.onClick` does `e.cancelBubble = true`), which:

- makes it impossible to grab the top-level page frame when its content fills the viewport (every click lands on some descendant),
- contradicts Figma's "page-level frame first, drill on demand" mental model that the LayerTree already implements via double-click,
- causes silent UX mismatches with the LayerTree (single-click in the tree selects the row clicked; canvas selects something deeper — same gesture, different outcome).

The fix is to flip canvas selection to **chain-aware**: first click always lands on the topmost root-level container under the cursor, and each subsequent double-click drills one level deeper at the same point.

## 2. Selection chain

Given a click at point `p` whose deepest hit node is `H`, the **selection chain** is the ancestor path from the page-level direct child down to `H`, restricted to nodes that are reachable via the current page's `.children` walk:

```
chain = [pageDirectChild, …, parentOfH, H]
```

- I-C1 `chain[0]` is always the page's direct child — i.e. `currentPage.children[i]` for some `i`. It is the node Figma considers a "frame" at the canvas level.
- I-C2 `chain[chain.length - 1]` is `H` itself.
- I-C3 (v2) Master-subtree descendants (`_isInstanceChild === true`) ARE included in the chain when the drill target is inside an instance expansion. The chain prefix is still the page-resident outer INSTANCE; intermediate entries are master-page guids reached through `_renderChildren`. Single-click on a master subtree still bubbles to the outer INSTANCE (so a plain click selects the instance as a unit) — only the double-click handler captures the master child guid and runs it through the resolver.
- I-C4 (v2) The chain is built from a single pre-computed ancestor index (`buildAncestorIndexDeep(page)` in `web/core/domain/tree.ts`) that walks **both** `.children` AND `_renderChildren`. The non-deep `buildAncestorIndex` stays in place for the LayerTree (which treats instance bodies as collapsed surfaces). No re-walk per click.

## 3. Click → selection mapping (pure function)

`resolveDrillSelection(chain, current, kind)` returns the next selected guid:

| `kind`     | `current` state                              | Result                                     |
|------------|----------------------------------------------|--------------------------------------------|
| `click`    | `current` not in `chain` (or null)           | `chain[0]` (outermost root-level container) |
| `click`    | `current === chain[i]` for some `i` (v2)     | `current` unchanged — drill state is sticky |
| `dblclick` | `null` (nothing selected)                    | `chain[1]` if length ≥ 2, else `chain[0]`   |
| `dblclick` | `current` not in `chain` (v2)                | `chain[1]` if length ≥ 2, else `chain[0]`   |
| `dblclick` | `current === chain[i]`, `i < last`           | `chain[i + 1]` (one level deeper)           |
| `dblclick` | `current === chain[last]`                    | `current` unchanged (already at hit; no-op) |

Empty chain (defensive) returns `null` — no selection.

- I-R1 The function is **pure** and lives in `web/core/domain/drillSelection.ts`. No React, no Konva, no DOM.
- I-R2 The function is the **single source of truth** for canvas drill semantics. The LayerTree's existing I-F14 drill (in `LayerTree.tsx:onRowDoubleClick`) is a sibling implementation of the same model on a different surface — `chain` there is `[directChildOfRow]` (only one element), so the function is overkill for that surface and keeps its current inline logic. A future round may unify them.

## 4. Event plumbing on canvas

- I-E1 Each `NodeShape` wires Konva's `onClick` / `onTap` AND `onDblClick` / `onDblTap`. Both call `e.cancelBubble = true` at the deepest *targeted* node (rules below differ by event), so Konva stops walking the parent chain and the resolver sees exactly one node per gesture.
- I-E2 (v2) `onClick` handler runs on the deepest listening hit shape — including master-subtree descendants. The master-subtree → outer-INSTANCE bubble used in v1 has been removed; the resolver's chain-aware semantics give the same first-click result (chain[0] = outer INSTANCE) without losing drill state on the trailing click of a multi-step double-click sequence:
  1. `e.cancelBubble = true`.
  2. Compute `chain = [...buildAncestorIndexDeep(page).get(guid) ?? [], guid]`.
  3. `nextGuid = resolveDrillSelection(chain, currentSelectedGuid, 'click')`.
  4. Dispatch `onSelect(nextGuid, shift ? 'toggle' : 'replace')`.
  - Hover still bubbles for master subtrees (parallel rule in `web-canvas-hover-tooltip.spec.md` §I-S5), so hover UX is unaffected.
- I-E3 (v2) `onDblClick` handler does NOT short-circuit on `_isInstanceChild` — drilling into an instance is the whole point of the gesture. It cancelBubbles at the deepest hit (so we don't also fire the outer INSTANCE's dblclick afterward) and forwards `kind: 'dblclick'` to the resolver. The deep ancestor index handles the rest.
- I-E4 Shift-click semantics are unchanged: `shift` still toggles; the chain-resolved guid is what gets toggled. (Multi-select drilling is not a Figma concept and is out of scope for v1.)
- I-E5 Drag start (`onDragStart`) uses the already-selected node — drill mapping does NOT run on drag. The existing `dragSnapshotApi` flow is untouched.

## 5. Inspector + selection bounds support (v2)

When the canvas drill lands on a master-page guid (i.e. a node only reachable through some INSTANCE's `_renderChildren` in the current page), the rest of the editor needs to find that node too:

- I-IS1 `Inspector` swaps its `findById(page, guid)` lookup for `findByIdDeep(page, guid)` (defined in `web/core/domain/tree.ts`). The deep variant walks both `.children` and `_renderChildren`, so it returns the instance-specific copy produced by `toClientChildForRender` (with overrides already applied — what the user expects from a canvas selection).
- I-IS2 `Canvas.tsx:findAbsBounds` also walks `_renderChildren` (accumulating transforms the same way) so the blue selection overlay frames the correct rect.
- I-IS3 `App.tsx:handleSelect`'s fallback (`!findById(doc, guid) → findOuterInstanceFor(guid)`) keeps working unchanged: master-page guids are findable through `doc.children` (master page is in the doc tree), so the substitution branch doesn't fire and the master-page guid passes through to the consumers above.

## 6. Out-of-scope

- O-1 No "isolated container" / Esc-to-exit mode. The drill is per-click and does not stash a persistent "I'm inside frame X" context — though I-E2 step 1 (single-click preserves an in-chain selection) gives the same *practical* feel: once you've drilled in, ordinary clicks inside that subtree do not blow your selection away.
- O-2 (v2 — closed) Drill INTO an INSTANCE's `_renderChildren` is supported. Editing those nodes still goes through the existing master-edit code path (no per-instance override edit gesture yet); the selection is selectable and inspectable, but Inspector edits affect the master and propagate to every instance.
- O-3 Marquee-drag selection ignores drill — it selects the topmost root-level frames intersecting the marquee (same as today).
- O-4 Triple-click / `Cmd`-click / `Alt`-click variants left untouched.

## 7. Test invariants (asserted in `drillSelection.test.ts`)

- T-1 Single click with chain `[A, B, C]` from no-selection or unrelated → returns `A`.
- T-1b (v2) Single click preserves an in-chain `current` (`B → B`, `C → C`) so a follow-up double-click can step deeper without being reset by the trailing click of the gesture.
- T-2 Double-click with chain `[A, B, C]` and `current = null` → returns `B`.
- T-3 Double-click with chain `[A, B, C]` and `current = A` → returns `B`; `current = B` → returns `C`; `current = C` → returns `C` (no-op at leaf).
- T-4 Double-click with chain `[A]` and `current = A` → returns `A` (single-element chain is always at leaf).
- T-5 (v2) Double-click with `current` not in chain → returns `chain[1]` if length ≥ 2 else `chain[0]` (matches Figma's behaviour when a rapid double-click crosses subtrees).
- T-6 Empty chain → returns `null` for both kinds.
