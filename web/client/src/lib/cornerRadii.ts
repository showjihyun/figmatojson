/**
 * Resolve Figma per-corner radii → Konva.Rect cornerRadius prop.
 *
 * Spec: docs/specs/web-render-fidelity-round5.spec.md §2
 *
 * Konva.Rect accepts cornerRadius as either a number (uniform) or a
 * 4-tuple [tl, tr, br, bl] (clockwise from top-left). We pick uniform
 * when all four corners share the same value to keep the prop minimal.
 */

interface CornerSource {
  rectangleTopLeftCornerRadius?: number;
  rectangleTopRightCornerRadius?: number;
  rectangleBottomRightCornerRadius?: number;
  rectangleBottomLeftCornerRadius?: number;
}

/**
 * Returns either a single radius (uniform) or the [tl, tr, br, bl]
 * array Konva expects when corners differ. `defaultR` is the uniform
 * `node.cornerRadius` we'd otherwise use; it fills any missing per-
 * corner field so the array is always complete.
 */
export function cornerRadiusForKonva(
  node: CornerSource,
  defaultR: number,
): number | [number, number, number, number] {
  const tl = node.rectangleTopLeftCornerRadius;
  const tr = node.rectangleTopRightCornerRadius;
  const br = node.rectangleBottomRightCornerRadius;
  const bl = node.rectangleBottomLeftCornerRadius;

  // Nothing per-corner specified → uniform default (could be 0 or rounded).
  if (tl == null && tr == null && br == null && bl == null) return defaultR;

  const tlR = tl ?? defaultR;
  const trR = tr ?? defaultR;
  const brR = br ?? defaultR;
  const blR = bl ?? defaultR;

  // All equal → still uniform; emit number for cleaner Konva tree.
  if (tlR === trR && trR === brR && brR === blR) return tlR;

  return [tlR, trR, brR, blR];
}
