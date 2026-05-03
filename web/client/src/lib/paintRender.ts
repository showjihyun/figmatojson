/**
 * Resolve a single Figma paint → renderable info for the multi-paint
 * stack. Returns one of:
 *   - { kind: 'solid', fill: 'rgba(...)' } — Konva.Rect fill string
 *   - { kind: 'gradient', ...gradientProps } — Konva gradient props
 *   - { kind: 'image' } — caller renders an ImageFill instead
 *   - null — paint unrenderable (e.g., gradient with no stops, hidden)
 *
 * Spec: docs/specs/web-render-fidelity-round6.spec.md §2.2
 *
 * Each visible paint in fillPaints[] becomes one Konva element in the
 * stack. SOLID and gradient paints become Rects; IMAGE paints become
 * ImageFill. ANGULAR / DIAMOND gradients fall back to first-stop solid
 * (Konva has no native angular/diamond renderer).
 */

import { firstStopRgba, gradientFromPaint, type KonvaGradient } from './gradient';

interface FigmaColor {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}

interface FigmaPaint {
  type?: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
  // gradient fields handled inside gradientFromPaint
}

export interface PaintRenderSolid {
  kind: 'solid';
  fill: string;
}

export interface PaintRenderImage {
  kind: 'image';
}

// PaintRender unifies solid / gradient / image. Gradient kinds reuse
// KonvaGradient's discriminator ('linear' | 'radial') directly.
export type PaintRender = PaintRenderSolid | KonvaGradient | PaintRenderImage;

function chan(v: number | undefined): number {
  return Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)));
}

function rgba(c: FigmaColor | undefined, layerOpacity: number): string {
  const a = ((c?.a ?? 1) * layerOpacity).toFixed(3);
  return `rgba(${chan(c?.r)},${chan(c?.g)},${chan(c?.b)},${a})`;
}

/**
 * Convert one paint to its render descriptor. Returns null when the
 * paint can't render (hidden, malformed, etc.).
 */
export function paintToRender(
  paint: FigmaPaint | undefined,
  width: number,
  height: number,
): PaintRender | null {
  if (!paint || paint.visible === false) return null;
  const layerOpacity = typeof paint.opacity === 'number' ? paint.opacity : 1;

  if (paint.type === 'SOLID') {
    return { kind: 'solid', fill: rgba(paint.color, layerOpacity) };
  }
  if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') {
    const g = gradientFromPaint(paint as Parameters<typeof gradientFromPaint>[0], width, height);
    if (g) return g;
    // Fall through to first-stop fallback if gradient construction failed.
    const fallback = firstStopRgba(paint as Parameters<typeof firstStopRgba>[0]);
    return fallback ? { kind: 'solid', fill: fallback } : null;
  }
  if (paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') {
    const fallback = firstStopRgba(paint as Parameters<typeof firstStopRgba>[0]);
    return fallback ? { kind: 'solid', fill: fallback } : null;
  }
  if (paint.type === 'IMAGE') {
    return { kind: 'image' };
  }
  return null;
}

/**
 * Filter the visible paints from `fillPaints[]` and convert each to its
 * render descriptor in stack order (bottom-up — `fillPaints[0]` first).
 */
export function paintLayers(
  fillPaints: FigmaPaint[] | undefined,
  width: number,
  height: number,
): Array<{ paint: FigmaPaint; render: PaintRender }> {
  if (!Array.isArray(fillPaints)) return [];
  const out: Array<{ paint: FigmaPaint; render: PaintRender }> = [];
  for (const paint of fillPaints) {
    if (!paint || paint.visible === false) continue;
    const render = paintToRender(paint, width, height);
    if (render) out.push({ paint, render });
  }
  return out;
}
