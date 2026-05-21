# spec/web-render-fidelity-colorvar

| Field | Value |
|---|---|
| Status | Draft |
| Implementation | `web/core/domain/colorStyleRef.ts:resolvePaintColor`, threaded through `color.ts:solidFillCss/solidStrokeCss/strokeFromPaints`, `paintRender.ts:paintToRender/paintLayers`, and `nodeRender.ts:textBaseFillColor/resolveStyledRunFill/planVector/planPaintStack` |
| Tests | `web/core/domain/colorStyleRef.test.ts` (resolvePaintColor block) |
| Siblings | `archive/web-render-fidelity-round15.spec.md` (colorVar **name** resolution for Inspector — different concern: this spec resolves the colorVar's **value** at render time) |

## 1. Goal

When a `paint` carries a `colorVar` alias to a `VARIABLE` node, the renderer must use the variable's **resolved color value**, not the snapshot `paint.color`.

Background:
- Figma writes both `paint.color` and `paint.colorVar` on a bound paint. `paint.color` is a snapshot of the variable's value at write time — typically the master's design-time default (e.g. black for `md-sys-color-on-primary`, since masters are often authored against the light-mode primary).
- The rendered file uses dark / filled Material 3 components (filled buttons, selected date cell on `Docked input date picker`) whose label text is meant to be `on-primary` = white. In Figma those render white; pre-fix we rendered the snapshot black.
- The Inspector already resolved `paint.colorVar` for its **display name** (round 15, "Style: Button/Primary/Default"), but the renderer ignored the binding entirely and read `paint.color`.

## 2. Resolver semantics (`resolvePaintColor(paint, root)`)

Returns an `{r,g,b,a}` color or `undefined`:

- I-R1 `paint` is null / not an object → `undefined`.
- I-R2 `paint.colorVar` is missing OR `root` is missing → return `paint.color` unchanged (no binding to follow).
- I-R3 `paint.colorVar.value.alias.guid` is incomplete → return `paint.color`.
- I-R4 Alias guid resolves to a node whose `type !== 'VARIABLE'` → return `paint.color`.
- I-R5 The alias target is a `VARIABLE`; walk `resolveVariableChain` to a leaf. If the leaf's `entries[0].variableData` has `dataType === 'COLOR'` AND a `value.color`, return that color.
- I-R6 Cycle / dead-end / depth-cap / non-COLOR leaf → return `paint.color` (the snapshot is the safest fallback).
- I-R7 Single-mode only: read `entries[0]` (same limit as `resolveVariableChain` and `colorVarTrail`). Multi-mode (light/dark theme) alternation is out of scope.

## 3. Call-site coverage

Every paint reader that previously read `paint.color` directly now accepts an optional `root` and delegates to `resolvePaintColor`:

- I-S1 `color.ts:solidFillCss(node, root?)` — paint-stack SOLID fills (unused on the canvas paint-stack path which goes through `paintLayers`, but kept for parity callers; Inspector uses the simpler form too).
- I-S2 `color.ts:solidStrokeCss(node, root?)`, `color.ts:strokeFromPaints(node, root?)` — stroke color binding.
- I-S3 `paintRender.ts:paintToRender(paint, w, h, root?)` and `paintLayers(fillPaints, w, h, root?)` — the SOLID branch of the canvas paint-stack rendering (Konva.Rect fill string).
- I-S4 `nodeRender.ts:textBaseFillColor(node, root)` — single-style TEXT fill (the M3 label case).
- I-S5 `nodeRender.ts:resolveStyledRunFill(run, baseFill, root)` — per-run TEXT fill (character-range fills with their own colorVar).
- I-S6 `nodeRender.ts:planVector(node, ctx)` and `planPaintStack(node, ctx)` pass `ctx.documentRoot` through to the helpers above.

Callers without access to `root` keep the snapshot behaviour (pass `undefined`) — no breaking change.

## 4. Out-of-scope

- O-1 Multi-mode VARIABLE resolution (entries\[N\] for different themes). Single-mode covers the reported case.
- O-2 `styleIdForPaint` / library-published style resolution beyond the `colorVar` shape covered by `resolveVariableChain`.
- O-3 Gradient color stop colorVar binding — gradients still use stored `stops[i].color` directly. (Material 3 gradients are uncommon in the reported fixture.)
- O-4 Reverse direction — editing an Inspector color does NOT update the bound VARIABLE; the existing PATCH path writes `paint.color` only.

## 5. Test invariants (asserted in `colorStyleRef.test.ts`)

- T-1 Raw COLOR leaf VARIABLE → returns the variable's color (the on-primary → white case).
- T-2 Alias chain (top → mid → leaf) → walks to the leaf's COLOR.
- T-3 No `colorVar` → returns `paint.color`.
- T-4 Unresolvable guid → returns `paint.color`.
- T-5 VARIABLE has no COLOR entry → returns `paint.color`.
- T-6 Cycle → returns `paint.color` (resolveVariableChain stops; no COLOR at the break point).
- T-7 `paint` itself null/undefined → returns `undefined`.
- T-8 Missing `root` → returns `paint.color`.
