/**
 * Figma blendMode → Konva globalCompositeOperation.
 *
 * Spec: docs/specs/web-render-fidelity-round7.spec.md §3
 *
 * Figma's enum is UPPER_SNAKE; canvas / CSS use kebab-case. The 16
 * named modes from Figma's BlendMode schema all have direct canvas
 * equivalents. NORMAL / PASS_THROUGH / unknown / missing return
 * undefined so the caller spreads the prop and Konva picks its own
 * default (source-over = normal).
 */

const MAP: Record<string, string> = {
  DARKEN:      'darken',
  MULTIPLY:    'multiply',
  COLOR_BURN:  'color-burn',
  LIGHTEN:     'lighten',
  SCREEN:      'screen',
  COLOR_DODGE: 'color-dodge',
  OVERLAY:     'overlay',
  SOFT_LIGHT:  'soft-light',
  HARD_LIGHT:  'hard-light',
  DIFFERENCE:  'difference',
  EXCLUSION:   'exclusion',
  HUE:         'hue',
  SATURATION:  'saturation',
  COLOR:       'color',
  LUMINOSITY:  'luminosity',
};

// Konva accepts the same string set as the canvas globalCompositeOperation
// type — but its TS typing is a string-literal union we don't want to
// import. Cast at the call site via `as KonvaBlendMode` if needed.
export type KonvaBlendMode = 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export function konvaBlendMode(figma: string | undefined): KonvaBlendMode | undefined {
  if (!figma) return undefined;
  if (figma === 'NORMAL' || figma === 'PASS_THROUGH') return undefined;
  return MAP[figma] as KonvaBlendMode | undefined;
}
