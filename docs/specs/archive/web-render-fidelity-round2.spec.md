# spec/web-render-fidelity-round2

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Canvas.tsx` (TEXT / VECTOR / generic branches) + `web/client/src/lib/strokeAlign.ts`, `web/client/src/lib/shadow.ts` |
| Tests | `web/client/src/lib/strokeAlign.test.ts`, `web/client/src/lib/shadow.test.ts` |
| Parent | `web-render-fidelity-high.spec.md` (previous round — letterSpacing / lineHeight / textAlignVertical / per-side stroke) |

## 1. Purpose

After the previous HIGH round, a fresh file-wide distribution pass on the meta-rich dataset surfaced three large visual gaps that remain — all of them fields already present in the .fig data but ignored by the Canvas:

| Gap | Impact (meta-rich) | Visual difference |
|---|---|---|
| `strokeAlign === 'INSIDE' \| 'OUTSIDE'` | 10,955 / 11,061 visible strokes (99.5%) | Konva defaults to CENTER → every stroke is half inside / half outside the fill area, so fill bleeds inside the stroke at rectangle corners |
| `frameMaskDisabled === false` (clipsContent) | 2,148 FRAME / SYMBOL / INSTANCE | Children spill outside their parent frame |
| `effects[].type === 'DROP_SHADOW'` | 109 nodes | Cards / buttons / modals have no shadow → look flat |

After this round, baseline tonal match against Figma is nearly complete. Smaller differences (rotation 65/35,660 = 0.2%, opacity 16 nodes, gradient 5 nodes, etc.) are deferred to separate rounds.

## 2. strokeAlign

### 2.1 Field shape

```ts
node.strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER'
node.strokeWeight?: number
node.strokePaints?: Paint[]   // visible stroke only when length>0 and paints[0].visible !== false
```

Konva default: strokes are drawn centered on the shape boundary (CENTER). With `strokeWidth=2`, half (1 px) is inside the fill, half (1 px) is outside.

Figma default (`strokeAlign === undefined` or `'CENTER'`): same as Konva.

### 2.2 INSIDE transform

- I-SA1 If `strokeAlign === 'INSIDE'` with a visible stroke:
  - Inset the Rect's position/size by `strokeWeight/2` — `(x + sw/2, y + sw/2, w - sw, h - sw)`.
  - `strokeWidth` is preserved.
  - Result: the stroke's outer edge aligns exactly with the original shape boundary → fill no longer bleeds inside the stroke.
- I-SA2 If `w - strokeWeight <= 0` or `h - strokeWeight <= 0`, ignore strokeAlign and draw as CENTER (avoid negative dimensions).

### 2.3 OUTSIDE transform

- I-SA3 If `strokeAlign === 'OUTSIDE'`:
  - Expand the Rect's position/size by `strokeWeight/2` — `(x - sw/2, y - sw/2, w + sw, h + sw)`.
  - `strokeWidth` is preserved.
  - Result: the stroke's inner edge aligns with the original shape boundary → fill area is not shrunk by the stroke.

### 2.4 Scope

- I-SA4 Applied to the background `Rect` of generic nodes (FRAME / RECTANGLE etc.) — fill + stroke transformed together.
- I-SA5 Not applied to VECTOR `Path` — Konva.Path's strokeAlign corresponds to SVG's non-standard `stroke-alignment`, which lacks browser support. Out of scope for v1.
- I-SA6 Not applied to per-side strokes (the 4 Konva.Line from the previous round) — the meta-rich dataset has no cases combining INSIDE/OUTSIDE with per-side strokes. Will be handled in a separate round if encountered.
- I-SA7 When `cornerRadius > 0`, adjust the inset/expanded cornerRadius the same way — `cornerR - sw/2` for INSIDE (clamp negatives to 0), `cornerR + sw/2` for OUTSIDE.

## 3. Frame clip (clipsContent)

### 3.1 Field shape

```ts
node.frameMaskDisabled?: boolean   // false ⇒ clip enabled (default true ⇒ clip disabled)
```

Figma's "Clip content" toggle serializes as `frameMaskDisabled === false`. The naming is confusing but the data is shaped that way.

### 3.2 Clip behavior

- I-FC1 For a generic node with `frameMaskDisabled === false`, attach a `clipFunc` to its Konva Group:
  - cornerRadius === 0: simple `ctx.rect(0, 0, w, h)` clip.
  - cornerRadius > 0: rounded-rect path. Standard pattern using quadraticCurveTo or arcTo for the 4 corners.
- I-FC2 If `frameMaskDisabled` is undefined or `true`, no clipFunc (default — children may extend outside the frame).
- I-FC3 Not applied to TEXT / VECTOR branches — clipping only makes sense for containers.
- I-FC4 The selection overlay continues to live in a separate Layer so it is not affected by clipping — clipping only affects NodeShape children inside the layer.

## 4. Drop shadow

### 4.1 Field shape

```ts
node.effects?: Array<{
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR'
  visible: boolean
  offset?: { x: number, y: number }
  radius?: number     // blur radius
  spread?: number
  color?: { r: number, g: number, b: number, a: number }
  blendMode?: string
  showShadowBehindNode?: boolean
}>
```

The meta-rich dataset only uses DROP_SHADOW (109 entries; 0 entries for other effect types).

### 4.2 Konva mapping

- I-DS1 Use the first entry in the `effects` array with `type === 'DROP_SHADOW'` and `visible !== false`. If there are more than one, only the first is used in v1 (Konva.Shape supports a single shadow).
- I-DS2 Mapping:
  - `shadowOffsetX = effect.offset.x ?? 0`
  - `shadowOffsetY = effect.offset.y ?? 0`
  - `shadowBlur = effect.radius ?? 0`
  - `shadowColor = rgba(round(r*255), round(g*255), round(b*255), 1)` — alpha is set via a separate prop
  - `shadowOpacity = effect.color.a ?? 1`
- I-DS3 `spread` is not supported by Konva — out of scope for v1. All 109 meta-rich entries have `spread === 0`, so there is no visual difference.
- I-DS4 If `blendMode !== 'NORMAL' && blendMode !== undefined`, the shadow is skipped — Konva's shadow blendMode is always normal, so applying it could render incorrectly. Known limitation — all meta-rich entries are NORMAL, so no impact.
- I-DS5 INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR are out of scope for v1. INNER_SHADOW can be emulated in Konva with stroke + clip but is deferred to a separate round. BLUR requires a filter chain.

### 4.3 Scope

- I-DS6 Applied to generic nodes (the Rect branch) — Konva.Rect accepts shadow props.
- I-DS7 Also applied to the TEXT branch — label text with a shadow may appear in the meta-rich dataset (we did not check the distribution directly, but missing the affordance would be a regression).
- I-DS8 Also applied to the VECTOR Path branch — icon shadows.

## 5. Out of scope (v1)

- INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR.
- Multiple drop shadows on the same node (meta-rich only uses one).
- `spread` on DROP_SHADOW (all meta-rich entries are 0).
- VECTOR Path strokeAlign (browser compatibility).
- Combinations of per-side strokes + INSIDE/OUTSIDE (not present in the data).
- Rotation / skew transforms — 65 nodes (next round).
- opacity ≠ 1 — 16 nodes (next round or layer-level).
- Gradient / image-fill multi-paints — 12 nodes (image fill is partly handled already).
- dashPattern — 16 nodes.
- styleIdForText / fillStyleId / strokeStyleId / effectStyleId — 0 nodes (unused in meta-rich).

## 6. Performance

- I-PE1 The strokeAlign transform is inline arithmetic — no extra nodes or objects.
- I-PE2 clipFunc is a single function prop per frame — Konva invokes it on every draw, but a simple rect path is negligible.
- I-PE3 Shadow uses Konva's native shadow filter — only 109 of 35K nodes apply it, so there is no perf impact.

## 7. Resolved questions

- **Does Konva.Rect draw strokeAlign INSIDE naturally?** No. Konva always draws CENTER. Our transform shrinks Rect dims and also adjusts cornerR to produce a result visually identical to INSIDE. It is emulated, not native like SVG `stroke-alignment`.
- **`frameMaskDisabled` naming — does `true` mean clip is disabled?** Yes, that is how it is serialized. With Figma's "Clip content" toggle ON, `frameMaskDisabled === false`. The name is confusing but we use it as the .fig stores it.
- **Konva's shadowOpacity vs color alpha** — Konva multiplies both `shadowColor`'s alpha and `shadowOpacity` together. To keep this consistent we fix the color's alpha at 1 and use opacity only — the resulting alpha equals the color's a exactly.
