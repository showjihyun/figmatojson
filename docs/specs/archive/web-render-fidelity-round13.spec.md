# spec/web-render-fidelity-round13

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/lib/strokeAlign.ts` (`applyStrokeAlignToVectorPath`) + `web/client/src/Canvas.tsx` (VECTOR branch) |
| Tests | `web/client/src/lib/strokeAlignVector.test.ts` |
| Parent | round 2 (the explicit v1 out-of-scope item in §I-SA5) |
| Siblings | round 11 (path inset), round 12 (path scale) |

## 1. Background

`web-render-fidelity-round2.spec.md §I-SA5` explicitly leaves *strokeAlign not applied to the VECTOR Path branch* (rationale: SVG `stroke-alignment` is non-standard and Konva lacks native support). As a result, vector nodes with `strokeAlign === 'INSIDE'` are drawn with Konva's default CENTER stroke, with half of the stroke outside the path. In the HPAI fixture, `2625:1343 ELLIPSE "Ellipse 150"` is exactly this case:

| Field | Value |
|---|---|
| size | 80×80 |
| normalizedSize | 80×80 (round 11/12 inactive) |
| fillPaints | SOLID white |
| strokePaints | SOLID red (`#ED0000`) |
| **strokeWeight** | **5** |
| **strokeAlign** | **`INSIDE`** |
| effects | DROP_SHADOW |

Figma intent: an 80 px diameter white circle whose outer edge is exactly 80, with red only on the inner 5 px. Current behavior: 85 px diameter (2.5 px outset on each side of the stroke) white circle + red outline → overall larger, and the stroke escapes the frame.

## 2. Konva paint-order plumbing

Konva.Path lacks a native `stroke-alignment` prop, but there are two paint-order plumbing options:

| Konva mode | Draw order | Visual result (CENTER stroke baseline) |
|---|---|---|
| default (`fillAfterStrokeEnabled=false`) | fill → stroke | the *inside half* of the stroke is drawn over the fill. Outside half + inside half both visible (CENTER) |
| `fillAfterStrokeEnabled=true` | stroke → fill | fill covers the *inside half* of the stroke. **Only the outside half is visible** ⇒ **OUTSIDE effect** |
| Group `clipFunc(path)` wrap | children clipped to the path shape | the *outside half* of the stroke is clipped. **Only the inside half remains** ⇒ **INSIDE effect** |

Therefore:
- **INSIDE**: set up a Konva.Group `clipFunc` defining a clip area inside the path, with the child Konva.Path's strokeWidth doubled. The clip removes the outer half, leaving only the inner half = original strokeWidth.
- **OUTSIDE**: `fillAfterStrokeEnabled=true` + doubled strokeWidth. The fill covers the inner half, leaving only the outer half = original strokeWidth.
- **CENTER / unset**: pass-through (Konva default).

(Note: the round 13 emulation mapping was corrected twice.
- **round 13.0**: mapped INSIDE to `fillAfterStrokeEnabled=true` — but Konva's source (`Context.fillStrokeShape`) runs stroke→fill, so the result is *outside-only*. Direction was reversed.
- **round 13.1**: switched INSIDE to a Group `clipFunc` wrap. But inside clipFunc we called `ctx.fill(path2d)` — *which actually drew something* in the default fillStyle (black), regressing the ELLIPSE to all-black.
  Konva clipFunc must only define a sub-path; you can return an argument tuple for `ctx.clip()` from it (`Container._drawChildren`: `ctx.clip.apply(ctx, clipArgs)`).
- **round 13.2 (current)**: clipFunc *returns* `[new Path2D(plan.path)]` — Konva auto-calls `ctx.clip(path2d)`. Nothing is drawn; only the clip is established.)

### 2.1 Transform rules

- I-V1 `strokeAlign === 'INSIDE'` && visible fill && `strokeWeight > 0`:
  - strokeWidth → `strokeWeight * 2`
  - the caller (Canvas.tsx VECTOR branch) wraps `<Path>` in `<Group clipFunc>`. `clipFunc` fills Path2D(`node._path`) under the same `_pathOffset` / `_pathScale` transforms — Konva uses the result as the child clip.
  - `fillAfterStrokeEnabled` stays false (default).
