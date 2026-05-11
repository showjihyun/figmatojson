# spec/web-render-fidelity-high

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | TEXT branch + generic node branch in `web/client/src/Canvas.tsx` |
| Tests | `web/client/src/components/canvas/text-style.test.tsx` (new), existing `Canvas.tsx` regression |
| Parent | HIGH items from the Dropdown node audit (Phase W) |

## 1. Goal

Close in one round the HIGH visual gaps surfaced by the meta-rich UI Design `.fig` Dropdown audit. All of them are fields already present in the .fig data that Canvas was failing to read, leaving visuals out of sync with Figma — no additional data conversion required; just passing them as KText / Group props (read-only work).

Affected scope (over the entire meta-rich fixture):
- letterSpacing applied: ~10,000 TEXT nodes (99.7%)
- lineHeight applied: ~8,640 TEXT nodes (86%)
- textAlignVertical CENTER: ~9,551 TEXT nodes (95%)
- textAlignHorizontal CENTER/RIGHT: ~320 TEXT nodes (3%)
- Per-side stroke variation: ~10,574 nodes

After this spec, the rendered screen is broadly closer to Figma — the calendar labels reported earlier (text content restored in a prior PR) also align in spacing, leading, and vertical alignment.

## 2. Field shapes (input data)

All fields live at the node's **top level** (not inside TextData). Figma's kiwi schema serializes them that way.

```ts
// on a TEXT node
letterSpacing?: { value: number, units: 'PIXELS' | 'PERCENT' }
lineHeight?: { value: number, units: 'PIXELS' | 'PERCENT' | 'RAW' }
textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM'
textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'
fontName?: { family: string, style: string, postscript?: string }
fontSize?: number

// on every node (per-side stroke only)
borderTopWeight?: number
borderRightWeight?: number
borderBottomWeight?: number
borderLeftWeight?: number
strokeWeight?: number
strokePaints?: Paint[]
```

## 3. Conversion to Konva props

### 3.1 letterSpacing → `KText.letterSpacing` (px)

- I-LS1 `units === 'PIXELS'` → `KText.letterSpacing = value`.
- I-LS2 `units === 'PERCENT'` → `KText.letterSpacing = (value / 100) * fontSize`. Negatives allowed (Figma defaults to values like -0.5%).
- I-LS3 No letterSpacing object or `value === 0` → omit the prop entirely (Konva default 0).

### 3.2 lineHeight → `KText.lineHeight` (multiplier)

- I-LH1 `units === 'RAW'` → `KText.lineHeight = value` as-is (already a multiplier).
- I-LH2 `units === 'PERCENT'` → `KText.lineHeight = value / 100`.
- I-LH3 `units === 'PIXELS'` → `KText.lineHeight = value / fontSize` (convert to multiplier). If fontSize is 0/undefined, omit the prop.
- I-LH4 If lineHeight object is absent → omit the prop (Konva default 1.0). Figma's baseline reference may differ, so 1.0 is not an exact match but the safest fallback.

### 3.3 textAlignVertical → `KText.verticalAlign`

- I-AV1 `'TOP'` → `'top'` (or omit; Konva default).
- I-AV2 `'CENTER'` → `'middle'`.
- I-AV3 `'BOTTOM'` → `'bottom'`.
- I-AV4 Unknown → omit (safe fallback).
- I-AV5 Meaningful only when KText's `height` prop is set — a Figma TEXT node always has size.y so the condition is met.

### 3.4 textAlignHorizontal → `KText.align`

- I-AH1 `'LEFT'` → `'left'` (or omit).
- I-AH2 `'CENTER'` → `'center'`.
- I-AH3 `'RIGHT'` → `'right'`.
- I-AH4 `'JUSTIFIED'` → `'justify'`. Konva's justify does not match Figma exactly but is the nearest mapping.
- I-AH5 Unknown / undefined → omit.

### 3.5 fontName.style → `KText.fontStyle`

- I-FS1 Normalize fontName.style: lowercase + strip whitespace/hyphens.
  - Includes `'Bold'` / `'700'` → `'bold'`
  - Includes `'Italic'` → `'italic'`
  - Both → `'italic bold'` (Konva-accepted format)
