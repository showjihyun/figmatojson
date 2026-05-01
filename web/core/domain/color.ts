/**
 * Color conversion helpers (no IO, no framework).
 *
 * Figma stores colors as `{r, g, b, a}` channels in 0..1. The canvas needs
 * CSS rgba() strings; the inspector needs hex codes for the native
 * <input type="color"> swatch and an editable hex textbox. Same project,
 * three different consumers — extracted here so they share one
 * implementation.
 */

export interface Rgba01 {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** Clamp a 0..1 channel to a 0..255 byte. */
function chan(v: number | undefined): number {
  return Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)));
}

/** "#RRGGBB" — alpha is dropped (handle separately via slider). */
export function rgbaToHex(c?: { r?: number; g?: number; b?: number }): string {
  const h = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${h(chan(c?.r))}${h(chan(c?.g))}${h(chan(c?.b))}`;
}

/** "#rrggbb" or "rrggbb" → {r, g, b} in 0..1. Returns black on parse failure. */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const i = parseInt(m[1]!, 16);
  return {
    r: ((i >> 16) & 0xff) / 255,
    g: ((i >> 8) & 0xff) / 255,
    b: (i & 0xff) / 255,
  };
}

/**
 * Channel-and-alpha → CSS `rgba(r, g, b, a)` string. The canvas paints
 * Konva shapes via this; respects the Figma fill's `opacity` field on
 * top of the channel `a`.
 */
export function rgbaToCss(c?: Rgba01, layerOpacity: number = 1): string {
  const a = (c?.a ?? 1) * layerOpacity;
  return `rgba(${chan(c?.r)},${chan(c?.g)},${chan(c?.b)},${a.toFixed(3)})`;
}

/**
 * Resolve the first SOLID fillPaint to a CSS rgba string, or `transparent`
 * when there's no SOLID fill (gradients, images, missing fills, hidden).
 *
 * Caller passes the entire node so the helper can also pick up `opacity`
 * on the paint when present.
 */
export function solidFillCss(node: { fillPaints?: unknown }): string {
  const fills = node?.fillPaints;
  if (!Array.isArray(fills)) return 'transparent';
  const first = fills.find(
    (p: any) => p?.type === 'SOLID' && p?.visible !== false,
  ) as { color?: Rgba01; opacity?: number } | undefined;
  if (!first?.color) return 'transparent';
  const op = typeof first.opacity === 'number' ? first.opacity : 1;
  return rgbaToCss(first.color, op);
}

/**
 * First SOLID stroke as `{ color, width }`, or null when there's no stroke.
 * Returns null when strokeWeight is 0/missing or no SOLID stroke is present
 * (gradient strokes, image strokes — the canvas can't render them yet).
 */
export function solidStrokeCss(
  node: { strokeWeight?: unknown; strokePaints?: unknown },
): { color: string; width: number } | null {
  const w = node?.strokeWeight;
  if (typeof w !== 'number' || w <= 0) return null;
  const strokes = node?.strokePaints;
  if (!Array.isArray(strokes)) return null;
  const first = strokes.find(
    (p: any) => p?.type === 'SOLID' && p?.visible !== false,
  ) as { color?: Rgba01; opacity?: number } | undefined;
  if (!first?.color) return null;
  const op = typeof first.opacity === 'number' ? first.opacity : 1;
  return { color: rgbaToCss(first.color, op), width: w };
}
