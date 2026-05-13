/**
 * Color conversion helpers (no IO, no framework).
 *
 * Figma stores colors as `{r, g, b, a}` channels in 0..1. The canvas needs
 * CSS rgba() strings; the inspector needs hex codes for the native
 * <input type="color"> swatch and an editable hex textbox. Same project,
 * three different consumers — extracted here so they share one
 * implementation.
 */

import { resolvePaintColor } from './colorStyleRef.js';

// Channels are all optional because Figma's wire format doesn't always
// populate every component (e.g., non-SOLID paints, library-bound style
// snapshots where r/g/b are derived from a variable, and resolveVariableChain
// returning a leaf with partial entries). The downstream `chan` helper
// defaults missing channels to 0 — matching what the renderer drew before
// the type was tightened. Making this match reality removes the `as never`
// casts at the resolvePaintColor → rgbaToCss handoff.
export interface Rgba01 {
  r?: number;
  g?: number;
  b?: number;
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
 * Resolve the topmost visible SOLID fillPaint to a CSS rgba string, or
 * `transparent` when there's no SOLID fill (gradients, images, missing
 * fills, hidden).
 *
 * Figma stacks paints bottom-up: `fillPaints[0]` is the bottom layer and
 * `fillPaints[N-1]` sits on top. Pre-fix, this picked `fills.find(...)`,
 * which selected the bottom paint and ignored any overlay above it — wrong
 * for multi-paint nodes (e.g. M3 state-layers stacking a translucent
 * overlay on top of a base fill). Now we scan back-to-front so the topmost
 * visible SOLID wins, matching `pickTopPaint` semantics in lib/paint.ts.
 *
 * Caller passes the entire node so the helper can also pick up `opacity`
 * on the paint when present. The optional `root` argument enables
 * `paint.colorVar` alias resolution (Material 3 on-primary etc.) — without
 * it, the snapshot `paint.color` is used unchanged.
 */
export function solidFillCss(
  node: { fillPaints?: unknown },
  root?: unknown,
): string {
  const fills = node?.fillPaints;
  if (!Array.isArray(fills)) return 'transparent';
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = fills[i] as { type?: string; visible?: boolean; color?: Rgba01; opacity?: number } | undefined;
    if (!p || p.visible === false) continue;
    if (p.type !== 'SOLID') continue;
    if (!p.color) continue;
    const op = typeof p.opacity === 'number' ? p.opacity : 1;
    const color = root ? (resolvePaintColor(p, root) ?? p.color) : p.color;
    return rgbaToCss(color, op);
  }
  return 'transparent';
}

/**
 * Topmost visible SOLID stroke as `{ color, width }`, or null when there's
 * no usable stroke. Same back-to-front rule as `solidFillCss`.
 */
export function solidStrokeCss(
  node: { strokeWeight?: unknown; strokePaints?: unknown },
  root?: unknown,
): { color: string; width: number } | null {
  const w = node?.strokeWeight;
  if (typeof w !== 'number' || w <= 0) return null;
  const strokes = node?.strokePaints;
  if (!Array.isArray(strokes)) return null;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const p = strokes[i] as { type?: string; visible?: boolean; color?: Rgba01; opacity?: number } | undefined;
    if (!p || p.visible === false) continue;
    if (p.type !== 'SOLID') continue;
    if (!p.color) continue;
    const op = typeof p.opacity === 'number' ? p.opacity : 1;
    const color = root ? (resolvePaintColor(p, root) ?? p.color) : p.color;
    return { color: rgbaToCss(color, op), width: w };
  }
  return null;
}

/**
 * Topmost visible stroke paint resolved to `{ color, width }`, including
 * gradient → first-stop fallback (Konva can't render gradient strokes
 * natively, but a single representative color preserves the design's
 * dominant tone). Spec round8 §3.
 *
 * Returns null when no usable paint exists (all hidden, IMAGE only).
 * Iterates back-to-front so the topmost visible paint wins (Figma stacks
 * paints bottom-up — `strokePaints[N-1]` is on top).
 */
export function strokeFromPaints(
  node: { strokeWeight?: unknown; strokePaints?: unknown },
  root?: unknown,
): { color: string; width: number } | null {
  const w = node?.strokeWeight;
  if (typeof w !== 'number' || w <= 0) return null;
  const strokes = node?.strokePaints;
  if (!Array.isArray(strokes)) return null;
  const arr = strokes as Array<{
    type?: string;
    visible?: boolean;
    color?: Rgba01;
    opacity?: number;
    stops?: Array<{ color?: Rgba01; position?: number }>;
  }>;
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    if (!p || p.visible === false) continue;
    const op = typeof p.opacity === 'number' ? p.opacity : 1;
    if (p.type === 'SOLID' && p.color) {
      const color = root ? (resolvePaintColor(p, root) ?? p.color) : p.color;
      return { color: rgbaToCss(color, op), width: w };
    }
    if (p.type && p.type.startsWith('GRADIENT_') && Array.isArray(p.stops) && p.stops.length > 0) {
      const c = p.stops[0]?.color;
      if (!c) continue;
      // Use the first stop's color as a fallback. Approximate but
      // never pixel-perfect for true gradient strokes.
      return { color: rgbaToCss(c, op), width: w };
    }
    // IMAGE / unknown — skip.
  }
  return null;
}
