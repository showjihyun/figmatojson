/**
 * Figma strokeCap / strokeJoin → Konva lineCap / lineJoin.
 *
 * Spec: docs/specs/web-render-fidelity-round3.spec.md §4
 *
 * Returns undefined for default / unknown values so the caller spreads
 * the prop and Konva picks its own default (butt / miter).
 */

export function konvaLineCap(figma: string | undefined): 'butt' | 'round' | 'square' | undefined {
  switch (figma) {
    case 'ROUND':  return 'round';
    case 'SQUARE': return 'square';
    case 'NONE':   return 'butt';   // explicit Figma value still maps
    // LINE_ARROW / TRIANGLE_ARROW require dedicated geometry — fall through
    // to undefined; the stroke renders with butt caps (Konva default).
    default:       return undefined;
  }
}

export function konvaLineJoin(figma: string | undefined): 'miter' | 'round' | 'bevel' | undefined {
  switch (figma) {
    case 'ROUND': return 'round';
    case 'BEVEL': return 'bevel';
    case 'MITER': return 'miter';
    default:      return undefined;
  }
}
