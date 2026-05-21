# spec/web-render-fidelity-round8

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Canvas.tsx` ImageFill + the stroke section of the generic branch + `web/client/src/lib/imageScale.ts` |
| Tests | `web/client/src/lib/imageScale.test.ts` |
| Parents | rounds 1~7 |

## 1. Purpose

Two universal Figma features — **IMAGE scaleMode** (FILL/FIT/CROP/STRETCH/TILE) and **stroke gradient fallback**. Both are standard Figma fields. No file-specific heuristics.

In previous rounds every IMAGE paint was simply stretched to the box size — when the photo aspect differed from the box, it appeared distorted. Figma defaults to FILL (object-fit: cover), so this is a large visible gap. In the meta-rich dataset, 86 of 86 image fills are FILL and 5 are STRETCH.

Stroke gradient is absent from meta-rich but is a universal Figma feature. Konva's stroke prop accepts only a single color — a gradient stroke needs a dedicated path geometry, so v1 falls back to the first-stop solid.

## 2. IMAGE scaleMode

### 2.1 Field shape

```ts
paint: {
  type: 'IMAGE',
  visible: boolean,
  imageScaleMode: 'FILL' | 'FIT' | 'CROP' | 'STRETCH' | 'TILE',
  rotation?: number,
  scalingFactor?: number,    // TILE scale
  image: { hash: ... },
  filters?: { ... },          // brightness/contrast/saturation etc. — out of scope for v1
}
```

### 2.2 Computing the Konva crop

Konva.Image's `crop` prop = `{x, y, width, height}` — which portion of the source image to use. The width/height props = the destination box. Combine the two to emulate object-fit.

`computeImageCrop(scaleMode, imgW, imgH, boxW, boxH)` returns:
```ts
{
  crop?: { x, y, width, height },   // Konva.Image crop prop
  dstX: number, dstY: number,        // image's x/y inside the box
  dstW: number, dstH: number,        // image's width/height
  tile: boolean,                     // TILE → caller falls back / skips
}
```

### 2.3 FILL (= object-fit: cover)

- I-IS1 Preserve aspect, fill the box. Wider-than-box image → sides cropped. Narrower → top/bottom cropped.
- Algorithm:
  ```
  imgAspect = imgW / imgH
  boxAspect = boxW / boxH
  if imgAspect > boxAspect:
    // image wider — crop sides
    cropH = imgH
    cropW = imgH * boxAspect
    cropX = (imgW - cropW) / 2
    cropY = 0
  else:
    // image taller — crop top/bottom
    cropW = imgW
    cropH = imgW / boxAspect
    cropX = 0
    cropY = (imgH - cropH) / 2
  ```
- dst = (0, 0, boxW, boxH) — Konva fits the cropped portion into the dst region.

### 2.4 FIT (= object-fit: contain)

- I-IS2 Preserve aspect, fit inside the box. Letterboxed empty space along the edges.
- crop = the full image (`{x:0, y:0, width: imgW, height: imgH}`).
- dst = the largest rectangle that fits inside the box — wider image → reduce height, narrower → reduce width. Centered.

### 2.5 CROP

- I-IS3 1:1 scale (no resize), centered, anything outside the box is clipped.
- crop = a centered region the size of the box.
- dst = (0, 0, boxW, boxH).
- If the image is smaller than the box → letterboxed (edges transparent or bordered).

### 2.6 STRETCH (= current behavior)

- I-IS4 Ignore aspect. crop = full image. dst = (0, 0, boxW, boxH). Konva's `width / height` props are sufficient — no crop needed.

### 2.7 TILE

- I-IS5 Out of scope for v1. The caller falls back to STRETCH so the image still shows. Implementing it via Konva pattern fill would require a separate `Konva.Image` + `fillPatternImage` setup — complexity is too high, deferred.

### 2.8 Other paint fields besides imageScaleMode

- I-IS6 `paint.rotation` rotation: out of scope for v1. Non-zero values would need wrapping in a Konva Group to rotate the crop region. All meta-rich entries are 0.
- I-IS7 `paint.filters` (brightness/contrast/saturation/hue/temperature/tint): needs canvas filters. Out of scope for v1.

## 3. Stroke gradient fallback

### 3.1 Background

When `strokePaints[0]` is a GRADIENT_* type, Konva.Rect / Path's stroke prop accepts only a single color. Drawing a real gradient stroke would require building a path geometry that covers the stroke area and filling it with a gradient — high complexity.

### 3.2 Fallback rule

- I-SG1 When the stroke paint is GRADIENT_LINEAR / RADIAL / ANGULAR / DIAMOND, use `firstStopRgba(paint)` as the stroke color. A single stop typically represents the dominant color of the design, so the visual difference is minimal.
- I-SG2 IMAGE stroke paint is unsupported in v1 — stroke is not drawn.
- I-SG3 SOLID continues on the existing path.

### 3.3 Implementation

The existing `strokeOf(node) = solidStrokeCss(node)` only handles SOLID. A new helper `strokeFromPaints(node)` handles SOLID + GRADIENT. Replace the `strokeOf` call in Canvas.tsx with `strokeFromPaints`.

## 4. Out of scope (v1)

- TILE imageScaleMode (requires Konva pattern)
- IMAGE paint rotation
- IMAGE paint filters (brightness/contrast/...)
- True gradient stroke (requires path geometry)
- IMAGE stroke paint

## 5. Resolved questions

- **Visual difference between FILL and FIT**: FILL = cover (clips), FIT = contain (letterbox). Figma defaults to FILL. All 86 meta-rich entries are FILL.
- **Difference between CROP and FILL**: CROP is 1:1 scale (keeps the image's original size), FILL scales up/down to fit the box while preserving aspect. CROP is the more specific case.
- **Behavior of Konva.Image's crop prop**: draws the (x, y, width, height) region of the source image into (dstX, dstY, dstW, dstH) — same as `ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)`.
