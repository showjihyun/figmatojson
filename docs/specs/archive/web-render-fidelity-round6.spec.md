# spec/web-render-fidelity-round6

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Canvas.tsx` (default Rect branch restructured) + `web/client/src/lib/paintRender.ts` + `web/client/src/components/canvas/InnerShadowOverlay.tsx` |
| Tests | `web/client/src/lib/paintRender.test.ts`, `web/client/src/components/canvas/InnerShadowOverlay.test.tsx` |
| Parents | rounds 1~5 |

## 1. Purpose

Two universal Figma features — **multi-paint stacking** and **INNER_SHADOW**. Both are fields defined as standard in the .fig data. No file-specific heuristics.

Round 4's multi-paint top-pick was a temporary simplification — only the top paint was shown and the layers beneath were ignored. This round stacks every visible paint in z-order (Figma's real behavior).

INNER_SHADOW is not natively supported by Konva, but it can be emulated with the canvas API's `globalCompositeOperation` and the even-odd fill rule.

## 2. Multi-paint stacking

### 2.1 Data model

`fillPaints` is bottom-up stacked — `[0]` is the bottom, `[N-1]` is the top. Each paint:
- `type`: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND' | 'IMAGE'
- `visible`: boolean
- `opacity`: number 0..1
- `blendMode`: string

### 2.2 Render order

- I-MP1 The default Rect branch draws in this order (z-order, bottom → top):
  1. **Background paints** — every `visible !== false` entry of `fillPaints`, in array order (`[0]` first). One Konva element per paint:
     - SOLID → `<Rect fill={css}>`
     - GRADIENT_LINEAR / RADIAL → `<Rect ...gradientProps>`
     - GRADIENT_ANGULAR / DIAMOND → `<Rect fill={firstStopCss}>` (Konva-unsupported fallback)
     - IMAGE → `<ImageFill src={asset}>`
  2. **Inner shadow** (if present) — a single InnerShadowOverlay.
  3. **Stroke** — when `strokePaints[0]` and `strokeWeight` are present, a dedicated stroke-only `<Rect fill={undefined} stroke={...} dash={...}>`. Dims adjusted by strokeAlign.
  4. **Per-side stroke** lines (if any).
  5. **Children** (child nodes).
- I-MP2 All paint Rects and the stroke Rect share the same cornerRadius (Konva matches round corners).
- I-MP3 strokeAlign INSIDE/OUTSIDE dim adjustments apply only to the stroke Rect; paint Rects use the base dims.

### 2.3 Drop shadow attachment

- I-MP4 DROP_SHADOW is attached to the bottom-most paint Rect — that paint's silhouette is the shadow source. If there are 0 paints, the drop shadow is not rendered (same as Figma — empty frames have no shadow).
- I-MP5 If paint[0] is IMAGE, the ImageFill component draws a Konva.Image, and Konva does not cast a shadow from image-pixel shapes (technical limitation). Workaround: add an extra Rect of the same dims behind ImageFill and attach the shadow there — candidate for a separate round. v1: an image-only fill + drop shadow combination may miss the shadow.

### 2.4 Position of an IMAGE paint

- I-MP6 The ImageFill component applies its own cornerRadius clip (array form added in round 5). It therefore renders correctly at any z-position in the paint stack.
- I-MP7 If an IMAGE paint has visible=false, no ImageFill component is created.

### 2.5 Listening / events

- I-MP8 Paint Rects and the stroke Rect all default to `listening = true` so the Group click dispatch keeps working. Clicks are still handled at the Group (unchanged model).

## 3. INNER_SHADOW

### 3.1 Data model

```ts
effects: Array<{
  type: 'INNER_SHADOW',
  visible: boolean,
  offset: { x, y },
  radius: number,        // blur
  spread?: number,       // unsupported
  color: { r, g, b, a },
  blendMode: string,
}>
```

### 3.2 Konva sceneFunc technique

INNER_SHADOW draws the impression of a shadow falling *inside* the node. We emulate it as follows:

1. Clip to the node bbox path (`ctx.clip()`).
2. Draw an **outer-rect-minus-inner-rect** path with the `evenodd` fill rule, with the shadow* parameters set.
3. The fill paints the outer (bbox-outside) area but is hidden by the clip. Its shadow, however, falls inward into the clip and is visible.

```ts
sceneFunc(ctx) {
  ctx.save();
  drawRoundedPath(ctx, 0, 0, w, h, corners);
  ctx.clip();

  const PAD = Math.max(blur * 3 + max(|sx|, |sy|), 100);
  ctx.beginPath();
  ctx.rect(-PAD, -PAD, w + 2*PAD, h + 2*PAD); // outer (clockwise)
  drawRoundedPathReverse(ctx, 0, 0, w, h, corners); // inner (counter-clockwise)
  ctx.shadowOffsetX = sx;
  ctx.shadowOffsetY = sy;
  ctx.shadowBlur = blur;
  ctx.shadowColor = `rgba(r,g,b,a)`;
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fill('evenodd');

  ctx.restore();
}
```

### 3.3 Invariants

- I-IS1 Use only the first `type === 'INNER_SHADOW' && visible !== false` entry of the effects array (matches Konva's single-shadow limitation).
- I-IS2 If `blendMode` is not NORMAL, skip InnerShadow rendering (Konva cannot composite it accurately — same policy as DROP_SHADOW).
- I-IS3 `spread` unsupported (canvas API limitation).
- I-IS4 cornerRadius array (per-corner) is supported — `drawRoundedPath` accepts 4 corners.
- I-IS5 InnerShadowOverlay has `listening = false` — it does not intercept events.

## 4. Out of scope (v1)

- **Multiple simultaneous INNER_SHADOWs**: single only.
- **INNER_SHADOW spread**: not supported by canvas.
- **LAYER_BLUR / BACKGROUND_BLUR**: requires the canvas filter API. Separate round.
- **Multi-paint blendMode (multiply / screen etc.)**: stacking is not exact when any paint's blendMode is not NORMAL. v1 supports NORMAL only.
- **IMAGE paint + DROP_SHADOW combination**: image-only fill may miss the shadow (I-MP5).
- **Double-compositing of per-paint opacity and layer opacity**: Konva handles this automatically (each Rect's fill alpha × the parent Group's opacity).

## 5. Resolved questions

- **z-order of the stroke within the paint stack**: above every fill paint. The Figma UI keeps stroke and fill in separate sections and has its own strokeAlign, which makes stroke-on-top natural (Konva's single fill+stroke Rect also draws stroke on top).
- **Position of the drop shadow**: on the bottom-most paint Rect. The shadow source is that paint's silhouette — visually identical to the shadow of the whole node silhouette (the paint stack uses the same dims).
- **Does INNER_SHADOW's clip conflict with frameMaskDisabled?**: the two clips live on different Konva elements, so they do not conflict. The ctx.clip() inside InnerShadowOverlay is bounded by its own sceneFunc (ctx.save/restore).
