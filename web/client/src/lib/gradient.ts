/**
 * Figma gradient paint → Konva fill props.
 *
 * Spec: docs/specs/web-render-fidelity-round4.spec.md §2
 *
 * Figma defines its gradient in a "unit gradient space" where t goes
 * (0, 0.5) → (1, 0.5) along the centerline. The paint's `transform`
 * is a 2x3 affine that maps this unit space to bbox-normalized
 * coords (0..1 × 0..1). Multiplying by (w, h) yields the pixel coords
 * Konva expects in its `fillLinearGradient*` / `fillRadialGradient*`
 * props.
 *
 * GRADIENT_ANGULAR / GRADIENT_DIAMOND aren't natively supported by
 * Konva — this helper returns null for those, and the caller falls
 * back to a solid first-stop color (spec I-G8).
 */

interface FigmaColor {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}

interface FigmaStop {
  color?: FigmaColor;
  position?: number;
}

interface FigmaTransform2x3 {
  m00?: number;
  m01?: number;
  m02?: number;
  m10?: number;
  m11?: number;
  m12?: number;
}

interface FigmaGradientPaint {
  type?: string;
  visible?: boolean;
  opacity?: number;
  stops?: FigmaStop[];
  transform?: FigmaTransform2x3;
}

export interface KonvaLinearGradient {
  kind: 'linear';
  fillLinearGradientStartPoint: { x: number; y: number };
  fillLinearGradientEndPoint: { x: number; y: number };
  fillLinearGradientColorStops: Array<number | string>;
}

export interface KonvaRadialGradient {
  kind: 'radial';
  fillRadialGradientStartPoint: { x: number; y: number };
  fillRadialGradientEndPoint: { x: number; y: number };
  fillRadialGradientStartRadius: number;
  fillRadialGradientEndRadius: number;
  fillRadialGradientColorStops: Array<number | string>;
}

export type KonvaGradient = KonvaLinearGradient | KonvaRadialGradient;

const IDENTITY: Required<FigmaTransform2x3> = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 0, m12: 0 };
// Note: identity here represents `[[1,0,0],[0,1,0]]` — the second column-vector
// (m01, m11) is (0, 1) for true identity but we let callers' transform fields
// always be present in practice.

function applyTransform(t: FigmaTransform2x3, px: number, py: number): { x: number; y: number } {
  const m00 = t.m00 ?? 1;
  const m01 = t.m01 ?? 0;
  const m02 = t.m02 ?? 0;
  const m10 = t.m10 ?? 0;
  const m11 = t.m11 ?? 1;
  const m12 = t.m12 ?? 0;
  return {
    x: m00 * px + m01 * py + m02,
    y: m10 * px + m11 * py + m12,
  };
}

function chan(v: number | undefined): number {
  return Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)));
}

function rgba(c: FigmaColor | undefined, layerOpacity: number): string {
  const a = ((c?.a ?? 1) * layerOpacity).toFixed(3);
  return `rgba(${chan(c?.r)},${chan(c?.g)},${chan(c?.b)},${a})`;
}

/**
 * Build the flat [pos1, css1, pos2, css2, ...] array Konva expects.
 * Stops are clamped to 0..1 and emitted in input order (Figma stores
 * them sorted; we don't re-sort).
 */
function buildStops(stops: FigmaStop[] | undefined, layerOpacity: number): Array<number | string> {
  const out: Array<number | string> = [];
  if (!Array.isArray(stops)) return out;
  for (const s of stops) {
    const pos = typeof s?.position === 'number' ? Math.max(0, Math.min(1, s.position)) : 0;
    out.push(pos, rgba(s.color, layerOpacity));
  }
  return out;
}

/**
 * Map Figma gradient paint → Konva gradient fill props. Returns null
 * for non-gradient / unsupported / hidden paints.
 */
export function gradientFromPaint(
  paint: FigmaGradientPaint | undefined,
  width: number,
  height: number,
): KonvaGradient | null {
  if (!paint || paint.visible === false) return null;
  const t = paint.transform ?? IDENTITY;
  const layerOpacity = typeof paint.opacity === 'number' ? paint.opacity : 1;

  if (paint.type === 'GRADIENT_LINEAR') {
    const start = applyTransform(t, 0, 0.5);
    const end = applyTransform(t, 1, 0.5);
    return {
      kind: 'linear',
      fillLinearGradientStartPoint: { x: start.x * width, y: start.y * height },
      fillLinearGradientEndPoint: { x: end.x * width, y: end.y * height },
      fillLinearGradientColorStops: buildStops(paint.stops, layerOpacity),
    };
  }

  if (paint.type === 'GRADIENT_RADIAL') {
    const center = applyTransform(t, 0.5, 0.5);
    const edge = applyTransform(t, 1, 0.5);
    const dx = (edge.x - center.x) * width;
    const dy = (edge.y - center.y) * height;
    const radius = Math.sqrt(dx * dx + dy * dy);
    const cx = center.x * width;
    const cy = center.y * height;
    return {
      kind: 'radial',
      fillRadialGradientStartPoint: { x: cx, y: cy },
      fillRadialGradientEndPoint: { x: cx, y: cy },
      fillRadialGradientStartRadius: 0,
      fillRadialGradientEndRadius: radius,
      fillRadialGradientColorStops: buildStops(paint.stops, layerOpacity),
    };
  }

  // GRADIENT_ANGULAR / GRADIENT_DIAMOND or unknown — caller falls back.
  return null;
}

/**
 * First-stop color of any gradient paint, used as the fallback fill
 * when Konva can't render the gradient (angular/diamond). Returns null
 * if the paint has no usable stops.
 */
export function firstStopRgba(paint: FigmaGradientPaint | undefined): string | null {
  if (!paint) return null;
  const layerOpacity = typeof paint.opacity === 'number' ? paint.opacity : 1;
  const stops = paint.stops;
  if (!Array.isArray(stops) || stops.length === 0) return null;
  return rgba(stops[0].color, layerOpacity);
}
