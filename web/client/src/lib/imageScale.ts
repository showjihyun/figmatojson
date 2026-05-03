/**
 * Figma IMAGE paint scaleMode → Konva.Image crop / dst rect.
 *
 * Spec: docs/specs/web-render-fidelity-round8.spec.md §2
 *
 * Konva.Image accepts a `crop` prop ({x, y, width, height}) that
 * specifies which part of the source image to use, plus regular
 * x/y/width/height for the destination box. Combining the two lets
 * us emulate every CSS object-fit mode without DOM tricks.
 *
 * - FILL    = object-fit: cover (preserve aspect, crop to fill box)
 * - FIT     = object-fit: contain (preserve aspect, letterbox the gaps)
 * - CROP    = no scaling, centered, source clipped to box
 * - STRETCH = ignore aspect (current default behavior)
 * - TILE    = pattern repeat — v1 returns `tile: true`; caller falls
 *             back to STRETCH or skips
 */

export type ImageScaleMode = 'FILL' | 'FIT' | 'CROP' | 'STRETCH' | 'TILE';

export interface ImageRender {
  /** Konva.Image crop prop. omit for STRETCH (full image). */
  crop?: { x: number; y: number; width: number; height: number };
  /** Destination position inside the parent (relative to the box origin). */
  dstX: number;
  dstY: number;
  /** Destination size. May be smaller than the box for FIT (letterbox). */
  dstW: number;
  dstH: number;
  /** TILE marker — caller should pattern-fill instead of using this rect. */
  tile: boolean;
}

/**
 * Returns the crop + dst geometry for one IMAGE paint inside a node
 * box. Returns a 'STRETCH-equivalent' result when imgW/imgH is 0 or
 * unknown so the renderer doesn't crash on a still-loading image.
 */
export function computeImageCrop(
  scaleMode: ImageScaleMode | string | undefined,
  imgW: number,
  imgH: number,
  boxW: number,
  boxH: number,
): ImageRender {
  // Defensive: missing image dims fall back to STRETCH.
  if (!imgW || !imgH || !boxW || !boxH) {
    return { dstX: 0, dstY: 0, dstW: boxW, dstH: boxH, tile: false };
  }

  if (scaleMode === 'TILE') {
    return { dstX: 0, dstY: 0, dstW: boxW, dstH: boxH, tile: true };
  }

  if (scaleMode === 'STRETCH' || scaleMode === undefined) {
    // Current behavior — full image stretched to fill box.
    return { dstX: 0, dstY: 0, dstW: boxW, dstH: boxH, tile: false };
  }

  if (scaleMode === 'CROP') {
    // 1:1 scale, centered. crop = box-sized rect at image center.
    const cropW = Math.min(boxW, imgW);
    const cropH = Math.min(boxH, imgH);
    return {
      crop: {
        x: (imgW - cropW) / 2,
        y: (imgH - cropH) / 2,
        width: cropW,
        height: cropH,
      },
      // Center the dst rect inside the box (letterbox if image smaller).
      dstX: (boxW - cropW) / 2,
      dstY: (boxH - cropH) / 2,
      dstW: cropW,
      dstH: cropH,
      tile: false,
    };
  }

  const imgAspect = imgW / imgH;
  const boxAspect = boxW / boxH;

  if (scaleMode === 'FILL') {
    // object-fit: cover. Preserve aspect, crop the long axis.
    if (imgAspect > boxAspect) {
      // Image is wider than box → crop sides.
      const cropW = imgH * boxAspect;
      return {
        crop: {
          x: (imgW - cropW) / 2,
          y: 0,
          width: cropW,
          height: imgH,
        },
        dstX: 0,
        dstY: 0,
        dstW: boxW,
        dstH: boxH,
        tile: false,
      };
    }
    // Image taller than box → crop top/bottom.
    const cropH = imgW / boxAspect;
    return {
      crop: {
        x: 0,
        y: (imgH - cropH) / 2,
        width: imgW,
        height: cropH,
      },
      dstX: 0,
      dstY: 0,
      dstW: boxW,
      dstH: boxH,
      tile: false,
    };
  }

  if (scaleMode === 'FIT') {
    // object-fit: contain. Preserve aspect, fit within box, letterbox.
    if (imgAspect > boxAspect) {
      // Image is wider → height shrinks.
      const dstH = boxW / imgAspect;
      return {
        // crop = full image; dst is centered with vertical letterbox.
        crop: { x: 0, y: 0, width: imgW, height: imgH },
        dstX: 0,
        dstY: (boxH - dstH) / 2,
        dstW: boxW,
        dstH,
        tile: false,
      };
    }
    // Image is taller → width shrinks.
    const dstW = boxH * imgAspect;
    return {
      crop: { x: 0, y: 0, width: imgW, height: imgH },
      dstX: (boxW - dstW) / 2,
      dstY: 0,
      dstW,
      dstH: boxH,
      tile: false,
    };
  }

  // Unknown mode — same fallback as STRETCH so we don't drop the image.
  return { dstX: 0, dstY: 0, dstW: boxW, dstH: boxH, tile: false };
}
