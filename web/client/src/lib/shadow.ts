/**
 * Figma effects[] → Konva shadow props.
 *
 * Spec: docs/specs/web-render-fidelity-round2.spec.md §4
 *
 * Picks the first DROP_SHADOW with `visible !== false` from the effects
 * array (Konva supports a single shadow per shape — multiple drop
 * shadows on the same node fall through to v2). INNER_SHADOW / blur
 * variants are returned as null so the caller skips them entirely.
 */

interface FigmaColor {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}

interface FigmaEffect {
  type?: string;
  visible?: boolean;
  offset?: { x?: number; y?: number };
  radius?: number;
  spread?: number;
  color?: FigmaColor;
  blendMode?: string;
}

export interface KonvaShadow {
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
  shadowColor: string;
  shadowOpacity: number;
}

/**
 * Returns null when no shadow should render (no effects, all hidden,
 * non-DROP_SHADOW only, or non-NORMAL blendMode).
 */
export function shadowFromEffects(
  effects: FigmaEffect[] | undefined,
): KonvaShadow | null {
  if (!Array.isArray(effects) || effects.length === 0) return null;
  for (const e of effects) {
    if (e?.type !== 'DROP_SHADOW') continue;
    if (e.visible === false) continue;
    // I-DS4: Konva paints shadows in NORMAL blend only — skip others
    // rather than render them in the wrong mode.
    if (e.blendMode && e.blendMode !== 'NORMAL') continue;
    const c = e.color ?? {};
    const r = Math.round((c.r ?? 0) * 255);
    const g = Math.round((c.g ?? 0) * 255);
    const b = Math.round((c.b ?? 0) * 255);
    return {
      shadowOffsetX: e.offset?.x ?? 0,
      shadowOffsetY: e.offset?.y ?? 0,
      shadowBlur: e.radius ?? 0,
      // Color is rgb-only; alpha goes through shadowOpacity. Konva
      // multiplies the two — keeping color at full alpha avoids
      // double-discounting (I-DS5 in §7 Resolved questions).
      shadowColor: `rgb(${r}, ${g}, ${b})`,
      shadowOpacity: c.a ?? 1,
    };
  }
  return null;
}
