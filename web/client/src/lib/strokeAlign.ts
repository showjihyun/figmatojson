/**
 * strokeAlign INSIDE/OUTSIDE → Konva.Rect dim adjustment.
 *
 * Spec: docs/specs/web-render-fidelity-round2.spec.md §2
 *
 * Konva strokes are always centered (half inside, half outside the rect
 * boundary). To mimic Figma's INSIDE/OUTSIDE we shrink (or expand) the
 * rect by strokeWeight/2 on each side; cornerRadius gets the same offset
 * applied so rounded corners stay flush with the original geometry.
 *
 * Returns dims that the renderer should pass to Konva.Rect when the
 * caller wants INSIDE/OUTSIDE behavior. CENTER (or unknown) is a
 * pass-through identity.
 */

/**
 * Konva.Rect cornerRadius can be either a single number (uniform) or a
 * 4-tuple [tl, tr, br, bl] (asymmetric). Spec round 5 §2 added the
 * array path; this module's strokeAlign offset has to handle both.
 */
export type CornerRadius = number | [number, number, number, number];

export interface RectDims {
  x: number;
  y: number;
  w: number;
  h: number;
  cornerRadius: CornerRadius;
}

export type StrokeAlign = 'INSIDE' | 'OUTSIDE' | 'CENTER' | undefined;

function offsetCornerRadius(r: CornerRadius, delta: number): CornerRadius {
  if (typeof r === 'number') return Math.max(0, r + delta);
  return [
    Math.max(0, r[0] + delta),
    Math.max(0, r[1] + delta),
    Math.max(0, r[2] + delta),
    Math.max(0, r[3] + delta),
  ];
}

/**
 * Apply strokeAlign by adjusting rect geometry. `strokeWeight` is the
 * full stroke thickness. Returns the original dims unchanged when:
 *  - strokeAlign is missing / CENTER
 *  - strokeWeight is 0
 *  - INSIDE shrink would produce non-positive width or height (spec
 *    I-SA2 — fall back to CENTER to avoid rendering a degenerate rect).
 */
export function applyStrokeAlign(
  dims: RectDims,
  strokeWeight: number | undefined,
  strokeAlign: StrokeAlign,
): RectDims {
  if (!strokeWeight || strokeWeight <= 0) return dims;
  if (strokeAlign !== 'INSIDE' && strokeAlign !== 'OUTSIDE') return dims;

  const half = strokeWeight / 2;
  if (strokeAlign === 'INSIDE') {
    const newW = dims.w - strokeWeight;
    const newH = dims.h - strokeWeight;
    if (newW <= 0 || newH <= 0) return dims; // I-SA2
    return {
      x: dims.x + half,
      y: dims.y + half,
      w: newW,
      h: newH,
      cornerRadius: offsetCornerRadius(dims.cornerRadius, -half),
    };
  }
  // OUTSIDE
  return {
    x: dims.x - half,
    y: dims.y - half,
    w: dims.w + strokeWeight,
    h: dims.h + strokeWeight,
    cornerRadius: offsetCornerRadius(dims.cornerRadius, half),
  };
}
