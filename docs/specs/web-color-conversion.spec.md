# spec/web-color-conversion

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/color.ts` |
| Tests | `web/core/domain/color.test.ts` (currently only `strokeFromPaints` — unit tests for other exports recommended after this spec lands) |
| Siblings | `web-render-fidelity-round8.spec.md §3` (source of gradient stroke fallback), `audit-oracle.spec.md §I-A5` (paint length comparison policy) |

## 1. Goal

Figma's paint data carries `{r, g, b, a}` channels in the 0..1 range. Three
different consumers in our project need the same paint in different shapes:

- Canvas (Konva): CSS `rgba(r,g,b,a)` string.
- Inspector: `<input type="color">` swatch + user-edited hex textbox.
- AI tool dispatcher / mutation tools: convert user-entered hex back into
  0..1 channels for the wire.

This spec is the single source for those helpers' *input/output contracts,
opacity composition rules, and paint-array fallback policy*. All helpers are
pure functions — no IO / no framework dependencies.

## 2. Data shapes

```ts
interface Rgba01 {
  r: number;        // 0..1
  g: number;        // 0..1
  b: number;        // 0..1
  a?: number;       // 0..1 (default 1)
}
```

- I-D1 Channel values are stored on the *continuous* 0..1 range. The wire
  format is identical.
- I-D2 `a` is *channel alpha* — a different layer from Figma's paint-level
  `opacity` field. Composition rule: see §4.
- I-D3 Out-of-range values (negative / >1) are *clamped* to 0..255 during the
  channel→byte conversion — invalid wire never leaks NaN / >255 bytes.

## 3. Output contracts of the conversion helpers

### 3.1 `rgbaToHex(c)` — channel → "#RRGGBB"

- I-H1 Input: `{ r?, g?, b? }` (lone channels or `Rgba01`). Undefined
  channels are treated as 0.
- I-H2 Output: `"#RRGGBB"` form. 6-digit hex, lowercase. **alpha is dropped**
  — the hex swatch does not carry channel alpha (slider handles it
  separately).
- I-H3 Determinism: identical input → identical output (rounding: `Math.round`
  — no banker's rounding).

### 3.2 `hexToRgb01(hex)` — "#rrggbb" → channel 0..1

- I-H4 Input: `"#rrggbb"` or `"rrggbb"` (`#` optional). Case-insensitive.
- I-H5 Output: `{ r, g, b }` in the 0..1 range. **alpha is not emitted** —
  the caller injects it via a separate channel if needed.
- I-H6 Parse failure (wrong length / non-hex character) → `{ r: 0, g: 0, b: 0 }`.
  Does not throw — the UI's hex textbox cannot break during partial typing.

### 3.3 `rgbaToCss(c, layerOpacity = 1)` — channel + opacity → CSS rgba()

- I-H7 Input: `Rgba01` (optional) + `layerOpacity` (default 1).
- I-H8 Output: `"rgba(R,G,B,A)"` string — R/G/B as 0..255 integers, A to 3
  decimal places (`a.toFixed(3)`).
- I-H9 Alpha composition: `A = (c.a ?? 1) * layerOpacity` — channel alpha and
  layer opacity *multiply*. Matches Figma's paint-level opacity semantics.

### 3.4 `solidFillCss(node)` — first visible SOLID fill → CSS

- I-H10 Input: `{ fillPaints?: unknown }` (whole node or a paint container).
- I-H11 Output: `rgbaToCss(color, paint.opacity ?? 1)` of the first *visible*
  `SOLID` paint. No match → `"transparent"` (gradient / image / hidden /
  absent all included).
- I-H12 Visible check: `paint.visible !== false` (undefined → visible).
- I-H13 Opacity composition: only the paint's opacity is applied — node-level
  layer opacity is the caller's responsibility (passed separately as Konva's
  `opacity` prop).

### 3.5 `solidStrokeCss(node)` — first visible SOLID stroke → `{color, width}`

- I-H14 Input: `{ strokeWeight?: unknown, strokePaints?: unknown }`.
- I-H15 Output: `{ color: string, width: number }` or `null`.
- I-H16 Returns null when: `strokeWeight` is not a number or ≤ 0;
  `strokePaints` is not an array; no visible SOLID paint.

### 3.6 `strokeFromPaints(node)` — gradient/image-aware stroke resolver

A *superset* of `solidStrokeCss` — also handles gradient strokes. Konva
does not natively support gradient stroke, so we fall back to the *first
stop color* (source of round-8 §3 I-SG1).

- I-H17 Input / output shape identical to `solidStrokeCss`.
- I-H18 Paint walk rule (visible only, first match wins):
  - `SOLID` + has `color` → `rgbaToCss(color, paint.opacity ?? 1)`.
  - `GRADIENT_*` (`LINEAR/RADIAL/ANGULAR/DIAMOND`) + has `stops[0].color` →
    `rgbaToCss(stops[0].color, paint.opacity ?? 1)` — *approximation*, not
    pixel-perfect.
  - `IMAGE` / others / hidden → skip, try the next paint.
