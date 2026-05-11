# spec/web-render-fidelity-round3

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | 3 render branches in `web/client/src/Canvas.tsx` + `web/client/src/lib/transform.ts`, `web/client/src/lib/strokeCapJoin.ts` |
| Tests | `web/client/src/lib/transform.test.ts`, `web/client/src/lib/strokeCapJoin.test.ts` |
| Parents | `web-render-fidelity-high.spec.md`, `web-render-fidelity-round2.spec.md` |

## 1. Purpose

Add three of Figma's **universal features** — rotation, layer opacity, stroke cap/join — to the render pipeline. All are fields already present in the .fig data but ignored by the Canvas. After this round, most design files render without obvious additional issues.

**No file dependence** — every invariant here covers only fields defined in Figma's public data model; there are no heuristics specific to any sample (`meta-rich`, `bvp.fig`). All tests use synthetic fixtures.

## 2. Rotation

### 2.1 Field shape

Figma's `transform` is a 2x3 affine matrix:
```
[ m00 m01 m02 ]    [ scaleX*cos(θ)  -scaleY*sin(θ)  tx ]
[ m10 m11 m12 ]  ≈ [ scaleX*sin(θ)   scaleY*cos(θ)  ty ]
```

Default (translation only): `m00=1, m01=0, m10=0, m11=1`.

### 2.2 Rotation extraction

- I-R1 `rotationDegrees(transform)` extracts the rotation angle:
  - From `m00`, `m10`, compute `atan2(m10, m00)` (radians) → degrees.
  - Clamp to 0 if within ±0.01° (avoid floating-point noise).
  - Return `undefined` for the identity (`m00===1 && m01===0 && m10===0 && m11===1`).
- I-R2 **Pure-rotation detection**: when skew or non-uniform scale is mixed in, plain rotation alone cannot draw the node correctly. `isPureRotation(transform)` returns true when all of the following hold:
  - `m00 ≈ m11` (uniform scale, usually 1)
  - `m01 ≈ -m10` (rotation only, no skew)
  - tolerance ±0.001
- I-R3 If `isPureRotation === false` (skew / non-uniform), this round does not apply rotation — only translation is applied (original behavior). Raw matrix transforms are a candidate for a future round.

### 2.3 Konva mapping

- I-RM1 Add a `rotation={deg}` prop to the outer Konva element (KText for TEXT, Group for VECTOR, Group for generic nodes).
- I-RM2 Konva rotates around the node's `(x, y)` position as pivot — Figma's transform also positions to the parent origin and then rotates around that point, so the visuals match.
- I-RM3 Omit the prop when `rotation === undefined` (Konva default is 0).
- I-RM4 When a rotated node has children (FRAME etc.), the child transforms are already baked into the rotated parent coordinate space, so no extra work is needed — Konva propagates parent rotation to children automatically.

## 3. Layer opacity

### 3.1 Field shape

```ts
node.opacity?: number   // 0..1, default 1
```

### 3.2 Konva mapping

- I-OP1 Add an `opacity={node.opacity}` prop to the outer Konva element. Omit when `undefined` or `1`.
- I-OP2 Draw even when `opacity === 0` — the node is invisible but still takes layout space (matches Figma). Nodes with `visible === false` are already short-circuited to `null` by the guard at the top of the NodeShape impl.
- I-OP3 When a child node has its own opacity, Konva automatically multiplies it with the parent's (e.g. parent 0.5, child 0.5 → final 0.25). Matches Figma.
- I-OP4 Paint-level opacity on fillPaints / strokePaints is separate — a paint that carries its own `opacity` already pre-multiplies its color. The opacity in this spec is *layer-level* only.

## 4. strokeCap / strokeJoin

### 4.1 Field shape

```ts
node.strokeCap?:  'NONE' | 'ROUND' | 'SQUARE' | 'LINE_ARROW' | 'TRIANGLE_ARROW'
node.strokeJoin?: 'MITER' | 'ROUND' | 'BEVEL'
```

### 4.2 Konva mapping

- I-SC1 strokeCap mapping (Konva.Path/Line `lineCap`):
  - `'NONE'` → `'butt'` (or omit — Konva defaults to butt)
  - `'ROUND'` → `'round'`
  - `'SQUARE'` → `'square'`
  - `'LINE_ARROW'` / `'TRIANGLE_ARROW'` → unsupported (out of scope for v1). Fall back to butt.
- I-SC2 strokeJoin mapping (Konva.Path/Line `lineJoin`):
  - `'MITER'` → `'miter'` (or omit)
  - `'ROUND'` → `'round'`
  - `'BEVEL'` → `'bevel'`
- I-SC3 Scope — VECTOR `Path` branch and the 4 `Konva.Line` of per-side strokes. A generic Rect stroke defaults to MITER for lineJoin, but ROUND/BEVEL can interact with cornerRadius — Konva.Rect also accepts a `lineJoin` prop.

## 5. Implementation guard rails

- I-IM1 Change surface is the 3 render branches in `Canvas.tsx` + the two helper files. No other layer changes.
- I-IM2 NodeShape memoization is unaffected — all added props derive from `node`.
- I-IM3 Selection / hover overlay positioning — a rotated node's bbox is no longer axis-aligned after rotation, but in this round the selection overlay is drawn against the *pre-rotation* bbox (so it appears slightly off). Accurate OBB rendering is deferred to a separate round.

## 6. Out of scope (v1)

- **Skew / non-uniform scale transforms** — the `isPureRotation === false` case. Drawing this accurately requires setting a raw transform matrix on Konva.Group, which react-konva does not expose directly. Deferred (rarely used).
- **Selection / hover overlay on rotated nodes** — the axis-aligned bbox overlay does not fully follow a rotated node. Deferred.
- **strokeCap LINE_ARROW / TRIANGLE_ARROW** — unsupported in Konva. Drawing arrows would require an extra shape.
- **Path miterLimit** — use Konva's default.
- **Combinations of strokeAlign INSIDE/OUTSIDE with rotation** — round 2's strokeAlign transform (adjusting rect dims) still works correctly after rotation (Konva applies it in the pre-transform coordinate space). No special handling needed.

## 7. Resolved questions

- **How much skew exists in the data?** 0 of 35K nodes in meta-rich. bvp.fig should be similar (design files typically rotate only). Punting to a future round is safe.
- **Does Konva's rotation pivot match Figma?** Yes. Konva `rotation` pivots around `(x, y)`, and Figma transform also rotates around the parent origin (= the node's x/y). Setting `offsetX/Y` would change the pivot, so this spec does not use `offsetX/Y`.
- **Relationship between opacity and fill alpha** — Konva multiplies the two (same as Figma). No special handling needed.