- I-V2 `strokeAlign === 'OUTSIDE'` && visible fill && `strokeWeight > 0`:
  - strokeWidth → `strokeWeight * 2`
  - `fillAfterStrokeEnabled` → true.
  - No clipFunc wrap.
- I-V3 Anything else (CENTER / undefined / no fill / strokeWeight ≤ 0): pass-through — original strokeWidth, both plumbing flags false.
- I-V4 Stroke-only vectors without fill (e.g. 700:319): with no `fill`, INSIDE / OUTSIDE are visually identical to CENTER. Skip emulation — keep the original strokeWidth.

### 2.2 Helper signature

```ts
// web/client/src/lib/strokeAlign.ts (round 13 — corrected)
export interface VectorStrokeAlignProps {
  strokeWidth: number;
  fillAfterStrokeEnabled: boolean;
  clipToPath: boolean;       // INSIDE: caller wraps in a Group clipFunc
}
export function applyStrokeAlignToVectorPath(
  strokeWeight: number | undefined,
  strokeAlign: StrokeAlign,
  hasVisibleFill: boolean,
): VectorStrokeAlignProps;
```

Return rules:
- INSIDE + fill: `{ strokeWidth: w*2, fillAfterStrokeEnabled: false, clipToPath: true }`
- OUTSIDE + fill: `{ strokeWidth: w*2, fillAfterStrokeEnabled: true, clipToPath: false }`
- Otherwise: `{ strokeWidth: w, fillAfterStrokeEnabled: false, clipToPath: false }` — original.

The `hasVisibleFill` check is the caller's responsibility. Generally, `pathFill !== 'transparent'`.

## 3. Scope

- I-3 The VECTOR_TYPES branch of `web/client/src/Canvas.tsx` — set `<Path>`'s `strokeWidth` / `fillAfterStrokeEnabled` from the helper's return.
- I-4 Generic nodes (the background Rect of FRAME/RECTANGLE) keep round 2's `applyStrokeAlign` (rect-coordinate inset) unchanged. No impact from this round.
- I-5 Orthogonal to round 11's `_pathOffset` / round 12's `_pathScale` — they can apply to the same node. The doubled strokeWidth from INSIDE emulation is affected by Konva scale (scale 0.5 halves the stroke too). This is intended — Figma vector nodes also scale stroke proportionally when their size shrinks.

## 4. Invariants — one-liners

| ID | Statement | Verified by |
|---|---|---|
| I-V1 | INSIDE + visible fill → `strokeWidth*2` + `fillAfterStrokeEnabled=true` | unit |
| I-V2 | CENTER / undefined → original strokeWidth, `fillAfterStrokeEnabled=false` | unit |
| I-V3 | OUTSIDE → original strokeWidth (out of scope, 0 regressions) | unit |
| I-V4 | INSIDE + no fill → original strokeWidth (prevents visual regression) | unit |
| I-V4a | strokeWeight 0 or undefined → original 0 / undefined preserved | unit |

## 5. Out of scope

- ❌ OUTSIDE strokeAlign — needs a separate round (OUTSIDE emulation on Konva.Path requires more complex techniques such as stroke-twice + fill mask).
- ❌ Interaction between dashed stroke on a vector node and INSIDE — need to verify whether fillAfterStrokeEnabled also overpaints the gaps between dashes. Will revisit if encountered.
- ❌ INNER_SHADOW / multi-stroke vectors. Not present in meta-rich / HPAI.
- ❌ `strokeAlign` plugin/REST audit comparison — out of scope in `audit-oracle.spec.md`'s COMPARABLE_FIELDS (detectable only; no audit-signal change after the fix).

## 6. References

- `docs/specs/archive/web-render-fidelity-round2.spec.md §I-SA5` — origin of this round
- Konva docs — `Shape#fillAfterStrokeEnabled`