- I-H19 If every paint is unusable → `null`.
- I-H20 Choice between `solidStrokeCss` vs `strokeFromPaints` = *whether to
  allow gradient fallback*. The caller decides explicitly
  (`solidStrokeCss` is the strict SOLID-only version, `strokeFromPaints` is
  the lenient version on top, post round-8).

## 4. Opacity composition layer table

The same paint's alpha is multiplied across multiple layers. This spec
specifies *which layers* the helper composes.

| Layer | Source | Composed by helper? |
|---|---|---|
| **channel alpha** (`color.a`) | `c.a` in `rgbaToCss(c, _)` | ✅ (rgbaToCss / solidFillCss / strokeFromPaints) |
| **paint opacity** (`paint.opacity`) | per-paint `opacity` field | ✅ (solidFillCss / solidStrokeCss / strokeFromPaints) |
| **node opacity** (`node.opacity`) | DocumentNode-level layer opacity | ❌ — passed *separately* via Konva's `opacity` prop |
| **parent INSTANCE opacity** | render-overrides §3.6 visualStyleOverride | ❌ — clientNode pipeline patches it into `node.opacity`, then handled the same as above |

- I-O1 Of the 4 layers, **only the top 2** are composed by color helpers —
  node-level opacity is kept on the Konva side to prevent the *paint string
  multiplying alpha twice* bug.
- I-O2 The `layerOpacity` argument of `rgbaToCss(c, layerOpacity)` is the
  *paint-level* opacity. Never pass node-level opacity here (re-verified
  against round-8's fillPaints code path).

## 5. Error policy

- I-E1 Every helper *never throws*. Parse failure / type mismatch /
  out-of-range input falls back to a *safe default*.
  - `rgbaToHex({}) → "#000000"`
  - `hexToRgb01("not-hex") → { r:0, g:0, b:0 }`
  - `rgbaToCss(undefined) → "rgba(0,0,0,1.000)"`
  - `solidFillCss({}) → "transparent"`
  - `solidStrokeCss({}) → null`
- I-E2 Distinction between `null` and `"transparent"`: stroke returns `null`
  (don't draw the stroke at all when the optional field is missing); fill
  returns `"transparent"` (Konva's fill prop only accepts strings, so a
  fallback is needed).
- I-E3 Out-of-range channel input (negative / >1) is clamped at the byte
  stage — the result is 0 or 255, no throw. If a mutation tool regresses by
  writing bad values to the wire, validation belongs at a *higher layer*
  (not the helper's responsibility).

## 6. Out of scope

- ❌ **Gradient render** — converting stops + transform to Konva's
  `<linearGradient>` is a separate spec
  (`web/client/src/lib/gradient.ts` owns it; this spec covers only the
  *fallback single color*).
- ❌ **Image fill / image stroke** — `IMAGE` paints are skipped by this
  helper. Actual image handling lives in `web/client/src/lib/imageScale.ts` +
  `web-render-fidelity-round*`.
- ❌ **HSL / HSV / OKLCH and other color spaces** — Figma's wire is always
  sRGB rgba01. Other spaces are out of scope.
- ❌ **Wide-gamut display-p3** — wire is assumed 0..1 sRGB. P3 / DCI-P3 /
  Rec.2020 are not supported on our side.
- ❌ **Figma variable alias resolution** — even when a paint carries
  `colorVar.value.alias`, the helper reads only the *literal `color`* (same
  policy as `web-instance-render-overrides §6 out-of-scope`). The literal
  is always stamped alongside, so there is no visual loss.

## 7. Resolved questions

- **Why does `rgbaToCss` truncate alpha via `toFixed(3)`?** Sub-pixel alpha
  differences are not visible through Konva's CSS rgba(). 3 digits give
  1001 levels on `0.000`-`1.000` — compatible with the 256 levels of the
  0..255 channel byte and reasonable noise. Unlike the NaN-equality rule in
  `audit-roundtrip-canvas-diff.mjs`, alpha only needs *determinism* so
  truncation suffices.
- **Why does `solidFillCss` compose paint-level opacity only, not node
  opacity?** Konva's `Konva.Rect({ fill, opacity })` already multiplies the
  two layers when rendering. If the helper pre-multiplied, Konva would
  multiply again — *squared*. Left undocumented, this trap would be entered
  a second time during round-8 debugging.
- **Why is `strokeFromPaints` a first-stop fallback?** Design decision in
  round-8 §3 I-SG1. Preserving the dominant tone of a gradient stroke is
  closer to the user's visual impression than either an empty stroke or a
  pixel-perfect simulation — validated by Figma audit.
