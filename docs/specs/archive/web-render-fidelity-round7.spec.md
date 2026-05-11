# spec/web-render-fidelity-round7

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Canvas.tsx` (findAbsBounds + SelectionOverlay + Hover wiring) + `web/client/src/components/canvas/HoverOverlay.tsx` + `web/client/src/lib/blendMode.ts` |
| Tests | `web/client/src/lib/blendMode.test.ts`, `web/client/src/components/canvas/HoverOverlay.test.tsx` (expanded) |
| Parents | rounds 1~6 |

## 1. Purpose

Two universal Figma features — **OBB selection/hover overlay for rotated nodes** and **per-paint blendMode**. Both are defined as standard in the .fig data, with no file-specific heuristics.

In previous rounds the node itself rotates correctly (round 3), but the selection / hover overlay is drawn as an axis-aligned bbox and cannot follow a rotated node — this round aligns them. The paint blendMode completes the multi-paint stacking contract — stacked paints can composite using modes beyond NORMAL.

## 2. OBB rotated overlay

### 2.1 Background

Today:
- The node itself rotates correctly via round 3's `rotationDegrees` + the Konva Group rotation prop.
- SelectionOverlay receives the axis-aligned `{x, y, w, h}` returned by `findAbsBounds` and draws without rotation info.
- HoverOverlay receives `e.target.getClientRect({relativeTo: stage})` AABB and draws without rotation info.

Result: an axis-aligned rectangle floats over a rotated node and visually misaligns.

### 2.2 Solution

- I-OB1 Extend `findAbsBounds(root, guid, ...)` to return `{x, y, w, h, rotation}`. `rotation` = the leaf node's rotation angle (`rotationDegrees(node.transform) ?? 0`).
- I-OB2 Add `rotation: number` to SelectionOverlay's props. Apply `rotation={rotation}` to its outer Konva Group. Konva pivots around the group's `(x, y)`.
- I-OB3 Add `rotation: number` to HoverOverlay (props `bbox + name + scale`). Apply the same way on its outer Group. The caller (Canvas) stores rotation in hover state too.
- I-OB4 Extract rotation in hoverApi.enter:
  - Call `rotationDegrees` on the node's transform.
  - Hover state's `designBbox` is the *pre-rotation* axis-aligned bbox (= node.transform.m02/m12 + size). `e.target.getClientRect({relativeTo: stage})` returns the post-rotation AABB and is inaccurate for rotated nodes. New path: `e.target.x()` / `e.target.y()` (Konva node's set values) + `node.size`.
- I-OB5 **Nested ancestor rotation is out of scope for v1** — only the leaf's rotation is reflected. If a parent FRAME is rotated, the selection overlay may be inaccurate (no such case in meta-rich, and it is rare in typical design files).

### 2.3 OBB for multi-select

- I-OB6 In multi-select (group bbox + corner handles) — members can each have different rotations, so the group bbox itself cannot be made an OBB. v1: multi-select stays axis-aligned (current behavior). Can evolve into a union-of-OBBs in a separate round.
- I-OB7 **Resize handles are rendered only when rotation === 0** (v1). Corner-drag resize on a rotated node needs an additional local-↔-parent coordinate transform matrix; deferred to a separate round. A rotated node shows only the outline + size badge. Users can resize via the inspector (current behavior).

## 3. Paint blendMode

### 3.1 Field shape

```ts
paint: {
  type: ...,
  visible: boolean,
  opacity: number,
  blendMode?: 'NORMAL' | 'DARKEN' | 'MULTIPLY' | 'COLOR_BURN' | 'LIGHTEN' | 'SCREEN' | 'COLOR_DODGE' | 'OVERLAY' | 'SOFT_LIGHT' | 'HARD_LIGHT' | 'DIFFERENCE' | 'EXCLUSION' | 'HUE' | 'SATURATION' | 'COLOR' | 'LUMINOSITY' | 'PASS_THROUGH'
}
```

### 3.2 Konva mapping

- I-BM1 `konvaBlendMode(figma)` (lib/blendMode.ts):
  - 'NORMAL' / undefined → undefined (omit prop).
  - 'PASS_THROUGH' → undefined (Figma's PASS_THROUGH means "let the group composite through to the parent" — has no meaning for a single paint; fall back to undefined).
  - Otherwise → kebab-case CSS / canvas mode name:
    - DARKEN → 'darken', MULTIPLY → 'multiply', COLOR_BURN → 'color-burn', LIGHTEN → 'lighten', SCREEN → 'screen', COLOR_DODGE → 'color-dodge', OVERLAY → 'overlay', SOFT_LIGHT → 'soft-light', HARD_LIGHT → 'hard-light', DIFFERENCE → 'difference', EXCLUSION → 'exclusion', HUE → 'hue', SATURATION → 'saturation', COLOR → 'color', LUMINOSITY → 'luminosity'.
- I-BM2 Apply: every paint Rect in the multi-paint stack gets `globalCompositeOperation={konvaBlendMode(paint.blendMode)}`. The Konva.Image inside ImageFill gets the same.
- I-BM3 The first paint (i === 0) has a transparent underlying canvas, so its blendMode produces the same result as NORMAL. We still pass the prop through unchanged (no special case).

## 4. Out of scope (v1)

- **Multi-select OBB**: union over each member's rotation. Separate round.
- **Accumulated nested ancestor rotation**: when a parent FRAME is rotated, the leaf's absolute rotation = parent + child. v1 uses only the leaf.
- **Skew transforms**: same as the round 3 punt — `isPureRotation === false` falls back to rotation 0.
- **Layer-level blendMode** (`node.blendMode`): blendMode for the entire node (not a paint). The same mapping function can be reused — a separate round when encountered.

## 5. Resolved questions

- **Konva Group rotation pivot**: rotates around the `(x, y)` position. Place SelectionOverlay's outer Group at the node's `(x, y)` and apply rotation → visually matches the node exactly.
- **Does `globalCompositeOperation` work on a transparent canvas?**: yes, this is standard canvas behavior. Blending previously-drawn pixels with a new paint follows the usual compositing rules (multiply, screen, etc. are all standard).
- **Handling PASS_THROUGH**: Figma's group PASS_THROUGH delegates compositing to the parent and has no meaning at the *paint* level — ignored.
