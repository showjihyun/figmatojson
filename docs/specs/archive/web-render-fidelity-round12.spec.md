# spec/web-render-fidelity-round12

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/clientNode.ts` (`toClientNode`: vector path scale computation) + `web/client/src/Canvas.tsx` (`<Path>` render point) |
| Tests | `web/core/domain/clientNode.vectorPathScale.test.ts` |
| Parent | round 11 |
| Siblings | `docs/specs/vector-decode.spec.md` (path-coordinate source of truth), `docs/specs/archive/web-render-fidelity-round11.spec.md` (path inset) |

## 1. Background

Round 11 applied inset only to the `size >= normalizedSize` case (the node box is *bigger* than the path because of stroke outset). But Figma's *parametric primitives* such as `ELLIPSE` / `STAR` / `REGULAR_POLYGON` carry normalizedSize in path-coordinate units (= the exact bbox of the path) while the node `size` independently carries a *shrunken layout box*.

| Node | size | normalizedSize | diff/2 | Meaning |
|---|---|---|---|---|
| HPAI 1440:621 (risk-map ELLIPSE) | 80×80 | **120×120** | (-20, -20) | path is bigger than the node — needs scaling |

If we apply round 11's simple inset, `_pathOffset = (-20, -20)` would be set and the path's start point would be pushed to negative coordinates outside the node box. Result: the ellipse is drawn over (-20, -20)~(100, 100), which is larger than the node's size region, and it clips or overlaps neighboring nodes. The correct fix is to *scale* the path by the ratio `(size / normalizedSize)`.

## 2. Branch rule (round 11 ↔ round 12)

Two branches based on the sign of `(size − normalizedSize)`:

- I-1 **`dx >= 0 && dy >= 0`**: same as round 11 — `_pathOffset = (dx/2, dy/2)`, `_pathScale` not set. Stroke-outset heuristic.
- I-2 **`dx < 0 || dy < 0`**: round 12 branch — `_pathScale = (size.x/ns.x, size.y/ns.y)`, `_pathOffset` not set. If even a single dimension has the path larger than the node, enter scale mode — both dimensions are scaled.
- I-3 **Both branches are never active simultaneously** — composing the two transforms deforms stroke thickness asymmetrically or misaligns the composition. We branch on a simple OR.

## 3. `_pathScale` domain artifact

- I-4 In `toClientNode`'s `VECTOR_TYPES` branch, when `data.size` and `data.vectorData.normalizedSize` are both objects, both dimensions are numbers, and at least one of size's dimensions is smaller than normalizedSize:
  ```
  out._pathScale = {
    x: data.size.x / vd.normalizedSize.x,
    y: data.size.y / vd.normalizedSize.y,
  }
  ```
- I-5 When `_pathScale` is set, `_pathOffset` is *not* set on the same node (round 11 branch skipped). Guarantees the simple branching of I-3.
- I-6 When `normalizedSize.x === 0` or `normalizedSize.y === 0` (zero divide), `_pathScale` is not set. We assume malformed Figma data.

## 4. Canvas render — `<Path>`'s scaleX/scaleY

- I-7 In `web/client/src/Canvas.tsx`'s VECTOR_TYPES branch, add `scaleX={node._pathScale?.x ?? 1}` / `scaleY={node._pathScale?.y ?? 1}` to the inner `<Path>` element. `x`/`y` continue to come from round 11's `_pathOffset`.
- I-8 For nodes without `_pathScale`, `<Path>`'s scale defaults to 1 — byte-equivalent to round 11 behavior. Zero regressions.

## 5. Interaction with stroke alignment

- I-9 Konva's `<Path>` scales stroke along with the path — so strokeWidth becomes visually thicker or thinner after scaling. This round *assumes* that for cases like 1440:621 the **intended scaling of strokeWidth proportional to the size ratio** matches Figma's actual render. If measurements disagree, we apply `strokeScaleEnabled={false}` in a future round.

## 6. Invariants — one-liners

| ID | Statement | Verified by |
|---|---|---|
| I-1 | size ≥ normalizedSize → round 11 inset | unit |
| I-2 | size < normalizedSize → `_pathScale` set | unit |
| I-3 | `_pathOffset` and `_pathScale` never set simultaneously | unit |
| I-4 | `_pathScale = (sx/nx, sy/ny)` | unit |
| I-6 | If any dimension of normalizedSize is 0, do not set | unit |
| I-7 | Konva `<Path>` receives `scaleX/Y` unchanged | snapshot/unit |
| I-8 | Without `_pathScale`, result equals round 11 | regression test |

## 7. Out of scope

- ❌ Detailed accuracy of asymmetric size deformation (e.g. size.x > ns.x but size.y < ns.y). The current OR branch scales both dimensions if any dimension is smaller. A dedicated round can be opened if asymmetric fixes are needed.
- ❌ Stroke-scale compensation (`strokeScaleEnabled`). A new round if I-9's assumption fails.
- ❌ Interaction between vector-node transform rotation / flip (sign of m00/m11) and path scale. We keep round 3's transform decomposition policy.
- ❌ Vector scale inside an INSTANCE's `_renderChildren` (separate verification needed).

## 8. References

- `docs/specs/archive/web-render-fidelity-round11.spec.md` — path inset (size ≥ normalizedSize)
- `docs/specs/vector-decode.spec.md` — `vectorNetworkToPath` output coordinate space (in terms of `normalizedSize`)