- I-FS2 Otherwise (Regular, Medium, SemiBold, etc.) → omit (Konva default normal).
- I-FS3 v1 limitation — Konva.Text does not directly accept numeric font weight. Medium (500) / SemiBold (600) fall back to normal unless Bold. The browser picks the nearest weight available in the family (visual difference is minor for full families like Pretendard).

### 3.6 Per-side stroke

- I-PS1 If all four `border{Top,Right,Bottom,Left}Weight` are *identical* on the node, keep the existing single `Rect`'s `strokeWidth = strokeWeight` — no extra work.
- I-PS2 If *any side differs* (or any side is absent vs. `strokeWeight`), switch to per-side mode:
  - Disable `Rect`'s `stroke` prop (`undefined` or `'transparent'`).
  - Add 4 `Konva.Line`s (use `strokePaints[0]`'s color).
    - top: `(0, 0) → (w, 0)`, weight = `borderTopWeight ?? 0`
    - right: `(w, 0) → (w, h)`, weight = `borderRightWeight ?? 0`
    - bottom: `(0, h) → (w, h)`, weight = `borderBottomWeight ?? 0`
    - left: `(0, 0) → (0, h)`, weight = `borderLeftWeight ?? 0`
  - Omit Line entirely on sides with weight === 0 (avoid unnecessary Konva nodes).
- I-PS3 If `strokePaints` is empty (`length === 0` or undefined) → skip every stroke operation; do not draw per-side either.
- I-PS4 strokeAlign (CENTER/INSIDE/OUTSIDE) is out of scope for v1 — both single strokeWeight and per-side use Konva's default (centered). Figma's INSIDE looks slightly different but the gap is 1-2px.

## 4. Implementation guard rails

- I-IM1 Change scope = TEXT render branch + generic node (Group + Rect) branch in `Canvas.tsx`. No other file / no data-layer change.
- I-IM2 NodeShape stays memoized — the new props all derive from parts of `node` props, so the existing memoization remains valid.
- I-IM3 Place the 4 per-side stroke Lines inside the Group to inherit parent transform directly. No separate coordinate math needed.
- I-IM4 letterSpacing/lineHeight conversion helpers are inline (not reused elsewhere). One-liners — no extraction needed.

## 5. Render-side performance

- I-PE1 letterSpacing/lineHeight/align are all single KText props — 0 additional Konva nodes.
- I-PE2 Per-side stroke adds up to 4 Lines per differing node. ~10,500 nodes × ~2 Lines average → ~21K additional Lines over the 35K-node sample = ~6% node growth. After measurement, if regressions appear, reinforce with culling (`cullChildrenByViewport` already exists).

## 6. Out of scope

- **Auto-layout reflow** — Figma bakes stack-computed positions into children's `transform.m02/m12` on save (verified on the meta-rich Button frame). No visual difference on the read path. Reflow during editing belongs to a separate round.
- **textCase / textDecoration / textDecorationSkipInk** — out of scope. Konva.Text does not natively support these; workarounds (preprocessing text transformations / drawing underline as a separate Line) are required.
- **fontVariations / fontVariantCommonLigatures / fontVariantContextualLigatures** — variable fonts / ligatures. With static families like Pretendard the visual difference is negligible.
- **strokeAlign / strokeCap / strokeJoin / dashPattern** — Konva supports them, but default values dominate in meta-rich. Open a separate round when divergent cases are observed.
- **effects (drop shadow / blur)** — separate round.
- **gradient / image fills** — separate round.
- **styleIdForText / fillStyleId / strokeStyleId** — design token references — separate spec.

## 7. Resolved questions

- **Whether to allow negative letterSpacing** — Figma uses -0.5% as the default typesetting for Korean text (meta-rich 99.7%). Konva also accepts negative letterSpacing → pass through as-is.
- **lineHeight RAW vs Konva multiplier** — Konva.Text's lineHeight is a multiplier over fontSize (e.g. 1.42 → 1.42 × fontSize line spacing). Figma RAW is also a multiplier → can pass through directly. Only PIXELS divides by fontSize for conversion.
- **fontStyle weight mapping limitation** — Konva does not accept numeric weights (300/400/500/700). Only 'normal' / 'bold'. We send Pretendard family's Medium/SemiBold as normal and let the browser pick the nearest weight via family fallback. If numeric-weight passthrough is needed later, fall back to a raw `<text>` SVG instead of KText.
