# spec/web-canvas-hover-tooltip

| Item | Value |
|---|---|
| Status | Approved (v2 — Konva-rendered border + label pill) |
| Implementation | hover state in `web/client/src/Canvas.tsx` + `web/client/src/components/canvas/HoverOverlay.tsx` |
| Tests | `web/client/src/components/canvas/HoverOverlay.test.tsx` |
| Siblings | `web-left-sidebar.spec.md` (a separate system from selection sync / auto-reveal) |

## 1. Goal

When the mouse hovers over a canvas node, display its identification info as a small tooltip — identical to Figma's hover affordance. Before the user clicks to select, they can preview the node's name and size.

Background:
- In large designs like the 35K-node meta-rich fixture, it is hard to tell which component is which by looking at the canvas alone (names are not visible).
- The Inspector only shows the *selected* node — a hover-only identification surface is needed separately.

## 2. Display content (v2 — Figma-style canvas overlay)

```
┌──┬──────┐ ← name pill at top-left of bbox
│  │ Card │
└──┴──────┘
┌────────────────────┐
│                    │ ← 1px stroke around bbox (no fill)
│                    │
└────────────────────┘
```

- I-T1 **Border**: a stroke-only Konva.Rect surrounding the node bbox. fill = transparent. stroke = primary color (same tone as Figma's #0a84ff). strokeWidth = `1 / scale` to remain 1px regardless of zoom.
- I-T2 **Name pill**: a small Konva.Group outside the bbox at its top-left — a primary-color Rect background + white Konva.Text for the node name. Position = `(bbox.x, bbox.y - pillHeight)` (the label floats slightly above the node). If the top-left would clip outside the stage (negative y), the label is pushed inside the node (`bbox.y`) — same behavior as Figma.
- I-T3 Label text = `node.name`. Empty names render as `<unnamed>`. No length truncation (matches Figma).
- I-T4 Label / border color matches the selection overlay color (`#0a84ff`) — Figma also uses the same color for hover/select.
- I-T5 **No hover overlay on already-selected nodes** — the selection overlay already occupies the same area; avoids duplicate display.

## 3. Position (Konva-rendered)

- I-P1 The hover overlay is drawn in the **same Layer as the selection overlay** (z-order on top of canvas content, same level as selection). Stage transform (offset/scale) is inherited automatically, so it moves with nodes during pan/zoom without extra math.
- I-P2 Bbox coordinates = `hover.designBbox` (already stage-local design coordinates) plugged directly into Konva.Rect's x/y/width/height.
- I-P3 Label font / padding / thickness are all zoom-corrected (`1/scale`, `12/scale`, etc.) — pixel-constant regardless of zoom.

## 4. State

- I-S1 The `Canvas` component holds `hoveredGuid: string | null` state.
- I-S2 NodeShape Konva events:
  - `onMouseEnter(e)` → `setHoveredGuid(guidStr(node.guid))`. Sets `e.cancelBubble = true` so the parent node's onMouseEnter does not overwrite it — the deepest node owns the hover.
  - `onMouseLeave(e)` → `setHoveredGuid((cur) => cur === thisGuid ? null : cur)`. If the cursor entered a different node immediately, that node's onMouseEnter has already updated state; only clear when the current entry is still self.
- I-S3 Hover is disabled while dragging (from drag start to drag end) — `onDragStart` calls `setHoveredGuid(null)`; mouseEnter events during drag are ignored (Konva does not fire them while dragging anyway).
- I-S4 When the cursor leaves the stage entirely (`onMouseLeave` on Stage), the tooltip is hidden.
- I-S5 When hovering over an INSTANCE's master descendant (vector/icon expanded via `_renderChildren`), set the hovered guid to the **outer instance**, not the descendant — from the user's perspective the instance is a single unit (matches Figma). Implementation: nodes flagged `_isInstanceChild` skip hover by not registering the handler at all (so the event propagates through to outer instead of cancelBubble).

## 5. Render (v2 — Konva)

- I-R1 The hover overlay renders via **Konva** (`HoverOverlay.tsx`) — placed in the same Layer as the selection overlay. In-canvas display matching Figma. (v1's DOM tooltip is deprecated.)
- I-R2 If `hover === null` or `selectedGuids.has(hover.guid)`, the component returns `null` — no empty node created.
- I-R3 `listening = false` — the overlay must not intercept mouse events (NodeShape's hover handlers must continue to fire).
- I-R4 z-order: in the same Layer as the selection overlay, render order = after selection (later in code). When a node is both selected and hovered, I-R2 suppresses the hover, so there is no conflict.
- I-R5 Color: `#0a84ff` (matches selection). Label text is white.

## 6. Performance

- I-PE1 Uses mouseEnter/Leave only — no mousemove handler. These fire only on boundary crossings, so the cost stays negligible even at 35K nodes.
- I-PE2 hoveredGuid changes go through React state once — Canvas re-renders, but NodeShape can rely on simple prop comparison rather than the useSyncExternalStore pattern used by useIsSelected (hover state changes do not alter NodeShape props — hover info is owned by Canvas). NodeShape memoization is preserved.

## 7. Out of scope (v1)

- Keyboard-only hover triggering (focus-based tooltip) — mouse only.
- Mobile / touch — the canvas itself is not touch-first.
- Tooltip fade-in / fade-out transition — instant show / hide.
- Multi-line content (text content preview, color swatch, etc.) — name + type + size only.
- Action buttons inside the tooltip (Go to / Rename) — informational only.
- Visual distinction between hover and selection overlay — selection overlay and hover tooltip are different surfaces; same color is acceptable.

## 8. Resolved questions

- **DOM overlay vs Konva.Label** — DOM. Konva.Label is inside the Stage and follows pan automatically, but text rendering / auto width measurement is constrained by Konva's limits. A DOM overlay only needs a transform function each render to stay in sync.
- **Bbox computation — direct node.transform vs Konva node.getClientRect()** — Use `getClientRect()`. Konva already accumulates ancestor transforms, which is more accurate than our own math.
- **Hover display while dragging** — disabled (I-S3). The drag indicator is already visually sufficient — an additional tooltip following along would obscure the view.
