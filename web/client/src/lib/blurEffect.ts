/**
 * Figma LAYER_BLUR effect → Konva Group cache + Filters.Blur radius.
 *
 * Spec: docs/specs/web-render-fidelity-round9.spec.md §2
 *
 * Returns the blur radius (px) to apply via Konva.Filters.Blur, or
 * null when no LAYER_BLUR effect is active. BACKGROUND_BLUR is
 * deferred — it requires a snapshot of the canvas behind the node
 * which Konva doesn't expose cheaply.
 */

interface FigmaEffect {
  type?: string;
  visible?: boolean;
  radius?: number;
  blendMode?: string;
}

export function layerBlurFromEffects(
  effects: FigmaEffect[] | undefined,
): { radius: number } | null {
  if (!Array.isArray(effects) || effects.length === 0) return null;
  for (const e of effects) {
    if (e?.type !== 'LAYER_BLUR') continue;
    if (e.visible === false) continue;
    // Konva.Filters.Blur paints in NORMAL only — non-NORMAL blends would
    // render incorrectly through the cached bitmap pipeline.
    if (e.blendMode && e.blendMode !== 'NORMAL') continue;
    const r = typeof e.radius === 'number' ? e.radius : 0;
    if (r <= 0) continue;
    return { radius: r };
  }
  return null;
}
