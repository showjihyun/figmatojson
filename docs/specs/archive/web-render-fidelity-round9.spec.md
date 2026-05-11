# spec/web-render-fidelity-round9

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Canvas.tsx` (children grouping + outer Group blendMode) + `web/client/src/lib/blurEffect.ts` + `web/client/src/components/canvas/LayerBlurWrapper.tsx` |
| Tests | `web/client/src/lib/blurEffect.test.ts` |
| Parents | rounds 1~8 |

## 1. Purpose

Three universal Figma features — **LAYER_BLUR**, **isMask** (mask layer), and **node-level blendMode**. All standard Figma, no file-specific heuristics. 0 occurrences in the meta-rich dataset, but the behavior is standard and applies to any .fig.

## 2. LAYER_BLUR

### 2.1 Field shape

```ts
effects: Array<{
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR',
  visible: boolean,
  radius: number,        // blur in px
  blendMode?: string,
  ...
}>
```

LAYER_BLUR blurs the node itself (pixels that leak out are also blurred). BACKGROUND_BLUR blurs the pixels *behind* the node (frosted glass) — the latter needs a canvas snapshot + composite and is out of scope for v1.

### 2.2 Konva implementation

- I-LB1 `layerBlurFromEffects(effects)` returns the `radius` of the first entry with `type === 'LAYER_BLUR' && visible !== false && (blendMode === 'NORMAL' || undefined)`. Null otherwise.
- I-LB2 The `LayerBlurWrapper` component wraps children in `<Group ref>` and inside `useEffect`:
  - `g.cache()` — cache the Group's children to a bitmap.
  - `g.filters([Konva.Filters.Blur])`.
  - `g.blurRadius(r)`.
  - When r changes, re-cache + reapply the filter.
- I-LB3 Cache cost: only on NodeShapes that have blur applied — in a file like meta-rich with 0 LAYER_BLUR, the path is never even activated.
- I-LB4 BACKGROUND_BLUR is ignored in v1 (no-op). Candidate for a future round.

## 3. isMask

### 3.1 Figma's mask model

In Figma, a node with `isMask: true` clips its *immediately following siblings* with its own shape. That is, the parent's children in the range [maskIndex+1 ... next isMask or end] are inside the mask's scope.

### 3.2 Render

- I-MK1 In NodeShape's children loop, when a node has `isMask: true`:
  1. Render the mask node normally (existing path).
  2. Group the following children (until the next mask or the end) inside a Konva.Group whose `clipFunc` is set to the mask node's geometry.
- I-MK2 Mask geometry: rect with cornerRadius for RECTANGLE/FRAME; Path data for VECTOR; axis-aligned bbox fallback for other types.
- I-MK3 The mask node's own visuals (fill / stroke) are preserved — same as Figma.
- I-MK4 v1 limitation: the mask node's transform (rotation / translation) accurately propagates to the clip path in the children's local frame. The children loop is a simple array slice and is efficient.

## 4. Layer-level blendMode

### 4.1 Field

```ts
node.blendMode?: 'NORMAL' | 'PASS_THROUGH' | 'MULTIPLY' | ...
```

- I-NB1 Pass `konvaBlendMode(node.blendMode)` as `globalCompositeOperation` on NodeShape's outer element (Group / KText / Path).
- I-NB2 `PASS_THROUGH` is Figma's group default — delegate compositing to the parent. Konva has no direct mapping. v1: treat as undefined (= regular source-over). Children inside the group blend individually, so the visual difference is minimal.

## 5. Out of scope (v1)

- BACKGROUND_BLUR — needs a canvas snapshot + separate composite. Separate round.
- Multiple LAYER_BLURs (Konva has a single cache only).
- Children when the mask node has visible=false — Figma still clips. In v1, visible=false → the mask itself returns null → children render unclipped. Will be fixed when encountered.
- The mask node's fillPaints affecting the mask path — v1 uses geometry only, ignores fill (same as Figma).

## 6. Resolved questions

- **blendMode of LAYER_BLUR**: Konva.Filters.Blur cannot composite correctly for anything other than NORMAL. We handle NORMAL only; everything else is ignored — all meta-rich entries are NORMAL anyway.
- **Mask geometry by type**: RECTANGLE/FRAME = rounded rect, VECTOR = path data, ELLIPSE = ellipse path. Everything else (TEXT/INSTANCE) → bbox. There are 0 masks in meta-rich, so verification uses synthetic fixtures.
- **PASS_THROUGH mapping**: delegates the group's compositing mode to the parent — no exact equivalent in Konva. Treat as undefined (= ordinary compositing). The visual difference only appears when the group contains a non-NORMAL child: the child's globalCompositeOperation re-composites in the parent, while PASS_THROUGH would delegate one more time — the actual result may differ. To be refined in a separate round.
