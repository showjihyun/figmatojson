# spec/web-render-fidelity-round11

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/clientNode.ts` (`toClientNode`: vector path offset computation) + `web/client/src/Canvas.tsx` (`<Path>` render point) |
| Tests | `web/core/domain/clientNode.vectorPathOffset.test.ts` |
| Parent | round 10 |
| Sibling | `docs/specs/vector-decode.spec.md` (path-coordinate source of truth) |

## 1. Background (why this round is needed)

The output of `vectorNetworkToPath(vn)` in `vector.ts` is an SVG path serialized directly from vn's vertex coordinates. Those vertex coordinates live in the vector's *path coordinate space* — inside `vectorData.normalizedSize` (`0..normalizedSize.{x,y}`).

The node's `size` is the **bbox including stroke outset**, so `size != normalizedSize` is common (especially for stroked icons):

| Node | size | normalizedSize | diff/2 | strokeWeight/Align |
|---|---|---|---|---|
| 700:319 (Icon inside Frame 2262) | 20×20 | 16×16 | (2, 2) | 2 / CENTER |
| 700:322 | 20×20 | 18×18 | (1, 1) | 2 / CENTER |
| 700:325 | 15.56×20 | 14×18 | (0.78, 1) | 2 / CENTER |

The existing client (rounds 1~10) drew the path with `<Path data={node._path} />` **starting at the top-left (0,0)**. Result: the path occupies only the `normalizedSize` portion of the top-left of the node's `size` region, leaving `(size − normalizedSize)` empty on the right/bottom — the icon appears pushed up/left within the node's region, and the strokeAlign=CENTER stroke-outset compensation is missing.

This round fixes that visual mismatch with one small *domain-level artifact* (`_pathOffset`).

## 2. Scope

- I-1 The invariants apply only to `VECTOR_TYPES` nodes (`VECTOR / STAR / LINE / ELLIPSE / REGULAR_POLYGON / BOOLEAN_OPERATION / ROUNDED_RECTANGLE`) where `vectorData.normalizedSize` is defined. Cases without normalizedSize (simple primitives such as ROUNDED_RECTANGLE) are *out of scope* — keep the existing behavior (`_path` coordinates passed through).
- I-2 A node whose `_path` is missing because vectorNetworkBlob decoding failed is unrelated to this round (there is no path to draw at all). Path-fallback policy is itself out of scope for round 11 (a separate round/spec).

## 3. `_pathOffset` domain artifact

- I-3 In `toClientNode`'s `VECTOR_TYPES` branch, when `data.size` and `data.vectorData.normalizedSize` are both objects and both dimensions (`x` / `y`) are numbers:
  ```
  out._pathOffset = {
    x: (data.size.x - vd.normalizedSize.x) / 2,
    y: (data.size.y - vd.normalizedSize.y) / 2,
  }
  ```
  *Independent* of `_path` decode success — `_pathOffset` can be set even when `_path` is missing (no path to draw means Konva draws nothing, so it is irrelevant).
- I-4 If either size or normalizedSize is missing, or any dimension is non-numeric, do not set `_pathOffset` (leave undefined). Also do not set it when both dimensions are exactly `0` — to reduce field churn and keep the node data of the majority of fill-only vectors (e.g. 700:315) byte-equivalent to round 10.
- I-5 Set `_pathOffset` only when positive. The `dx < 0 || dy < 0` case is delegated to round 12's `_pathScale` branch (parametric primitives — e.g. ELLIPSE 1440:621). The two branches are mutually exclusive — see round 12 spec §I-2/3.

## 4. Canvas render — `<Path>`'s x/y props

- I-6 In `web/client/src/Canvas.tsx`'s VECTOR_TYPES branch, add `x={node._pathOffset?.x ?? 0}` / `y={node._pathOffset?.y ?? 0}` to the inner `<Path>` element. The outer `<Group>`'s existing props (transform.m02 / m12 / rotation / opacity, etc.) are preserved.
- I-7 For a node with undefined `_pathOffset`, `<Path>` still starts at (0, 0) — byte-equivalent to round 10 behavior. Zero regressions.

## 5. Interaction with stroke alignment

- I-8 strokeAlign INSIDE / OUTSIDE compensation (round 2 §2 `applyStrokeAlign`) is a separate path for the background Rect. This round's `_pathOffset` only handles vector paths; the two are *orthogonal* and never applied together.
- I-9 The CENTER outset (Figma default) is not separately compensated in this round. `(size − normalizedSize) / 2` already absorbs the stroke outset observed in the data and centers the path bbox within the node's size (see the table in §1). If more accurate align/outset handling is needed later, it goes into a separate round.

## 6. Invariants — one-liners

| ID | Statement | Verified by |
|---|---|---|
| I-3 | `_pathOffset = (size − normalizedSize) / 2` for vector nodes where both are defined | unit |
| I-4 | size or normalizedSize undefined → `_pathOffset` not set | unit |
| I-6 | Konva `<Path>` receives `_pathOffset.x/y` unchanged | unit (Canvas snapshot) |
| I-7 | Render output of nodes without `_pathOffset` equals round 10 | regression test |

## 7. Error cases

- E-1 `data.size` is not an object (e.g. missing raw field) → do not set `_pathOffset` (I-4).
- E-2 Only one of `vectorData.normalizedSize.{x,y}` defined → compute only the defined dimension and leave the other 0. Simplification: if either is missing, *neither is set* — invariant simplicity wins.
- E-3 NaN / Infinity inputs → follow toClientNode's general raw-spread policy (no special handling). Deeper debugging required when Figma data is malformed.

## 8. Out of scope

- ❌ Exact outset compensation for the stroke outline (different insets for CENTER vs OUTSIDE/INSIDE). Only the simple arithmetic mean is applied.
- ❌ Interaction between vector-node rotation / flip (sign of m00/m11 in the transform) and path inset. We continue to follow round 3's transform decomposition policy.
- ❌ Vector inset inside an INSTANCE's `_renderChildren` (separate verification needed — when the master size differs from the instance size).
- ❌ Non-Konva outputs such as pen-export.ts / html-export.ts — those carry their own responsibility for SVG viewBox / CSS layout.

## 9. References

- `docs/specs/vector-decode.spec.md` — defines the output coordinate space of vectorNetworkToPath (based on `normalizedSize`)
- `docs/specs/archive/web-render-fidelity-round2.spec.md` §2 — strokeAlign compensation (background Rect only)
- `docs/specs/archive/web-render-fidelity-round3.spec.md` — transform decomposition (rotation vs translation-only fallback)
