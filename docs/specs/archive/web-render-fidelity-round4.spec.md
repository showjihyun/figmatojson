# spec/web-render-fidelity-round4

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | the default Rect branch in `web/client/src/Canvas.tsx` + `web/client/src/lib/gradient.ts`, `web/client/src/lib/paint.ts` |
| Tests | `web/client/src/lib/gradient.test.ts`, `web/client/src/lib/paint.test.ts` |
| Parents | rounds 1~3 (typography / strokeAlign / clip / shadow / rotation / opacity / cap-join) |

## 1. Purpose

Three universal Figma features — **gradient fills (LINEAR / RADIAL)**, **correct top-paint selection across multiple paints**, and **dashPattern (dashed strokes)**. All are standard fields defined in Figma's public data model. No file-specific heuristics.

## 2. Gradient fills

### 2.1 Field shape

```ts
paint: {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND'
  visible: boolean
  opacity?: number              // paint-level alpha multiplier
  blendMode?: string
  stops: Array<{ color: { r,g,b,a }, position: number }>   // position 0..1
  transform: {                  // 2x3 matrix mapping unit gradient space → bbox-normalized
    m00, m01, m02, m10, m11, m12
  }
}
```

### 2.2 Coordinate model

Figma's gradient coordinate system:
- Unit gradient space: the t-axis is the line from (0, 0.5) to (1, 0.5). Stops lie along the center line.
- `paint.transform` is an affine mapping this space into bbox-normalized space (0..1, 0..1).

Konva expects **node-local pixel coordinates** (0..w, 0..h). Hence a two-step transform:
1. unit point → bbox-normalized: `applyTransform(paint.transform, point)`
2. bbox-normalized → pixel: `(p.x * w, p.y * h)`

### 2.3 LINEAR gradient

- I-G1 Start point (Konva `fillLinearGradientStartPoint`): `applyTransform(paint.transform, (0, 0.5))` × `(w, h)`.
- I-G2 End point (`fillLinearGradientEndPoint`): `applyTransform(paint.transform, (1, 0.5))` × `(w, h)`.
- I-G3 Color stops (`fillLinearGradientColorStops`): flat array `[pos1, css1, pos2, css2, ...]` where `cssN = rgbaToCss(stops[N].color, paint.opacity)`. Position passes through as `stops[N].position` (Konva also uses 0..1).

### 2.4 RADIAL gradient

- I-G4 Start point (center, `fillRadialGradientStartPoint`): `applyTransform(paint.transform, (0.5, 0.5))` × `(w, h)`.
- I-G5 End point (`fillRadialGradientEndPoint`) = same as start (a radial gradient's end position equals its center; Konva expresses the extent through startRadius~endRadius).
- I-G6 startRadius = 0; endRadius = distance between `(1, 0.5)` and `(0.5, 0.5)` in bbox-normalized space scaled by bbox size — `dx = m00*0.5 = halfWidth_in_paint_space`, similar for dy. Formula: `radius = sqrt((m00*0.5)² * w² + (m10*0.5)² * h²)`. Simplified: `radius = sqrt((dx*w)² + (dy*h)²)` where `(dx, dy) = applyTransform(t, (1, 0.5)) - applyTransform(t, (0.5, 0.5))`.
- I-G7 Color-stops format is identical to LINEAR.

### 2.5 ANGULAR / DIAMOND

- I-G8 Konva does not natively support angular / diamond. v1 fallback: use the paint's first stop color (composited with paint.opacity) as if SOLID. There will be a visual difference compared to Figma, but node identification is preserved.

### 2.6 Helper

```ts
// lib/gradient.ts
export function gradientFromPaint(paint, w, h): KonvaGradient | null
```

Returns:
- LINEAR / RADIAL — Konva fill props (start, end, color stops, radii)
- ANGULAR / DIAMOND — `null` (caller handles the first-stop fallback)
- otherwise / invalid paint — `null`

## 3. Multi-paint: top-paint selection

### 3.1 Background

Figma's `fillPaints` array is **stacked bottom-up** — `fillPaints[0]` is the bottom-most, `fillPaints[N-1]` is the top-most (the face the user sees). The previous `solidFillCss` picked the *first* visible SOLID — i.e. it picked the bottom paint, so the *covering effect of the upper paint* was lost.

### 3.2 Correction rule

- I-MP1 `pickTopPaint(fillPaints)` = scan `fillPaints` **in reverse**; return the first entry that is `visible !== false` and not IMAGE (i.e. the top-most non-image paint).
- I-MP2 If every paint is IMAGE or hidden, return `null` → caller falls back to `transparent` or image fill.
- I-MP3 IMAGE is handled separately (the `ImageFill` component already exists). `pickTopPaint` skips IMAGE.
- I-MP4 **Full multi-paint stacking** (alpha blending, gradient-over-solid, etc.) is out of scope for v2. We apply only the top paint here.

### 3.3 Caller wiring

In `Canvas.tsx`'s default Rect branch:
1. `top = pickTopPaint(node.fillPaints)`
2. `top.type === 'SOLID'` → fill = rgba string
3. `top.type === 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'` → fill = gradient props (accepted by Konva.Rect)
4. `top` is GRADIENT_ANGULAR/DIAMOND → first-stop solid fallback
5. `top === null` → `transparent` (no fill)

## 4. dashPattern

### 4.1 Field shape

```ts
node.dashPattern?: number[]   // e.g. [10, 5] → 10 px filled, 5 px gap, 10 px filled, ...
```

### 4.2 Konva mapping

- I-DP1 If `node.dashPattern` is a **non-empty array**, pass it through unchanged as the `dash` prop on every stroke-bearing Konva element (Rect / Path / per-side Line).
- I-DP2 If `dashPattern` is an empty array or missing → omit the `dash` prop (solid stroke).
- I-DP3 No even-length normalization needed — Konva handles odd-length arrays by repeating.

## 5. Out of scope (v1)

- **Multi-paint stacking** — true alpha-blended compositing across paints. Today only the top paint shows. Most of the 12 affected nodes are simple "light-blue over white" arrangements where the top paint is already the right answer.
- **GRADIENT_ANGULAR / GRADIENT_DIAMOND** — Konva does not support these; falls back to first-stop solid.
- **Multi-paint combinations with image fills** — IMAGE + SOLID stacks could be split into ImageFill + Rect, but deferred to a separate round.
- **Stroke gradients** — when `strokePaints` contain a GRADIENT. Almost absent from the data distribution.
- **Skew / rotation matrices inside gradient transform** — `applyTransform` handles every affine (rotated gradients work). Konva's gradients are always straight / circular, however, so skewed inputs can render slightly off.

## 6. Resolved questions

- **Direction of gradient transform interpretation** — Figma maps unit gradient space → bbox-normalized. start = `t(0, 0.5)`, end = `t(1, 0.5)`. The official spec, the figma-js library and our fig-kiwi analysis all agree.
- **Multi-paint: first vs last** — In Figma's UI, "Add fill" inserts at the *top* of the stack, so array[N-1] is visually on top. The old `solidFillCss` first-pick was simply a PoC oversight. Fixed here.
- **Scope of dashPattern** — Konva's dash prop only affects strokes (fills are untouched). Even when dashPattern is set, the fill renders normally — same as Figma.
